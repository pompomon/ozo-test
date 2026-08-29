import { LEGACY_STOP_FILE, encodeLegacyDrive, encodeLegacyLed } from '../protocol/legacyCodec.ts'
import {
  isMovementSupersededError,
  isMovementTimeoutError,
  ModernEvoClient,
} from '../protocol/ModernEvoClient.ts'
import {
  isFullyCompatible,
  missingCapabilities,
  type ProtocolProfile,
} from '../protocol/profile.ts'
import type { EvoTelemetry, ReactiveSensors } from '../protocol/telemetry.ts'
import { ControlLock } from '../safety/ControlLock.ts'
import type { EvoTransport } from '../transport/EvoTransport.ts'
import { WebBluetoothTransport, webBluetoothSupport } from '../transport/WebBluetoothTransport.ts'
import {
  normalizedToMillimetersPerSecond,
  normalizeWheelSpeeds,
  type WheelSpeeds,
} from './drive.ts'
import { MIN_REACTIVE_SENSOR_INTERVAL_MS } from './constants.ts'

export type ControllerPhase =
  | 'unsupported'
  | 'disconnected'
  | 'selecting'
  | 'connecting'
  | 'ready'
  | 'arming'
  | 'armed'
  | 'stopping'
  | 'incompatible'
  | 'error'

export interface DiagnosticEntry {
  readonly id: number
  readonly timestamp: number
  readonly level: 'info' | 'warning' | 'error'
  readonly message: string
}

export interface ControllerSnapshot {
  readonly phase: ControllerPhase
  readonly supportReason?: string
  readonly error?: string
  readonly deviceName?: string
  readonly profile?: ProtocolProfile
  readonly firmware?: string
  readonly telemetry?: EvoTelemetry
  readonly maximumSpeed: number
  readonly wheels: WheelSpeeds
  readonly diagnostics: readonly DiagnosticEntry[]
}

type SnapshotHandler = (snapshot: ControllerSnapshot) => void
export type ReactiveSensorHandler = (sensors: ReactiveSensors) => void
export type ReactiveSensorErrorHandler = (error: Error) => void

const DRIVE_REFRESH_MS = 100
const DRIVE_WATCHDOG_MS = 250
const DRIVE_TIMEOUT_FAILSAFE_THRESHOLD = 2
const TELEMETRY_REFRESH_MS = 2_000

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function errorMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === 'NotFoundError') {
    return 'No device was selected.'
  }
  return error instanceof Error ? error.message : String(error)
}

export class EvoController {
  private readonly transport: EvoTransport
  private snapshotValue: ControllerSnapshot
  private readonly listeners = new Set<SnapshotHandler>()
  private readonly lock = new ControlLock()
  private client?: ModernEvoClient
  private wakeLock?: WakeLockSentinel
  private telemetryTimer?: ReturnType<typeof setInterval>
  private reactiveSensorTimer?: ReturnType<typeof setTimeout>
  private reactiveSensorGeneration = 0
  private telemetryInFlight = false
  private sensorReadChain: Promise<void> = Promise.resolve()
  private driveLoopActive = false
  private driveGeneration = 0
  private armingGeneration = 0
  private targetWheels: WheelSpeeds = { left: 0, right: 0 }
  private stopPromise?: Promise<void>
  private shutdownPromise?: Promise<void>
  private diagnosticId = 0
  private safetyCleanup?: () => void

  constructor(transport: EvoTransport = new WebBluetoothTransport()) {
    this.transport = transport
    const support = webBluetoothSupport()
    this.snapshotValue = {
      phase: support.supported ? 'disconnected' : 'unsupported',
      supportReason: support.reason,
      maximumSpeed: 120,
      wheels: { left: 0, right: 0 },
      diagnostics: [],
    }
    transport.onDisconnect((reason) => {
      this.handleUnexpectedDisconnect(reason)
    })
  }

  get snapshot(): ControllerSnapshot {
    return this.snapshotValue
  }

  subscribe(handler: SnapshotHandler): () => void {
    this.listeners.add(handler)
    handler(this.snapshotValue)
    return () => this.listeners.delete(handler)
  }

