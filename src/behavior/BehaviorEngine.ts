import type { BehaviorConfig } from './config.ts'
import { AngryState } from './states/AngryState.ts'
import { BoredState } from './states/BoredState.ts'
import { CuriousState } from './states/CuriousState.ts'
import { DancingState } from './states/DancingState.ts'
import { ExcitedState } from './states/ExcitedState.ts'
import { IdleState } from './states/IdleState.ts'
import { ScaredState } from './states/ScaredState.ts'
import { SleepingState } from './states/SleepingState.ts'
import {
  BEHAVIOR_PRIORITY,
  type BehaviorContext,
  type BehaviorDecision,
  type BehaviorEngineSnapshot,
  type BehaviorEvent,
  type BehaviorState,
  type BehaviorStateId,
  type BehaviorTransition,
  type Clock,
  type ObstacleReading,
  type RandomSource,
  type StateResult,
} from './types.ts'

const STATES: Readonly<Record<BehaviorStateId, BehaviorState>> = {
  IDLE: IdleState,
  CURIOUS: CuriousState,
  EXCITED: ExcitedState,
  SCARED: ScaredState,
  ANGRY: AngryState,
  BORED: BoredState,
  SLEEPING: SleepingState,
  DANCING: DancingState,
}

export class BehaviorEngine {
  private readonly config: BehaviorConfig
  private readonly clock: Clock
  private readonly random: RandomSource
  private running = false
  private currentStateValue: BehaviorStateId = 'IDLE'
  private stateEnteredAt = 0
  private lastInteractionAt = 0
  private lastTransition?: BehaviorTransition
  private obstacleActive = false
  private obstacle?: ObstacleReading
  private pickedUp = false
  private obstacleDetections: number[] = []
  private boredSinceInteraction = false

  constructor(config: BehaviorConfig, clock: Clock, random: RandomSource) {
    this.config = config
    this.clock = clock
    this.random = random
  }

  get snapshot(): BehaviorEngineSnapshot {
    return {
      running: this.running,
      currentState: this.currentStateValue,
      stateEnteredAt: this.stateEnteredAt,
      lastInteractionAt: this.lastInteractionAt,
      lastTransition: this.lastTransition,
      obstacleActive: this.obstacleActive,
      pickedUp: this.pickedUp,
    }
  }

  start(): BehaviorDecision {
    const now = this.clock.now()
    this.running = true
    this.currentStateValue = 'IDLE'
    this.stateEnteredAt = now
    this.lastInteractionAt = now
    this.lastTransition = undefined
    this.obstacleActive = false
    this.obstacle = undefined
    this.pickedUp = false
    this.obstacleDetections = []
    this.boredSinceInteraction = false
    return {
      actions: STATES.IDLE.enter(this.context(now)),
      priority: BEHAVIOR_PRIORITY.ambient,
    }
  }

  stop(): void {
    this.running = false
  }

