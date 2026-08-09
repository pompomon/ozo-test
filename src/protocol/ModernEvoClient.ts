import {
  TransportQueueCancelledError,
  type EvoTransport,
  type TransportWriteOptions,
} from '../transport/EvoTransport.ts'
import {
  assertCallSucceeded,
  decodeMemReadResponse,
  encodeMemRead,
  encodePlayTone,
  encodeSetLed,
  encodeStopExecution,
  encodeVelocity,
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
  parsePosition,
  parseProcessedColor,
  parseProximity,
  parseSurface,
  parseSurfaceColor,
  type EvoTelemetry,
} from './telemetry.ts'

interface PendingRequest {
  readonly resolve: (packet: Uint8Array) => void
  readonly reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const WHEEL_TRACK_METERS = 0.023
const MAX_MEMORY_RESPONSE_DATA = 15
const DEFAULT_MOVEMENT_TIMEOUT_MS = 2_000

function responseKey(messageId: number, requestId?: number): string {
  return `${messageId}:${requestId ?? 'single'}`
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
  private memoryChain: Promise<void> = Promise.resolve()
  private noIdChain: Promise<void> = Promise.resolve()
  private soundRequestId?: number
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
    this.unsubscribe()
    const error = new Error('Protocol client closed')
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  async setWheels(leftMmPerSecond: number, rightMmPerSecond: number, durationMs = 250): Promise<void> {
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
      const response = await this.request(
        packet,
        MODERN_MESSAGE.velocityResponse,
        requestId,
        { replaceKey: 'movement' },
        this.movementTimeoutMs,
        'movement',
      )
      this.assertRequestResponse(response, MODERN_MESSAGE.velocityResponse, requestId)
    } catch (error) {
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

  async stopMovement(): Promise<void> {
    this.transport.clearQueued('movement')
    await this.stopExecution(0, true)
  }

  async setLed(mask: number, red: number, green: number, blue: number): Promise<void> {
    await this.runNoIdExclusive(async () => {
      const response = await this.request(
        encodeSetLed(mask, red, green, blue),
        MODERN_MESSAGE.setLedResponse,
      )
      assertCallSucceeded(response, MODERN_MESSAGE.setLedResponse)
    })
  }

  async playTone(frequencyHz: number, durationMs: number): Promise<void> {
    const requestId = this.nextRequestId()
    this.soundRequestId = requestId
    const response = await this.request(
      encodePlayTone(requestId, frequencyHz, durationMs),
      MODERN_MESSAGE.playToneResponse,
      requestId,
    )
    this.assertRequestResponse(response, MODERN_MESSAGE.playToneResponse, requestId)
  }

  async stopSound(): Promise<void> {
    if (this.soundRequestId === undefined) return
    const requestId = this.soundRequestId
    this.soundRequestId = undefined
    await this.stopExecution(requestId, true)
  }

  async readFirmware(): Promise<{ version: string; rawMajor: number }> {
    return parseFirmware(await this.readRegion(MEMORY_REGION.firmware))
  }

  async readTelemetry(): Promise<EvoTelemetry> {
    const [
      firmwareBytes,
      batteryBytes,
      proximityBytes,
      colorSensorBytes,
      processedColorBytes,
      lineColorBytes,
      surfaceColorBytes,
      surfaceTypeBytes,
      surfaceProximityBytes,
      pickupBytes,
      colorCodeBytes,
      encoderBytes,
      positionBytes,
      chargerBytes,
      buttonBytes,
      lineSensorBytes,
      irLeftRearBytes,
      irLeftFrontBytes,
      irRightRearBytes,
      irRightFrontBytes,
    ] = await Promise.all([
      this.readRegion(MEMORY_REGION.firmware),
      this.readRegion(MEMORY_REGION.battery),
      this.readRegion(MEMORY_REGION.proximity),
      this.readRegion(MEMORY_REGION.colorSensor),
      this.readRegion(MEMORY_REGION.processedColor),
      this.readRegion(MEMORY_REGION.lineColor),
      this.readRegion(MEMORY_REGION.surfaceColor),
      this.readRegion(MEMORY_REGION.surfaceType),
      this.readRegion(MEMORY_REGION.surfaceProximity),
      this.readRegion(MEMORY_REGION.pickup),
      this.readRegion(MEMORY_REGION.colorCode),
      this.readRegion(MEMORY_REGION.encoders),
      this.readRegion(MEMORY_REGION.position),
      this.readRegion(MEMORY_REGION.charger),
      this.readRegion(MEMORY_REGION.button),
      this.readRegion(MEMORY_REGION.lineSensors),
      this.readRegion(MEMORY_REGION.irMessageLeftRear),
      this.readRegion(MEMORY_REGION.irMessageLeftFront),
      this.readRegion(MEMORY_REGION.irMessageRightRear),
      this.readRegion(MEMORY_REGION.irMessageRightFront),
    ])
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
  }

  private async stopExecution(requestId: number, priority: boolean): Promise<void> {
    const response = await this.request(
      encodeStopExecution(requestId),
      MODERN_MESSAGE.stopExecutionResponse,
      requestId,
      { priority },
      1_000,
    )
    this.assertRequestResponse(response, MODERN_MESSAGE.stopExecutionResponse, requestId)
  }

  private readRegion(region: { readonly address: number; readonly length: number }): Promise<Uint8Array> {
    return this.runMemoryExclusive(async () => {
      const result = new Uint8Array(region.length)
      for (let offset = 0; offset < region.length; offset += MAX_MEMORY_RESPONSE_DATA) {
        const length = Math.min(MAX_MEMORY_RESPONSE_DATA, region.length - offset)
        const response = await this.request(
          encodeMemRead(region.address + offset, length),
          MODERN_MESSAGE.memReadResponse,
        )
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
    })
  }

  private request(
    packet: Uint8Array,
    responseMessageId: number,
    requestId?: number,
    writeOptions?: TransportWriteOptions,
    timeoutMs = 2_500,
    label = 'request',
  ): Promise<Uint8Array> {
    const key = responseKey(responseMessageId, requestId)
    if (this.pending.has(key)) {
      return Promise.reject(new Error(`A request for response ${key} is already pending`))
    }
    const startedAt = Date.now()
    return new Promise<Uint8Array>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key)
        this.diagnostic(
          `${label} timeout waiting to send after ${Date.now() - startedAt} ms` +
            (requestId ? ` (request ${requestId})` : ''),
        )
        reject(new RequestWriteTimeoutError(label))
      }, timeoutMs)
      this.pending.set(key, { resolve, reject, timer })
      void this.transport
        .write(packet, 'control', writeOptions)
        .then(() => {
          const pending = this.pending.get(key)
          if (!pending) return
          clearTimeout(pending.timer)
          pending.timer = setTimeout(() => {
            this.pending.delete(key)
            this.diagnostic(
              `${label} timeout waiting for response ${responseMessageId} after ${timeoutMs} ms` +
                (requestId ? ` (request ${requestId})` : ''),
            )
            pending.reject(new RequestTimeoutError({ responseMessageId, requestId }))
          }, timeoutMs)
        })
        .catch((error: unknown) => {
          const pending = this.pending.get(key)
          if (!pending) return
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
      const hasRequestId = [
        MODERN_MESSAGE.velocityResponse,
        MODERN_MESSAGE.playToneResponse,
        MODERN_MESSAGE.stopExecutionResponse,
      ].includes(messageId as 105 | 119 | 121)
      const requestId = hasRequestId ? readRequestId(packet) : undefined
      const key = responseKey(messageId, requestId)
      const pending = this.pending.get(key)
      if (!pending) {
        this.diagnostic(`Ignored unsolicited protocol message ${messageId}`)
        return
      }
      clearTimeout(pending.timer)
      this.pending.delete(key)
      pending.resolve(packet.slice())
    } catch (error) {
      this.diagnostic(`Rejected malformed notification: ${asError(error).message}`)
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

  private runMemoryExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.memoryChain.then(operation, operation)
    this.memoryChain = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  private runNoIdExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.noIdChain.then(operation, operation)
    this.noIdChain = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
}