  installSafetyHandlers(): () => void {
    if (this.safetyCleanup) return this.safetyCleanup
    const loseControl = (): void => {
      if (this.snapshotValue.phase === 'arming' || this.snapshotValue.phase === 'armed') {
        void this.emergencyStop('Control focus was lost')
      }
    }
    const visibility = (): void => {
      if (document.visibilityState === 'hidden') loseControl()
    }
    window.addEventListener('blur', loseControl)
    window.addEventListener('pagehide', loseControl)
    window.addEventListener('beforeunload', loseControl)
    document.addEventListener('visibilitychange', visibility)
    this.safetyCleanup = () => {
      window.removeEventListener('blur', loseControl)
      window.removeEventListener('pagehide', loseControl)
      window.removeEventListener('beforeunload', loseControl)
      document.removeEventListener('visibilitychange', visibility)
      this.safetyCleanup = undefined
    }
    return this.safetyCleanup
  }

  async connect(): Promise<void> {
    if (!['disconnected', 'error'].includes(this.snapshotValue.phase)) return
    this.patch({ phase: 'selecting', error: undefined })
    this.log('info', 'Opening the browser Bluetooth device picker')
    try {
      const connection = await this.transport.connect()
      this.patch({
        phase: 'connecting',
        deviceName: connection.name,
        profile: connection.profile,
      })
      this.log('info', `Connected to ${connection.name}; detecting protocol capabilities`)

      if (connection.profile.id === 'legacy') {
        await this.transport.write(LEGACY_STOP_FILE, 'control', { priority: true })
        this.patch({
          phase: 'incompatible',
          error: connection.profile.compatibilityMessage,
        })
        this.log(
          'warning',
          `Legacy profile is missing: ${missingCapabilities(connection.profile).join(', ')}`,
        )
        return
      }

      this.client = new ModernEvoClient(this.transport, (message) => this.log('warning', message))
      await this.client.initialize()
      const firmware = await this.client.readFirmware()
      if (Number(firmware.version.split('.')[0]) < 3) {
        this.patch({
          phase: 'incompatible',
          firmware: firmware.version,
          error: 'This firmware predates the supported Evo 3.x protocol. Motors remain locked.',
        })
        return
      }
      this.patch({ phase: 'ready', firmware: firmware.version })
      this.log('info', `Evo firmware ${firmware.version} is ready`)
      this.startTelemetry()
      await this.refreshTelemetry()
    } catch (error) {
      const message = errorMessage(error)
      this.log(message === 'No device was selected.' ? 'info' : 'error', message)
      this.client?.dispose()
      this.client = undefined
      await this.transport.disconnect()
      this.patch({
        phase: message === 'No device was selected.' ? 'disconnected' : 'error',
        error: message === 'No device was selected.' ? undefined : message,
        deviceName: undefined,
        profile: undefined,
        firmware: undefined,
        telemetry: undefined,
      })
    }
  }

  async disconnect(): Promise<void> {
    if (this.snapshotValue.phase === 'arming') {
      this.armingGeneration += 1
    }
    if (this.snapshotValue.phase === 'armed') {
      await this.emergencyStop('Disconnect requested')
    } else if (this.shutdownPromise) {
      await this.shutdownPromise
    }
    this.stopTelemetry()
    this.stopReactiveSensorPolling()
    this.client?.dispose()
    this.client = undefined
    await this.transport.disconnect()
    this.lock.release()
    await this.releaseWakeLock()
    this.patch({
      phase: webBluetoothSupport().supported ? 'disconnected' : 'unsupported',
      error: undefined,
      deviceName: undefined,
      profile: undefined,
      firmware: undefined,
      telemetry: undefined,
      wheels: { left: 0, right: 0 },
    })
    this.log('info', 'Bluetooth connection closed')
  }

  async arm(): Promise<void> {
    if (
      this.snapshotValue.phase !== 'ready' ||
      !this.snapshotValue.profile ||
      !isFullyCompatible(this.snapshotValue.profile) ||
      !this.client
    ) {
      return
    }
    const generation = ++this.armingGeneration
    this.patch({ phase: 'arming', error: undefined })
    if (!(await this.lock.acquire())) {
      if (generation !== this.armingGeneration) return
      this.patch({ phase: 'ready', error: 'Another tab already holds motor control.' })
      this.log('warning', 'Motor arming denied because another tab has control')
      return
    }
    if (generation !== this.armingGeneration) {
      this.lock.release()
      await this.releaseWakeLock()
      return
    }
    let requestedWakeLock: WakeLockSentinel | undefined
    try {
      requestedWakeLock = await navigator.wakeLock?.request('screen')
    } catch {
      this.log('warning', 'Screen wake lock is unavailable; keep this page visible')
    }
    if (generation !== this.armingGeneration) {
      this.lock.release()
      if (requestedWakeLock && !requestedWakeLock.released) {
        await requestedWakeLock.release()
      }
      return
    }
    this.wakeLock = requestedWakeLock
    this.patch({ phase: 'armed', error: undefined })
    this.log('warning', 'Motors armed')
  }