  handleEvent(event: BehaviorEvent): BehaviorDecision | undefined {
    if (!this.running) return undefined
    this.updateWorld(event)

    if (event.type === 'SENSOR_STALE') {
      return {
        actions: [{ type: 'STOP_MOTION' }, { type: 'STOP_SOUND' }],
        priority: BEHAVIOR_PRIORITY.safety,
      }
    }
    if (event.type === 'PICKED_UP') {
      return this.transitionTo('SCARED', 'robot picked up', event.at, BEHAVIOR_PRIORITY.hazard)
    }
    if (event.type === 'OBSTACLE_DETECTED') {
      const target =
        this.obstacleDetections.length >= this.config.repeatedObstacleCount ? 'ANGRY' : 'SCARED'
      const reason = target === 'ANGRY' ? 'repeated obstacle detections' : 'obstacle detected'
      return this.transitionTo(target, reason, event.at, BEHAVIOR_PRIORITY.hazard)
    }
    if (
      (event.type === 'USER_INTERACTION' || event.type === 'BUTTON_PRESSED') &&
      !this.obstacleActive &&
      !this.pickedUp
    ) {
      return this.transitionTo('EXCITED', 'user interaction', event.at, BEHAVIOR_PRIORITY.interaction)
    }
    if (event.type === 'DANCE_REQUESTED' && !this.obstacleActive && !this.pickedUp) {
      return this.transitionTo('DANCING', 'dance requested', event.at, BEHAVIOR_PRIORITY.interaction)
    }
    if (event.type === 'STATE_COMPLETED' && event.state !== this.currentStateValue) {
      return undefined
    }

    const context = this.context(event.at)
    if (event.type === 'TICK' && !this.obstacleActive && !this.pickedUp) {
      if (
        context.inactivityMs >= this.config.sleepAfterMs &&
        this.currentStateValue !== 'SLEEPING'
      ) {
        return this.transitionTo('SLEEPING', 'prolonged inactivity', event.at, BEHAVIOR_PRIORITY.timer)
      }
      if (
        context.inactivityMs >= this.config.boredAfterMs &&
        !this.boredSinceInteraction &&
        !['BORED', 'SLEEPING'].includes(this.currentStateValue)
      ) {
        return this.transitionTo('BORED', 'interaction inactivity', event.at, BEHAVIOR_PRIORITY.timer)
      }
    }

    const state = STATES[this.currentStateValue]
    const result =
      event.type === 'TICK'
        ? state.update(context)
        : state.handleEvent(context, event)
    return this.applyResult(result, event.at)
  }

  private updateWorld(event: BehaviorEvent): void {
    if (event.type === 'USER_INTERACTION' || event.type === 'DANCE_REQUESTED') {
      this.lastInteractionAt = event.at
      this.boredSinceInteraction = false
    } else if (event.type === 'BUTTON_PRESSED') {
      this.lastInteractionAt = event.at
      this.boredSinceInteraction = false
    } else if (event.type === 'OBSTACLE_DETECTED') {
      this.obstacleActive = true
      this.obstacle = event.reading
      const earliest = event.at - this.config.repeatedObstacleWindowMs
      this.obstacleDetections = [
        ...this.obstacleDetections.filter((detectedAt) => detectedAt >= earliest),
        event.at,
      ]
    } else if (event.type === 'OBSTACLE_UPDATED') {
      this.obstacle = event.reading
    } else if (event.type === 'OBSTACLE_CLEARED') {
      this.obstacleActive = false
      this.obstacle = event.reading
    } else if (event.type === 'PICKED_UP') {
      this.pickedUp = true
    } else if (event.type === 'PUT_DOWN') {
      this.pickedUp = false
    }
  }

  private applyResult(result: StateResult | undefined, now: number): BehaviorDecision | undefined {
    if (!result) return undefined
    if (result.transitionTo) {
      return this.transitionTo(
        result.transitionTo,
        result.reason ?? 'state transition',
        now,
        result.priority ?? BEHAVIOR_PRIORITY.timer,
      )
    }
    if (!result.actions || result.actions.length === 0) return undefined
    return {
      actions: result.actions,
      priority: result.priority ?? BEHAVIOR_PRIORITY.ambient,
    }
  }

  private transitionTo(
    nextState: BehaviorStateId,
    reason: string,
    now: number,
    priority: number,
  ): BehaviorDecision {
    const previousState = this.currentStateValue
    const exitActions = STATES[previousState].exit(this.context(now))
    this.currentStateValue = nextState
    if (nextState === 'BORED') this.boredSinceInteraction = true
    this.stateEnteredAt = now
    const transition: BehaviorTransition = {
      from: previousState,
      to: nextState,
      reason,
      at: now,
    }
    this.lastTransition = transition
    const enterActions = STATES[nextState].enter(this.context(now))
    return {
      actions: [...exitActions, ...enterActions],
      priority,
      transition,
    }
  }

  private context(now: number): BehaviorContext {
    return {
      now,
      state: this.currentStateValue,
      stateElapsedMs: Math.max(0, now - this.stateEnteredAt),
      inactivityMs: Math.max(0, now - this.lastInteractionAt),
      obstacleActive: this.obstacleActive,
      obstacle: this.obstacle,
      pickedUp: this.pickedUp,
      config: this.config,
      random: this.random,
    }
  }
}
