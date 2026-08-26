import type { ControllerSnapshot, EvoController } from '../controller/EvoController.ts'
import type { ReactiveSensors } from '../protocol/telemetry.ts'
import { ActionScheduler } from './ActionScheduler.ts'
import { BehaviorEngine } from './BehaviorEngine.ts'
import {
  createBehaviorConfig,
  createSessionSeed,
  SeededRandom,
  systemClock,
  type BehaviorConfig,
} from './config.ts'
import { EvoBehaviorAdapter } from './EvoBehaviorAdapter.ts'
import { TelemetryEventSource } from './TelemetryEventSource.ts'
import type {
  BehaviorDecision,
  BehaviorEvent,
  BehaviorRuntimeSnapshot,
  Clock,
  RandomSource,
} from './types.ts'

type RuntimeHandler = (snapshot: BehaviorRuntimeSnapshot) => void

export interface BehaviorRuntimeOptions {
  readonly config?: Partial<BehaviorConfig>
  readonly clock?: Clock
  readonly random?: RandomSource
  readonly seed?: number
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class BehaviorRuntime {
  private readonly controller: EvoController
  private readonly config: BehaviorConfig
  private readonly clock: Clock
  private readonly engine: BehaviorEngine
  private readonly eventSource: TelemetryEventSource
  private readonly scheduler: ActionScheduler
  private readonly listeners = new Set<RuntimeHandler>()
  private snapshotValue: BehaviorRuntimeSnapshot
  private unsubscribeController?: () => void
  private stopReactivePolling?: () => void
  private tickTimer?: ReturnType<typeof setTimeout>
  private eventChain: Promise<void> = Promise.resolve()
  private startupEvents: BehaviorEvent[] = []
  private startupPolling?: Promise<void>
  private lifecycleGeneration = 0
  private stoppingPromise?: Promise<void>
  private disposed = false

  constructor(controller: EvoController, options: BehaviorRuntimeOptions = {}) {
    this.controller = controller
    this.config = createBehaviorConfig(options.config)
    this.clock = options.clock ?? systemClock
    const seed = options.seed ?? createSessionSeed()
    const random = options.random ?? new SeededRandom(seed)
    this.engine = new BehaviorEngine(this.config, this.clock, random)
    this.eventSource = new TelemetryEventSource(this.config, this.clock)
    this.scheduler = new ActionScheduler(new EvoBehaviorAdapter(controller))
    this.snapshotValue = {
      status: 'disabled',
      state: 'IDLE',
      sessionSeed: seed,
      movementEnabled: this.config.movementEnabled,
    }
  }

  get snapshot(): BehaviorRuntimeSnapshot {
    return this.snapshotValue
  }

  start(): void {
    if (this.unsubscribeController || this.disposed) return
    this.unsubscribeController = this.controller.subscribe((snapshot) => {
      this.handleControllerSnapshot(snapshot)
    })
  }

  subscribe(handler: RuntimeHandler): () => void {
    this.listeners.add(handler)
    handler(this.snapshotValue)
    return () => this.listeners.delete(handler)
  }

  async enable(): Promise<void> {
    if (this.disposed) throw new Error('Behavior runtime is closed')
    this.start()
    if (['starting', 'running', 'stopping'].includes(this.snapshotValue.status)) return
    if (this.controller.snapshot.phase !== 'armed') {
      throw new Error('Arm Evo before enabling its personality')
    }

    const generation = ++this.lifecycleGeneration
    this.patch({ status: 'starting', error: undefined })
    this.eventSource.reset(this.clock.now())
    this.startupEvents = []
    try {
      await this.controller.stopMotion()
      await this.controller.stopSound()
      if (this.controller.snapshot.phase !== 'armed') {
        throw new Error('Motor control ended while personality mode was starting')
      }
      const startupPolling = this.controller.startReactiveSensorPolling(
        (sensors) => this.handleSensors(sensors),
        () => this.handleSensorReadFailure(),
        this.config.reactiveSensorIntervalMs,
      ).then((stopReactivePolling) => {
        if (
          generation !== this.lifecycleGeneration ||
          this.controller.snapshot.phase !== 'armed' ||
          this.snapshotValue.status !== 'starting'
        ) {
          stopReactivePolling()
          throw new Error('Personality mode was interrupted while starting')
        }
        this.stopReactivePolling = stopReactivePolling
      })
      this.startupPolling = startupPolling
      try {
        await startupPolling
      } finally {
        if (this.startupPolling === startupPolling) this.startupPolling = undefined
      }

      const decision = this.engine.start()
      this.patch({
        status: 'running',
        state: this.engine.snapshot.currentState,
        lastTransition: undefined,
        error: undefined,
      })
      this.scheduleTick()
      this.applyDecision(decision)
      for (const event of this.startupEvents.splice(0)) this.enqueueEvent(event)
    } catch (error) {
      if (generation !== this.lifecycleGeneration) throw error
      return this.beginStopping(async () => {
        this.patch({ status: 'stopping', error: messageOf(error) })
        this.stopAutonomyInputs()
        this.engine.stop()
        try {
          await this.scheduler.cancel()
        } catch {
          // The original startup failure remains the actionable error.
        }
        let message = messageOf(error)
        try {
          await this.controller.emergencyStop('Personality mode could not start')
        } catch (stopError) {
          message = `${message}; stop failed: ${messageOf(stopError)}`
        }
        if (generation === this.lifecycleGeneration) {
          this.patch({ status: 'faulted', state: 'IDLE', error: message })
        }
        throw error
      })
    }
  }

  async disable(): Promise<void> {
    if (this.snapshotValue.status === 'disabled') return
    if (this.snapshotValue.status === 'stopping') {
      await this.stoppingPromise
      return
    }
    return this.beginStopping(async () => {
      const generation = ++this.lifecycleGeneration
      this.patch({ status: 'stopping' })
      this.stopAutonomyInputs()
      this.engine.stop()
      await this.finishDisable(generation)
    })
  }

  async disarm(): Promise<void> {
    await this.disable()
    await this.controller.disarm()
  }

  async disconnect(): Promise<void> {
    try {
      await this.disable()
    } finally {
      await this.controller.disconnect()
    }
  }

  async emergencyStop(reason = 'Emergency stop pressed'): Promise<void> {
    return this.beginStopping(async () => {
      const generation = ++this.lifecycleGeneration
      this.patch({ status: 'stopping' })
      this.stopAutonomyInputs()
      this.engine.stop()
      const cancellation = this.scheduler.cancel()
      const stop = this.controller.emergencyStop(reason)
      const [cancelResult, stopResult] = await Promise.allSettled([cancellation, stop])
      if (cancelResult.status === 'rejected' || stopResult.status === 'rejected') {
        const error =
          cancelResult.status === 'rejected' ? cancelResult.reason : stopResult.status === 'rejected' ? stopResult.reason : undefined
        const message = `Emergency stop cleanup failed: ${messageOf(error)}`
        if (generation === this.lifecycleGeneration) {
          this.patch({ status: 'faulted', error: message })
        }
        throw new Error(message)
      }
      if (generation === this.lifecycleGeneration) {
        this.patch({ status: 'disabled', state: 'IDLE', error: undefined })
      }
    })
  }

  notifyInteraction(): void {
    this.enqueueEvent({ type: 'USER_INTERACTION', source: 'ui', at: this.clock.now() })
  }

  requestDance(): void {
    this.enqueueEvent({ type: 'DANCE_REQUESTED', at: this.clock.now() })
  }

  async stop(): Promise<void> {
    this.unsubscribeController?.()
    this.unsubscribeController = undefined
    await this.disable()
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    try {
      await this.stop()
    } finally {
      this.listeners.clear()
    }
  }

  private handleSensors(sensors: ReactiveSensors): void {
    const events = this.eventSource.ingest(sensors, this.clock.now())
    if (this.snapshotValue.status === 'starting') {
      this.startupEvents.push(...events)
      return
    }
    if (this.snapshotValue.status !== 'running') return
    for (const event of events) this.enqueueEvent(event)
  }

  private handleSensorReadFailure(): void {
    if (this.snapshotValue.status !== 'running') return
    const stale = this.eventSource.checkStale(this.clock.now())
    if (stale) this.enqueueEvent(stale)
  }

  private handleControllerSnapshot(snapshot: ControllerSnapshot): void {
    if (
      !['starting', 'running'].includes(this.snapshotValue.status) ||
      snapshot.phase === 'armed'
    ) {
      return
    }
    const generation = ++this.lifecycleGeneration
    this.stopAutonomyInputs()
    this.engine.stop()
    const fault = snapshot.phase === 'error' ? snapshot.error ?? 'Evo disconnected unexpectedly' : undefined
    void this.beginStopping(async () => {
      this.patch({ status: 'stopping', error: fault })
      await this.finishControllerStop(generation, fault)
    })
  }

  private async finishControllerStop(generation: number, fault?: string): Promise<void> {
    try {
      await this.scheduler.cancel()
      if (generation === this.lifecycleGeneration) {
        this.patch({
          status: fault ? 'faulted' : 'disabled',
          state: 'IDLE',
          error: fault,
        })
      }
    } catch (error) {
      if (generation === this.lifecycleGeneration) {
        this.patch({
          status: 'faulted',
          state: 'IDLE',
          error: `Personality cleanup failed: ${messageOf(error)}`,
        })
      }
    }
  }

  private enqueueEvent(event: BehaviorEvent): void {
    this.eventChain = this.eventChain
      .then(() => {
        if (this.snapshotValue.status !== 'running') return
        if (event.type === 'SENSOR_STALE') {
          void this.failSafe('Reactive sensor data became stale')
          return
        }
        const decision = this.engine.handleEvent(event)
        this.patch({
          state: this.engine.snapshot.currentState,
          lastTransition: this.engine.snapshot.lastTransition,
        })
        if (decision) this.applyDecision(decision)
      })
      .catch((error: unknown) => {
        void this.failSafe(`Behavior event failed: ${messageOf(error)}`)
      })
  }

  private applyDecision(decision: BehaviorDecision): void {
    if (this.snapshotValue.status !== 'running' || decision.actions.length === 0) return
    const state = this.engine.snapshot.currentState
    const ticket = this.scheduler.schedule(
      decision.actions,
      decision.priority,
      decision.transition !== undefined,
    )
    if (!ticket.accepted) return
    void ticket.completion
      .then((outcome) => {
        if (outcome === 'completed' && this.snapshotValue.status === 'running') {
          this.enqueueEvent({ type: 'STATE_COMPLETED', state, at: this.clock.now() })
        }
      })
      .catch((error: unknown) => {
        void this.failSafe(`Behavior action failed: ${messageOf(error)}`)
      })
  }

  private scheduleTick(): void {
    if (this.snapshotValue.status !== 'running') return
    this.tickTimer = setTimeout(() => {
      if (this.snapshotValue.status !== 'running') return
      const now = this.clock.now()
      const stale = this.eventSource.checkStale(now)
      if (stale) {
        this.enqueueEvent(stale)
      } else {
        this.enqueueEvent({ type: 'TICK', at: now })
      }
      this.scheduleTick()
    }, this.config.engineTickMs)
  }

  private stopAutonomyInputs(): void {
    if (this.tickTimer) clearTimeout(this.tickTimer)
    this.tickTimer = undefined
    this.stopReactivePolling?.()
    this.stopReactivePolling = undefined
  }

  private async failSafe(reason: string): Promise<void> {
    if (!['starting', 'running'].includes(this.snapshotValue.status)) return
    return this.beginStopping(async () => {
      const generation = ++this.lifecycleGeneration
      this.patch({ status: 'stopping', error: reason })
      this.stopAutonomyInputs()
      this.engine.stop()
      try {
        await this.scheduler.cancel()
      } catch {
        // Emergency stop below is still required.
      }
      try {
        await this.controller.emergencyStop(reason)
      } catch (error) {
        if (generation === this.lifecycleGeneration) {
          this.patch({
            status: 'faulted',
            error: `${reason}; stop failed: ${messageOf(error)}`,
          })
        }
        return
      }
      if (generation === this.lifecycleGeneration) {
        this.patch({ status: 'faulted', state: 'IDLE', error: reason })
      }
    })
  }

  private beginStopping(operation: () => Promise<void>): Promise<void> {
    if (this.stoppingPromise) return this.stoppingPromise
    let resolve!: () => void
    let reject!: (error: unknown) => void
    const tracked = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise
      reject = rejectPromise
    })
    this.stoppingPromise = tracked
    try {
      operation().then(resolve, reject)
    } catch (error) {
      reject(error)
    }
    void tracked.then(
      () => {
        if (this.stoppingPromise === tracked) this.stoppingPromise = undefined
      },
      () => {
        if (this.stoppingPromise === tracked) this.stoppingPromise = undefined
      },
    )
    return tracked
  }

  private async finishDisable(generation: number): Promise<void> {
    try {
      const startupPolling = this.startupPolling
      if (startupPolling) await startupPolling.catch(() => undefined)
      await this.scheduler.cancel()
      if (generation === this.lifecycleGeneration) {
        this.patch({ status: 'disabled', state: 'IDLE', error: undefined })
      }
    } catch (error) {
      if (generation !== this.lifecycleGeneration) return
      let message = `Could not stop personality mode safely: ${messageOf(error)}`
      try {
        await this.controller.emergencyStop('Personality cleanup failed')
      } catch (stopError) {
        message = `${message}; stop failed: ${messageOf(stopError)}`
      }
      if (generation === this.lifecycleGeneration) {
        this.patch({ status: 'faulted', error: message })
      }
      throw new Error(message)
    }
  }

  private patch(update: Partial<BehaviorRuntimeSnapshot>): void {
    this.snapshotValue = { ...this.snapshotValue, ...update }
    for (const listener of this.listeners) listener(this.snapshotValue)
  }
}