  async disarm(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise
    if (this.snapshotValue.phase !== 'armed') return
    return this.trackShutdown(this.finishDisarm())
  }

  private async finishDisarm(): Promise<void> {
    this.stopReactiveSensorPolling()
    this.patch({ phase: 'stopping', wheels: { left: 0, right: 0 } })
    let stopFailure: string | undefined
    try {
      await this.stopMotion()
    } catch (error) {
      stopFailure = errorMessage(error)
      this.log('error', `Stop command failed while disarming: ${stopFailure}`)
    }
    this.lock.release()
    await this.releaseWakeLock()
    this.patch({
      phase: stopFailure ? 'error' : 'ready',
      error: stopFailure
        ? 'The stop command was not acknowledged. Keep Evo clear and reconnect before driving.'
        : undefined,
      wheels: { left: 0, right: 0 },
    })
    if (!stopFailure) this.startTelemetry()
    this.log(
      stopFailure ? 'warning' : 'info',
      stopFailure ? 'Motor controls locked after stop failure' : 'Motors disarmed',
    )
  }

  setMaximumSpeed(speed: number): void {
    if (!Number.isFinite(speed)) return
    this.patch({ maximumSpeed: Math.round(Math.min(300, Math.max(50, speed))) })
  }

  setDrive(left: number, right: number): void {
    if (this.snapshotValue.phase !== 'armed') return
    const wheels = normalizeWheelSpeeds(left, right)
    this.targetWheels = wheels
    this.patch({ wheels })
    if (wheels.left === 0 && wheels.right === 0) {
      void this.stopMotion()
      return
    }
    void this.runDriveLoop()
  }

  async stopMotion(): Promise<void> {
    this.targetWheels = { left: 0, right: 0 }
    this.driveGeneration += 1
    this.patch({ wheels: { left: 0, right: 0 } })
    if (!this.client || !this.transport.connected) return
    if (this.stopPromise) return this.stopPromise
    this.stopPromise = this.client.stopMovement().finally(() => {
      this.stopPromise = undefined
    })
    return this.stopPromise
  }

  async emergencyStop(reason = 'Emergency stop pressed'): Promise<void> {
    this.armingGeneration += 1
    return this.trackShutdown(this.finishEmergencyStop(reason))
  }

  private async finishEmergencyStop(reason: string): Promise<void> {
    const wasArmed = this.snapshotValue.phase === 'armed'
    const wasArming = this.snapshotValue.phase === 'arming'
    this.stopReactiveSensorPolling()
    let stopFailure: string | undefined
    this.targetWheels = { left: 0, right: 0 }
    this.driveGeneration += 1
    this.transport.clearQueued('movement')
    if (wasArmed || wasArming) {
      this.patch({ phase: 'stopping', wheels: { left: 0, right: 0 } })
    }
    try {
      await this.stopMotion()
    } catch (error) {
      stopFailure = errorMessage(error)
      this.log('error', `Stop command failed: ${stopFailure}`)
    }
    this.lock.release()
    await this.releaseWakeLock()
    if (this.transport.connected && (wasArmed || wasArming)) {
      this.patch({
        phase: stopFailure ? 'error' : 'ready',
        error: stopFailure
          ? 'The emergency stop was not acknowledged. Keep Evo clear and reconnect before driving.'
          : undefined,
        wheels: { left: 0, right: 0 },
      })
      if (!stopFailure) this.startTelemetry()
    }
    this.log('warning', reason)
  }

  private trackShutdown(operation: Promise<void>): Promise<void> {
    const previous = this.shutdownPromise
    const tracked = previous
      ? Promise.all([previous, operation]).then(() => undefined)
      : operation
    this.shutdownPromise = tracked
    const clear = (): void => {
      if (this.shutdownPromise === tracked) this.shutdownPromise = undefined
    }
    tracked.then(clear, clear)
    return tracked
  }

  async setLights(mask: number, color: string, brightness: number): Promise<void> {
    if (!this.canUse('lights')) return
    const rgb = parseHexColor(color)
    const scale = Math.min(100, Math.max(0, brightness)) / 100
    const red = Math.round(rgb.red * scale)
    const green = Math.round(rgb.green * scale)
    const blue = Math.round(rgb.blue * scale)
    if (this.client) {
      await this.client.setLed(mask, red, green, blue)
    } else {
      await this.transport.write(encodeLegacyLed(mask, red, green, blue), 'control')
    }
    this.log('info', `Updated LEDs (mask 0x${mask.toString(16)})`)
  }

