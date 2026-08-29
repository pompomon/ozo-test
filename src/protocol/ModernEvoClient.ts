import {
  TransportQueueCancelledError,
  type EvoTransport,
  type TransportWriteOptions,
} from '../transport/EvoTransport.ts'
import {
  MEMORY_RESPONSE_SYNC_TIMEOUT_MS,
  REACTIVE_BUTTON_RESPONSE_TIMEOUT_MS,
  REACTIVE_SENSOR_RESPONSE_TIMEOUT_MS,
  REACTIVE_SENSOR_SOFT_TIMEOUT_MS,
} from '../controller/constants.ts'
import {
  assertCallSucceeded,
  decodeAudioExecutionState,
  decodeMemReadResponse,
  encodeMemRead,
  encodePlayTone,
  encodeSetLed,
  encodeStopExecution,
  encodeVelocity,
  EXECUTION_STATE,
  executionStateName,
  MODERN_MESSAGE,
  readMessageId,
  readRequestId,
} from './modernCodec.ts'
import {
  MEMORY_REGION,
  parseBattery,
  parseButton,
  parseCharger,
  parseColorCode,
  parseColorSensor,
  parseEncoders,
  parseFirmware,
  parseIrMessage,
  parseLineColor,
  parseLineSensors,
  parsePickup,
  parsePosition,
  parseProcessedColor,
  parseProximity,
  parseSurface,
  parseSurfaceColor,
  type EvoTelemetry,
  type ReactiveSafetySensors,
  type ReactiveSensors,
} from './telemetry.ts'

interface PendingRequest {
  readonly resolve: (packet: Uint8Array) => void
  readonly reject: (error: Error) => void
  readonly accept?: (packet: Uint8Array) => boolean
  timer: ReturnType<typeof setTimeout>
}

interface AudioExecutionTracker {
  readonly promise: Promise<void>
  resolve(): void
  reject(error: Error): void
}

const WHEEL_TRACK_METERS = 0.023
const MAX_MEMORY_RESPONSE_DATA = 15
const AUDIO_COMPLETION_GRACE_MS = 1_000
const DEFAULT_MOVEMENT_TIMEOUT_MS = 2_000

function responseKey(messageId: number, requestId?: number): string {
  return `${messageId}:${requestId ?? 'single'}`
}

