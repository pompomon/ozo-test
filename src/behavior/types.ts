import type { BehaviorConfig } from './config.ts'

export const BEHAVIOR_STATES = [
  'IDLE',
  'CURIOUS',
  'EXCITED',
  'SCARED',
  'ANGRY',
  'BORED',
  'SLEEPING',
  'DANCING',
] as const

export type BehaviorStateId = (typeof BEHAVIOR_STATES)[number]

export const BEHAVIOR_PRIORITY = {
  ambient: 10,
  timer: 20,
  completion: 30,
  interaction: 60,
  hazard: 80,
  safety: 100,
} as const

export interface Clock {
  now(): number
}

export interface RandomSource {
  next(): number
}

export interface ObstacleReading {
  readonly leftRear: number
  readonly leftFront: number
  readonly rightRear: number
  readonly rightFront: number
}

export type InteractionSource = 'ui' | 'button'

export type BehaviorEvent =
  | { readonly type: 'TICK'; readonly at: number }
  | {
      readonly type: 'USER_INTERACTION'
      readonly at: number
      readonly source: InteractionSource
    }
  | { readonly type: 'DANCE_REQUESTED'; readonly at: number }
  | {
      readonly type: 'OBSTACLE_DETECTED'
      readonly at: number
      readonly reading: ObstacleReading
    }
  | {
      readonly type: 'OBSTACLE_CLEARED'
      readonly at: number
      readonly reading: ObstacleReading
    }
  | { readonly type: 'PICKED_UP'; readonly at: number }
  | { readonly type: 'PUT_DOWN'; readonly at: number }
  | { readonly type: 'BUTTON_PRESSED'; readonly at: number; readonly press: string }
  | { readonly type: 'SENSOR_STALE'; readonly at: number; readonly lastReceivedAt?: number }
  | { readonly type: 'STATE_COMPLETED'; readonly at: number; readonly state: BehaviorStateId }

export type RobotAction =
  | {
      readonly type: 'DRIVE'
      readonly left: number
      readonly right: number
      readonly durationMs: number
    }
  | {
      readonly type: 'LIGHTS'
      readonly mask: number
      readonly color: string
      readonly brightness: number
    }
  | {
      readonly type: 'TONE'
      readonly frequencyHz: number
      readonly durationMs: number
    }
  | { readonly type: 'WAIT'; readonly durationMs: number }
  | { readonly type: 'STOP_MOTION' }
  | { readonly type: 'STOP_SOUND' }

export interface BehaviorTransition {
  readonly from: BehaviorStateId
  readonly to: BehaviorStateId
  readonly reason: string
  readonly at: number
}

export interface BehaviorDecision {
  readonly actions: readonly RobotAction[]
  readonly priority: number
  readonly transition?: BehaviorTransition
}

export interface BehaviorContext {
  readonly now: number
  readonly state: BehaviorStateId
  readonly stateElapsedMs: number
  readonly inactivityMs: number
  readonly obstacleActive: boolean
  readonly obstacle?: ObstacleReading
  readonly pickedUp: boolean
  readonly config: BehaviorConfig
  readonly random: RandomSource
}

export interface StateResult {
  readonly actions?: readonly RobotAction[]
  readonly transitionTo?: BehaviorStateId
  readonly reason?: string
  readonly priority?: number
}

export interface BehaviorState {
  readonly id: BehaviorStateId
  enter(context: BehaviorContext): readonly RobotAction[]
  update(context: BehaviorContext): StateResult | undefined
  handleEvent(context: BehaviorContext, event: BehaviorEvent): StateResult | undefined
  exit(context: BehaviorContext): readonly RobotAction[]
}

export interface BehaviorEngineSnapshot {
  readonly running: boolean
  readonly currentState: BehaviorStateId
  readonly stateEnteredAt: number
  readonly lastInteractionAt: number
  readonly lastTransition?: BehaviorTransition
  readonly obstacleActive: boolean
  readonly pickedUp: boolean
}

export type BehaviorRuntimeStatus =
  | 'disabled'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'faulted'

export interface BehaviorRuntimeSnapshot {
  readonly status: BehaviorRuntimeStatus
  readonly state: BehaviorStateId
  readonly lastTransition?: BehaviorTransition
  readonly error?: string
  readonly sessionSeed: number
  readonly movementEnabled: boolean
}

export interface RobotActionPort {
  execute(action: RobotAction, signal: AbortSignal): Promise<void>
  cleanup(): Promise<void>
}