  async playTone(frequencyHz: number, durationMs: number): Promise<void> {
    if (!this.canUse('sound') || !this.client) return
    await this.client.playTone(frequencyHz, durationMs)
    this.log('info', `Played ${frequencyHz} Hz tone`)
  }

  async stopSound(): Promise<void> {
    if (!this.client) return
    await this.client.stopSound()
    this.log('info', 'Stopped sound')
  }

  async refreshTelemetry(): Promise<void> {
    const client = this.client
    if (!client || this.telemetryInFlight || !this.transport.connected) return
    this.telemetryInFlight = true
    try {
      const telemetry = await this.runSensorRead(() => client.readTelemetry())
      if (this.client !== client || !this.transport.connected) return
      this.patch({ telemetry, firmware: telemetry.firmware })
    } catch (error) {
      this.log('warning', `Telemetry refresh failed: ${errorMessage(error)}`)
    } finally {
      this.telemetryInFlight = false
    }
  }

  async readReactiveSensors(): Promise<ReactiveSensors> {
    const client = this.client
    if (!client || !this.transport.connected) {
      throw new Error('Evo is not connected')
    }
    const sensors = await this.runSensorRead(() => client.readReactiveSensors())
    if (this.client !== client || !this.transport.connected) {
      throw new Error('Evo disconnected during sensor sampling')
    }
    return sensors
  }

  async startReactiveSensorPolling(
    handler: ReactiveSensorHandler,
    onError: ReactiveSensorErrorHandler,
    intervalMs: number,
  ): Promise<() => void> {
    if (this.snapshotValue.phase !== 'armed' || !this.client || !this.transport.connected) {
      throw new Error('Arm Evo before starting reactive sensor polling')
    }
    if (!Number.isFinite(intervalMs)) {
      throw new TypeError('Reactive sensor interval must be finite')
    }
    const interval = Math.max(MIN_REACTIVE_SENSOR_INTERVAL_MS, Math.round(intervalMs))
    this.stopTelemetry()
    this.stopReactiveSensorPolling()
    const generation = this.reactiveSensorGeneration

    const poll = async (): Promise<void> => {
      if (generation !== this.reactiveSensorGeneration) return
      try {
        const sensors = await this.readReactiveSensors()
        if (
          generation === this.reactiveSensorGeneration &&
          this.snapshotValue.phase === 'armed' &&
          this.transport.connected
        ) {
          handler(sensors)
        }
      } catch (error) {
        if (generation === this.reactiveSensorGeneration && this.transport.connected) {
          onError(error instanceof Error ? error : new Error(errorMessage(error)))
        }
      } finally {
        if (
          generation === this.reactiveSensorGeneration &&
          this.snapshotValue.phase === 'armed' &&
          this.transport.connected
        ) {
          this.reactiveSensorTimer = setTimeout(() => {
            void poll()
          }, interval)
        }
      }
    }

    try {
      const sensors = await this.readReactiveSensors()
      if (
        generation !== this.reactiveSensorGeneration ||
        this.snapshotValue.phase !== 'armed' ||
        !this.transport.connected
      ) {
        throw new Error('Reactive sensor polling was interrupted')
      }
      handler(sensors)
    } catch (error) {
      if (generation === this.reactiveSensorGeneration) {
        this.stopReactiveSensorPolling()
        if (this.client && this.transport.connected) this.startTelemetry()
      }
      throw error
    }
    if (
      generation !== this.reactiveSensorGeneration ||
      this.snapshotValue.phase !== 'armed' ||
      !this.transport.connected
    ) {
      throw new Error('Reactive sensor polling was interrupted')
    }
    this.reactiveSensorTimer = setTimeout(() => {
      void poll()
    }, interval)

    return () => {
      if (generation !== this.reactiveSensorGeneration) return
      this.stopReactiveSensorPolling()
      if (this.client && this.transport.connected) this.startTelemetry()
    }
  }

  exportDiagnostics(): string {
    const deviceName = this.snapshotValue.deviceName
    return this.snapshotValue.diagnostics
      .map((entry) => {
        const message = deviceName ? entry.message.replaceAll(deviceName, '[device]') : entry.message
        return `${new Date(entry.timestamp).toISOString()} ${entry.level.toUpperCase()} ${message}`
      })
      .join('\n')
  }

  clearDiagnostics(): void {
    this.patch({ diagnostics: [] })
  }