function toneQueueKey(requestId: number): string {
  return `tone:${requestId}`
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

export type DiagnosticHandler = (message: string) => void

interface RequestTimeoutMetadata {
  readonly responseMessageId: number
  readonly requestId?: number
}

class RequestTimeoutError extends Error {
  readonly responseMessageId: number
  readonly requestId?: number

  constructor(metadata: RequestTimeoutMetadata) {
    super(`Timed out waiting for Evo response ${metadata.responseMessageId}`)
    this.name = 'RequestTimeoutError'
    this.responseMessageId = metadata.responseMessageId
    this.requestId = metadata.requestId
  }
}

class RequestWriteTimeoutError extends Error {
  constructor(label: string) {
    super(`Timed out sending Evo ${label}`)
    this.name = 'RequestWriteTimeoutError'
  }
}

class RequestCancelledError extends Error {
  constructor() {
    super('Protocol request was cancelled')
    this.name = 'RequestCancelledError'
  }
}

class AudioExecutionError extends Error {
  constructor(requestId: number, state: string) {
    super(`Evo audio execution ${state} for request ${requestId}`)
    this.name = 'AudioExecutionError'
  }
}

class MemoryResponsePendingError extends Error {
  constructor() {
    super('Waiting to discard a late Evo memory response')
    this.name = 'MemoryResponsePendingError'
  }
}

export class MovementTimeoutError extends Error {
  readonly requestId: number

  constructor(requestId: number) {
    super(`Timed out waiting for Evo velocity response 105 (request ${requestId})`)
    this.name = 'MovementTimeoutError'
    this.requestId = requestId
  }
}

export class MovementSupersededError extends Error {
  readonly requestId: number

  constructor(requestId: number) {
    super(`Movement request ${requestId} was superseded before send`)
    this.name = 'MovementSupersededError'
    this.requestId = requestId
  }
}

export function isMovementTimeoutError(error: unknown): error is MovementTimeoutError {
  return error instanceof MovementTimeoutError
}

export function isMovementSupersededError(error: unknown): error is MovementSupersededError {
  return error instanceof MovementSupersededError
}

export class ModernEvoClient {
  private readonly transport: EvoTransport
  private readonly diagnostic: DiagnosticHandler
  private requestCounter = 0
  private pending = new Map<string, PendingRequest>()
  private unsubscribe: () => void
  private rpcChain: Promise<void> = Promise.resolve()
  private rpcGeneration = 0
  private activeRpcController?: AbortController
  private readonly batchControllers = new Set<AbortController>()
  private priorityBarrier: Promise<void> = Promise.resolve()
  private readonly expectedLateResponses = new Map<string, number>()
  private readonly uncertainMemoryResponseLengths: number[] = []
  private readonly audioExecutions = new Map<number, AudioExecutionTracker>()
  private readonly toneControllers = new Set<AbortController>()
  private readonly activeSoundRequestIds = new Set<number>()
  private readonly movementTimeoutMs: number

  constructor(
    transport: EvoTransport,
    diagnostic: DiagnosticHandler = () => undefined,
    options: { movementTimeoutMs?: number } = {},
  ) {
    this.transport = transport
    this.diagnostic = diagnostic
    this.unsubscribe = transport.subscribe(this.handlePacket)
    this.movementTimeoutMs = Math.max(200, options.movementTimeoutMs ?? DEFAULT_MOVEMENT_TIMEOUT_MS)
  }

  async initialize(): Promise<void> {
    await this.stopExecution(0, true)
  }

  dispose(): void {
    this.cancelOrdinaryRequests()
    for (const controller of this.toneControllers) controller.abort()
    for (const tracker of this.audioExecutions.values()) {
      tracker.reject(new Error('Protocol client closed'))
    }
    this.audioExecutions.clear()
    this.activeSoundRequestIds.clear()
    this.unsubscribe()
    const error = new Error('Protocol client closed')
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
    this.expectedLateResponses.clear()
    this.uncertainMemoryResponseLengths.length = 0
  }

  cancelOrdinaryRequests(): void {
    this.rpcGeneration += 1
    this.activeRpcController?.abort()
    for (const controller of this.batchControllers) controller.abort()
  }

  async setWheels(
    leftMmPerSecond: number,
    rightMmPerSecond: number,
    durationMs = 250,
    signal?: AbortSignal,
  ): Promise<void> {
    if (![leftMmPerSecond, rightMmPerSecond].every(Number.isFinite)) {
      throw new TypeError('Wheel speeds must be finite numbers')
    }
    const left = leftMmPerSecond / 1000
    const right = rightMmPerSecond / 1000
    const linear = (left + right) / 2
    const angular = (right - left) / WHEEL_TRACK_METERS
    const requestId = this.nextRequestId()
    const packet = encodeVelocity(requestId, linear, angular, durationMs)
    try {
      const response = await this.runRpcExclusive(
        (rpcSignal) => this.request(
          packet,
          MODERN_MESSAGE.velocityResponse,
          requestId,
          { replaceKey: 'movement' },
          this.movementTimeoutMs,
          'movement',
          rpcSignal,
        ),
        signal,
      )
      this.assertRequestResponse(response, MODERN_MESSAGE.velocityResponse, requestId)
    } catch (error) {
      if (error instanceof RequestCancelledError) {
        throw new MovementSupersededError(requestId)
      }
      if (
        error instanceof TransportQueueCancelledError &&
        error.replaceKey === 'movement' &&
        ['replaced', 'cleared'].includes(error.reason)
      ) {
        throw new MovementSupersededError(requestId)
      }
      if (
        error instanceof RequestTimeoutError &&
        error.responseMessageId === MODERN_MESSAGE.velocityResponse
      ) {
        throw new MovementTimeoutError(requestId)
      }
      throw error
    }
  }

  async stopMovement(cancelOrdinaryRequests = false): Promise<void> {
    if (cancelOrdinaryRequests) {
      this.cancelOrdinaryRequests()
      for (const controller of this.toneControllers) controller.abort()
      for (const requestId of this.activeSoundRequestIds) {
        this.transport.clearQueued(toneQueueKey(requestId))
      }
    }
    this.transport.clearQueued('movement')
    await this.stopExecution(0, true)
    if (cancelOrdinaryRequests) {
      this.activeSoundRequestIds.clear()
      for (const tracker of this.audioExecutions.values()) {
        tracker.reject(new RequestCancelledError())
      }
    }
  }

  async setLed(mask: number, red: number, green: number, blue: number): Promise<void> {
    await this.runRpcExclusive(async (signal) => {
      this.throwIfAborted(signal)
      const response = await this.request(
        encodeSetLed(mask, red, green, blue),
        MODERN_MESSAGE.setLedResponse,
        undefined,
        undefined,
        2_500,
        'LED',
        signal,
      )
      this.throwIfAborted(signal)
      assertCallSucceeded(response, MODERN_MESSAGE.setLedResponse)
    })
  }

  async playTone(
    frequencyHz: number,
    durationMs: number,
    externalSignal?: AbortSignal,
  ): Promise<void> {
    const requestId = this.nextRequestId()
    const toneController = new AbortController()
    const abort = (): void => toneController.abort()
    if (externalSignal?.aborted) {
      toneController.abort()
    } else {
      externalSignal?.addEventListener('abort', abort, { once: true })
    }
    this.toneControllers.add(toneController)
    let completion: Promise<void> | undefined
    try {
      const response = await this.runRpcExclusive(async (signal) => {
        this.activeSoundRequestIds.add(requestId)
        completion = this.trackAudioExecution(requestId, durationMs, toneController.signal)
        return this.request(
          encodePlayTone(requestId, frequencyHz, durationMs),
          MODERN_MESSAGE.playToneResponse,
          requestId,
          { replaceKey: toneQueueKey(requestId) },
          durationMs + AUDIO_COMPLETION_GRACE_MS,
          'tone',
          signal,
        )
      }, toneController.signal)
      this.assertRequestResponse(response, MODERN_MESSAGE.playToneResponse, requestId)
      if (!completion) throw new Error('Audio execution tracking did not start')
      await completion
    } catch (error) {
      this.audioExecutions.get(requestId)?.reject(asError(error))
      throw error
    } finally {
      this.toneControllers.delete(toneController)
      externalSignal?.removeEventListener('abort', abort)
    }
  }

  async stopSound(): Promise<boolean> {
    for (const controller of this.toneControllers) controller.abort()
    const requestIds = [...this.activeSoundRequestIds]
    if (requestIds.length === 0) return false
    for (const requestId of requestIds) {
      this.transport.clearQueued(toneQueueKey(requestId))
      await this.stopExecution(requestId, true)
      this.activeSoundRequestIds.delete(requestId)
      this.audioExecutions.get(requestId)?.reject(new RequestCancelledError())
    }
    return requestIds.length > 0
  }

  async readFirmware(): Promise<{ version: string; rawMajor: number }> {
    return this.runBatch(async (signal) => {
      return parseFirmware(await this.readRegion(MEMORY_REGION.firmware, signal))
    })
  }

  async readTelemetry(): Promise<EvoTelemetry> {
    return this.runBatch(async (signal) => {
      const firmwareBytes = await this.readRegion(MEMORY_REGION.firmware, signal)
      const batteryBytes = await this.readRegion(MEMORY_REGION.battery, signal)
      const proximityBytes = await this.readRegion(MEMORY_REGION.proximity, signal)
      const colorSensorBytes = await this.readRegion(MEMORY_REGION.colorSensor, signal)
      const processedColorBytes = await this.readRegion(MEMORY_REGION.processedColor, signal)
      const lineColorBytes = await this.readRegion(MEMORY_REGION.lineColor, signal)
      const surfaceColorBytes = await this.readRegion(MEMORY_REGION.surfaceColor, signal)
      const surfaceTypeBytes = await this.readRegion(MEMORY_REGION.surfaceType, signal)
      const surfaceProximityBytes = await this.readRegion(MEMORY_REGION.surfaceProximity, signal)
      const pickupBytes = await this.readRegion(MEMORY_REGION.pickup, signal)
      const colorCodeBytes = await this.readRegion(MEMORY_REGION.colorCode, signal)
      const encoderBytes = await this.readRegion(MEMORY_REGION.encoders, signal)
      const positionBytes = await this.readRegion(MEMORY_REGION.position, signal)
      const chargerBytes = await this.readRegion(MEMORY_REGION.charger, signal)
      const buttonBytes = await this.readRegion(MEMORY_REGION.button, signal)
      const lineSensorBytes = await this.readRegion(MEMORY_REGION.lineSensors, signal)
      const irLeftRearBytes = await this.readRegion(MEMORY_REGION.irMessageLeftRear, signal)
      const irLeftFrontBytes = await this.readRegion(MEMORY_REGION.irMessageLeftFront, signal)
      const irRightRearBytes = await this.readRegion(MEMORY_REGION.irMessageRightRear, signal)
      const irRightFrontBytes = await this.readRegion(MEMORY_REGION.irMessageRightFront, signal)
      const firmware = parseFirmware(firmwareBytes)
      return {
        firmware: firmware.version,
        firmwareRawMajor: firmware.rawMajor,
        battery: parseBattery(batteryBytes),
        proximity: parseProximity(proximityBytes),
        colorSensor: parseColorSensor(colorSensorBytes),
        processedColor: parseProcessedColor(processedColorBytes),
        line: parseLineColor(lineColorBytes),
        surfaceColor: parseSurfaceColor(surfaceColorBytes),
        surface: parseSurface(surfaceTypeBytes, surfaceProximityBytes, pickupBytes),
        colorCode: parseColorCode(colorCodeBytes),
        encoders: parseEncoders(encoderBytes),
        position: parsePosition(positionBytes),
        charger: parseCharger(chargerBytes),
        button: parseButton(buttonBytes),
        lineSensors: parseLineSensors(lineSensorBytes),
        irMessages: {
          leftRear: parseIrMessage(irLeftRearBytes),
          leftFront: parseIrMessage(irLeftFrontBytes),
          rightRear: parseIrMessage(irRightRearBytes),
          rightFront: parseIrMessage(irRightFrontBytes),
        },
        receivedAt: Date.now(),
      }
    })
  }

  async readReactiveSensors(): Promise<ReactiveSensors> {
    return this.runBatch(async (signal) => {
      const safety = await this.readReactiveSafetyBlock(signal)
      const buttonBytes = await this.readRegion(
        MEMORY_REGION.button,
        signal,
        REACTIVE_BUTTON_RESPONSE_TIMEOUT_MS,
      )
      return { ...safety, button: parseButton(buttonBytes) }
    })
  }

  async readReactiveSafetySensors(
    signal?: AbortSignal,
    onRetry: () => void = () => undefined,
  ): Promise<ReactiveSafetySensors> {
    return this.runBatch(
      (batchSignal) => this.readReactiveSafetyBlock(batchSignal, onRetry),
      signal,
    )
  }

  async readReactiveButton(signal?: AbortSignal): Promise<EvoTelemetry['button']> {
    return this.runBatch(async (batchSignal) => {
      const bytes = await this.readRegion(
        MEMORY_REGION.button,
        batchSignal,
        REACTIVE_BUTTON_RESPONSE_TIMEOUT_MS,
      )
      return parseButton(bytes)
    }, signal)
  }

  private async stopExecution(requestId: number, priority: boolean): Promise<void> {
    const send = () => this.request(
      encodeStopExecution(requestId),
      MODERN_MESSAGE.stopExecutionResponse,
      requestId,
      { priority },
      1_000,
      'stop',
    )
    const responsePromise = this.priorityBarrier.then(send, send)
    this.priorityBarrier = responsePromise.then(
      () => undefined,
      () => undefined,
    )
    const response = await responsePromise
    this.assertRequestResponse(response, MODERN_MESSAGE.stopExecutionResponse, requestId)
  }

  private async readReactiveSafetyBlock(
    signal: AbortSignal,
    onRetry: () => void = () => undefined,
  ): Promise<ReactiveSafetySensors> {
    const softTimeout = setTimeout(() => {
      if (!signal.aborted) onRetry()
    }, REACTIVE_SENSOR_SOFT_TIMEOUT_MS)
    let bytes: Uint8Array | undefined
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          bytes = await this.readRegion(
            MEMORY_REGION.reactiveSafety,
            signal,
            REACTIVE_SENSOR_RESPONSE_TIMEOUT_MS,
          )
          break
        } catch (error) {
          if (
            attempt > 0 ||
            signal.aborted ||
            !this.isRetryableMemoryReadError(error)
          ) {
            throw error
          }
          onRetry()
        }
      }
    } finally {
      clearTimeout(softTimeout)
    }
    if (!bytes) throw new Error('Reactive safety read did not complete')
    return {
      pickup: parsePickup(bytes.slice(0, MEMORY_REGION.pickup.length)),
      proximity: parseProximity(bytes.slice(MEMORY_REGION.pickup.length)),
      receivedAt: Date.now(),
    }
  }

  private async readRegion(
    region: { readonly address: number; readonly length: number },
    signal: AbortSignal,
    timeoutMs = 2_500,
  ): Promise<Uint8Array> {
    const result = new Uint8Array(region.length)
    for (let offset = 0; offset < region.length; offset += MAX_MEMORY_RESPONSE_DATA) {
      this.throwIfAborted(signal)
      const length = Math.min(MAX_MEMORY_RESPONSE_DATA, region.length - offset)
      const response = await this.runRpcExclusive(
        async (rpcSignal) => {
          if (this.uncertainMemoryResponseLengths.length > 0) {
            await this.synchronizeMemoryResponses(rpcSignal)
          }
          return this.request(
            encodeMemRead(region.address + offset, length),
            MODERN_MESSAGE.memReadResponse,
            undefined,
            undefined,
            timeoutMs,
            'memory read',
            rpcSignal,
          )
        },
        signal,
      )
      this.throwIfAborted(signal)
      const decoded = decodeMemReadResponse(response)
      if (decoded.result !== 0) {
        throw new Error(`Evo memory read failed with status ${decoded.result}`)
      }
      if (decoded.data.length !== length) {
        throw new Error(`Evo returned ${decoded.data.length} bytes; expected ${length}`)
      }
      result.set(decoded.data, offset)
    }
    return result
  }

  private request(
    packet: Uint8Array,
    responseMessageId: number,
    requestId?: number,
    writeOptions?: TransportWriteOptions,
    timeoutMs = 2_500,
    label = 'request',
    signal?: AbortSignal,
    accept?: (packet: Uint8Array) => boolean,
  ): Promise<Uint8Array> {
    const key = responseKey(responseMessageId, requestId)
    if (this.pending.has(key)) {
      return Promise.reject(new Error(`A request for response ${key} is already pending`))
    }
    if (signal?.aborted) return Promise.reject(new RequestCancelledError())
    const startedAt = Date.now()
    return new Promise<Uint8Array>((resolve, reject) => {
      let pending!: PendingRequest
      const abort = (): void => {
        if (this.pending.get(key) !== pending) return
        this.pending.delete(key)
        this.markResponseUncertain(responseMessageId, requestId, packet)
        pending.reject(new RequestCancelledError())
      }
      const cleanup = (): void => {
        clearTimeout(pending.timer)
        signal?.removeEventListener('abort', abort)
      }
      const timer = setTimeout(() => {
        if (this.pending.get(key) !== pending) return
        this.pending.delete(key)
        this.markResponseUncertain(responseMessageId, requestId, packet)
        this.diagnostic(
          `${label} timeout waiting to send after ${Date.now() - startedAt} ms` +
            (requestId !== undefined ? ` (request ${requestId})` : ''),
        )
        pending.reject(new RequestWriteTimeoutError(label))
      }, timeoutMs)
      pending = {
        timer,
        accept,
        resolve: (response) => {
          cleanup()
          resolve(response)
        },
        reject: (error) => {
          cleanup()
          reject(error)
        },
      }
      this.pending.set(key, pending)
      signal?.addEventListener('abort', abort, { once: true })
      void this.transport
        .write(packet, 'control', writeOptions)
        .then(() => {
          if (this.pending.get(key) !== pending) return
          clearTimeout(pending.timer)
          pending.timer = setTimeout(() => {
            if (this.pending.get(key) !== pending) return
            this.pending.delete(key)
            this.markResponseUncertain(responseMessageId, requestId, packet)
            this.diagnostic(
              `${label} timeout waiting for response ${responseMessageId} after ${timeoutMs} ms` +
                (requestId !== undefined ? ` (request ${requestId})` : ''),
            )
            pending.reject(new RequestTimeoutError({ responseMessageId, requestId }))
          }, timeoutMs)
        })
        .catch((error: unknown) => {
          if (this.pending.get(key) !== pending) return
          clearTimeout(pending.timer)
          this.pending.delete(key)
          pending.reject(asError(error))
        })
    })
  }

  private readonly handlePacket = (packet: Uint8Array): void => {
    try {
      if (packet.length > 512) throw new RangeError('Notification is too large')
      const messageId = readMessageId(packet)
      if (messageId === MODERN_MESSAGE.audioExecutionState) {
        this.handleAudioExecution(packet)
        return
      }
      const hasRequestId = [
        MODERN_MESSAGE.velocityResponse,
        MODERN_MESSAGE.playToneResponse,
        MODERN_MESSAGE.stopExecutionResponse,
      ].includes(messageId as 105 | 119 | 121)
      const requestId = hasRequestId ? readRequestId(packet) : undefined
      const key = responseKey(messageId, requestId)
      const expectedLateCount = this.expectedLateResponses.get(key) ?? 0
      if (expectedLateCount > 0) {
        if (expectedLateCount === 1) {
          this.expectedLateResponses.delete(key)
        } else {
          this.expectedLateResponses.set(key, expectedLateCount - 1)
        }
        return
      }
      const pending = this.pending.get(key)
      if (!pending) {
        if (
          messageId === MODERN_MESSAGE.memReadResponse &&
          this.uncertainMemoryResponseLengths.length > 0
        ) {
          this.discardUncertainMemoryResponse(packet)
          return
        }
        this.diagnostic(`Ignored unsolicited protocol message ${messageId}`)
        return
      }
      if (pending.accept && !pending.accept(packet)) return
      clearTimeout(pending.timer)
      this.pending.delete(key)
      pending.resolve(packet.slice())
    } catch (error) {
      this.diagnostic(`Rejected malformed notification: ${asError(error).message}`)
    }
  }

  private handleAudioExecution(packet: Uint8Array): void {
    const event = decodeAudioExecutionState(packet)
    const key = responseKey(MODERN_MESSAGE.playToneResponse, event.requestId)
    const pending = this.pending.get(key)
    if (event.executionState === EXECUTION_STATE.finishedNormal) {
      if (pending) {
        const response = new Uint8Array(6)
        const view = new DataView(response.buffer)
        view.setUint16(0, MODERN_MESSAGE.playToneResponse, true)
        view.setUint32(2, event.requestId, true)
        this.pending.delete(key)
        this.rememberExpectedLateResponse(key)
        pending.resolve(response)
      }
      this.activeSoundRequestIds.delete(event.requestId)
      this.audioExecutions.get(event.requestId)?.resolve()
      return
    }
    if (event.executionState === EXECUTION_STATE.running) return

    this.activeSoundRequestIds.delete(event.requestId)
    const state = executionStateName(event.executionState)
    const error = new AudioExecutionError(event.requestId, state)
    if (pending) {
      this.pending.delete(key)
      this.rememberExpectedLateResponse(key)
      pending.reject(error)
    }
    this.audioExecutions.get(event.requestId)?.reject(error)
    if (event.executionState !== EXECUTION_STATE.finishedForced) {
      this.diagnostic(`Audio execution ${state} for request ${event.requestId}`)
    }
  }

  private assertRequestResponse(packet: Uint8Array, messageId: number, requestId: number): void {
    if (
      packet.length !== 6 ||
      readMessageId(packet) !== messageId ||
      readRequestId(packet) !== requestId
    ) {
      throw new Error(`Malformed response to request ${requestId}`)
    }
  }

  private nextRequestId(): number {
    this.requestCounter = (this.requestCounter + 1) & 0x00ff_ffff
    if (this.requestCounter === 0) this.requestCounter = 1
    return (0x02_00_00_00 | this.requestCounter) >>> 0
  }

  private trackAudioExecution(
    requestId: number,
    durationMs: number,
    signal: AbortSignal,
  ): Promise<void> {
    let tracker!: AudioExecutionTracker
    let resolvePromise!: () => void
    let rejectPromise!: (error: Error) => void
    const promise = new Promise<void>((resolve, reject) => {
      resolvePromise = resolve
      rejectPromise = reject
    })
    const abort = (): void => tracker.reject(new RequestCancelledError())
    const timer = setTimeout(() => {
      tracker.reject(new AudioExecutionError(requestId, 'completion timed out'))
    }, durationMs + AUDIO_COMPLETION_GRACE_MS)
    const cleanup = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      if (this.audioExecutions.get(requestId) === tracker) {
        this.audioExecutions.delete(requestId)
      }
    }
    tracker = {
      promise,
      resolve: () => {
        cleanup()
        resolvePromise()
      },
      reject: (error) => {
        cleanup()
        rejectPromise(error)
      },
    }
    this.audioExecutions.set(requestId, tracker)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    void promise.catch(() => undefined)
    return promise
  }

  private rememberExpectedLateResponse(key: string): void {
    this.expectedLateResponses.set(key, (this.expectedLateResponses.get(key) ?? 0) + 1)
    if (this.expectedLateResponses.size <= 100) return
    const oldest = this.expectedLateResponses.keys().next().value
    if (oldest !== undefined) this.expectedLateResponses.delete(oldest)
  }

  private markResponseUncertain(
    responseMessageId: number,
    requestId: number | undefined,
    requestPacket: Uint8Array,
  ): void {
    if (requestId !== undefined) {
      this.rememberExpectedLateResponse(responseKey(responseMessageId, requestId))
      return
    }
    if (responseMessageId !== MODERN_MESSAGE.memReadResponse) return
    const length = new DataView(
      requestPacket.buffer,
      requestPacket.byteOffset,
      requestPacket.byteLength,
    ).getUint16(6, true)
    this.uncertainMemoryResponseLengths.push(length)
  }

  private discardUncertainMemoryResponse(packet: Uint8Array): void {
    const length = decodeMemReadResponse(packet).data.length
    const index = this.uncertainMemoryResponseLengths.indexOf(length)
    if (index >= 0) this.uncertainMemoryResponseLengths.splice(index, 1)
    this.diagnostic('Discarded late memory response after an uncorrelated timeout')
  }

  private async synchronizeMemoryResponses(signal: AbortSignal): Promise<void> {
    const markerLength = Array.from(
      { length: MAX_MEMORY_RESPONSE_DATA },
      (_, index) => index + 1,
    ).find((length) => !this.uncertainMemoryResponseLengths.includes(length))
    if (markerLength === undefined) throw new MemoryResponsePendingError()

    const response = await this.request(
      encodeMemRead(0, markerLength),
      MODERN_MESSAGE.memReadResponse,
      undefined,
      undefined,
      MEMORY_RESPONSE_SYNC_TIMEOUT_MS,
      'memory synchronization read',
      signal,
      (packet) => {
        const length = decodeMemReadResponse(packet).data.length
        if (length === markerLength) return true
        this.discardUncertainMemoryResponse(packet)
        return false
      },
    )
    const decoded = decodeMemReadResponse(response)
    if (decoded.result !== 0 || decoded.data.length !== markerLength) {
      throw new MemoryResponsePendingError()
    }
    this.uncertainMemoryResponseLengths.length = 0
  }

  private isRetryableMemoryReadError(error: unknown): boolean {
    return (
      error instanceof RequestWriteTimeoutError ||
      (
        error instanceof RequestTimeoutError &&
        error.responseMessageId === MODERN_MESSAGE.memReadResponse
      )
    )
  }

  private async runBatch<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    externalSignal?: AbortSignal,
  ): Promise<T> {
    const controller = new AbortController()
    const abort = (): void => controller.abort()
    if (externalSignal?.aborted) {
      controller.abort()
    } else {
      externalSignal?.addEventListener('abort', abort, { once: true })
    }
    this.batchControllers.add(controller)
    try {
      this.throwIfAborted(controller.signal)
      return await operation(controller.signal)
    } finally {
      this.batchControllers.delete(controller)
      externalSignal?.removeEventListener('abort', abort)
    }
  }

  private runRpcExclusive<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    externalSignal?: AbortSignal,
  ): Promise<T> {
    const generation = this.rpcGeneration
    const controller = new AbortController()
    const abort = (): void => controller.abort()
    if (externalSignal?.aborted) {
      controller.abort()
    } else {
      externalSignal?.addEventListener('abort', abort, { once: true })
    }
    const run = async (): Promise<T> => {
      try {
        await this.priorityBarrier
        if (generation !== this.rpcGeneration || controller.signal.aborted) {
          throw new RequestCancelledError()
        }
        this.activeRpcController = controller
        const result = await operation(controller.signal)
        this.throwIfAborted(controller.signal)
        return result
      } finally {
        if (this.activeRpcController === controller) this.activeRpcController = undefined
        externalSignal?.removeEventListener('abort', abort)
      }
    }
    const result = this.rpcChain.then(run, run)
    this.rpcChain = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  private throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) throw new RequestCancelledError()
  }
}