  private async runDriveLoop(): Promise<void> {
    if (this.driveLoopActive || !this.client) return
    this.driveLoopActive = true
    const generation = ++this.driveGeneration
    let consecutiveTimeouts = 0
    try {
      while (
        this.snapshotValue.phase === 'armed' &&
        generation === this.driveGeneration &&
        (this.targetWheels.left !== 0 || this.targetWheels.right !== 0)
      ) {
        const wheels = normalizedToMillimetersPerSecond(
          this.targetWheels,
          this.snapshotValue.maximumSpeed,
        )
        try {
          await this.client.setWheels(wheels.left, wheels.right, DRIVE_WATCHDOG_MS)
          consecutiveTimeouts = 0
        } catch (error) {
          if (isMovementSupersededError(error)) {
            continue
          }
          if (isMovementTimeoutError(error)) {
            consecutiveTimeouts += 1
            this.log(
              'warning',
              `Drive acknowledgment timeout (${consecutiveTimeouts}/${DRIVE_TIMEOUT_FAILSAFE_THRESHOLD})`,
            )
            if (consecutiveTimeouts < DRIVE_TIMEOUT_FAILSAFE_THRESHOLD) {
              await delay(DRIVE_REFRESH_MS)
              continue
            }
          }
          throw error
        }
        await delay(DRIVE_REFRESH_MS)
      }
    } catch (error) {
      this.log('error', `Drive command failed: ${errorMessage(error)}`)
      await this.emergencyStop('Drive communication failed')
    } finally {
      this.driveLoopActive = false
      if (
        this.snapshotValue.phase === 'armed' &&
        (this.targetWheels.left !== 0 || this.targetWheels.right !== 0) &&
        generation !== this.driveGeneration
      ) {
        void this.runDriveLoop()
      }
    }
  }

  private canUse(capability: keyof ProtocolProfile['capabilities']): boolean {
    return (
      ['ready', 'armed'].includes(this.snapshotValue.phase) &&
      this.snapshotValue.profile?.capabilities[capability] === true
    )
  }

  private startTelemetry(): void {
    this.stopTelemetry()
    this.telemetryTimer = setInterval(() => {
      void this.refreshTelemetry()
    }, TELEMETRY_REFRESH_MS)
  }

  private stopTelemetry(): void {
    if (this.telemetryTimer) clearInterval(this.telemetryTimer)
    this.telemetryTimer = undefined
  }

  private stopReactiveSensorPolling(): void {
    this.reactiveSensorGeneration += 1
    if (this.reactiveSensorTimer) clearTimeout(this.reactiveSensorTimer)
    this.reactiveSensorTimer = undefined
  }

  private handleUnexpectedDisconnect(reason?: Error): void {
    this.armingGeneration += 1
    this.stopTelemetry()
    this.stopReactiveSensorPolling()
    this.driveGeneration += 1
    this.targetWheels = { left: 0, right: 0 }
    this.client?.dispose()
    this.client = undefined
    this.lock.release()
    void this.releaseWakeLock()
    this.patch({
      phase: 'error',
      error: reason?.message ?? 'Evo disconnected unexpectedly.',
      deviceName: undefined,
      profile: undefined,
      firmware: undefined,
      telemetry: undefined,
      wheels: { left: 0, right: 0 },
    })
    this.log('error', reason?.message ?? 'Evo disconnected unexpectedly')
  }

  private async releaseWakeLock(): Promise<void> {
    const lock = this.wakeLock
    this.wakeLock = undefined
    if (lock && !lock.released) {
      await lock.release()
    }
  }

  private runSensorRead<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.sensorReadChain.then(operation, operation)
    this.sensorReadChain = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  private log(level: DiagnosticEntry['level'], message: string): void {
    const entry: DiagnosticEntry = {
      id: ++this.diagnosticId,
      timestamp: Date.now(),
      level,
      message: message.slice(0, 300),
    }
    this.patch({
      diagnostics: [...this.snapshotValue.diagnostics.slice(-99), entry],
    })
  }

  private patch(update: Partial<ControllerSnapshot>): void {
    this.snapshotValue = { ...this.snapshotValue, ...update }
    for (const listener of this.listeners) {
      listener(this.snapshotValue)
    }
  }
}

function parseHexColor(value: string): { red: number; green: number; blue: number } {
  if (!/^#[\da-f]{6}$/i.test(value)) {
    throw new TypeError('Color must use #RRGGBB format')
  }
  return {
    red: Number.parseInt(value.slice(1, 3), 16),
    green: Number.parseInt(value.slice(3, 5), 16),
    blue: Number.parseInt(value.slice(5, 7), 16),
  }
}

export function legacyDrivePacketForTest(left: number, right: number, durationMs: number): Uint8Array {
  return encodeLegacyDrive(left, right, durationMs)
}
