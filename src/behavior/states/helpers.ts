import type { BehaviorConfig } from '../config.ts'
import type {
  BehaviorContext,
  ObstacleReading,
  RobotAction,
  StateResult,
} from '../types.ts'

export const stopActions: readonly RobotAction[] = [
  { type: 'STOP_MOTION' },
  { type: 'STOP_SOUND' },
]

export function noExitActions(): readonly RobotAction[] {
  return []
}

export function waitDuration(context: BehaviorContext): number {
  const { ambientMinWaitMs, ambientMaxWaitMs } = context.config
  return Math.round(
    ambientMinWaitMs + context.random.next() * (ambientMaxWaitMs - ambientMinWaitMs),
  )
}

export function movement(
  config: BehaviorConfig,
  left: number,
  right: number,
  durationMs: number,
): readonly RobotAction[] {
  return config.movementEnabled ? [{ type: 'DRIVE', left, right, durationMs }] : []
}

export function transition(
  transitionTo: StateResult['transitionTo'],
  reason: string,
  priority: number,
): StateResult {
  return { transitionTo, reason, priority }
}

export function repeat(actions: readonly RobotAction[], priority: number): StateResult {
  return { actions, priority }
}

export function isNear(value: number, config: BehaviorConfig): boolean {
  return config.nearerIsHigher
    ? value >= config.obstacleThreshold
    : value <= config.obstacleThreshold
}

export function rearIsClear(reading: ObstacleReading | undefined, config: BehaviorConfig): boolean {
  return (
    reading !== undefined &&
    (config.nearerIsHigher
      ? reading.leftRear <= config.obstacleClearThreshold
      : reading.leftRear >= config.obstacleClearThreshold) &&
    (config.nearerIsHigher
      ? reading.rightRear <= config.obstacleClearThreshold
      : reading.rightRear >= config.obstacleClearThreshold)
  )
}

export function turnAwayDirection(
  reading: ObstacleReading | undefined,
  config: BehaviorConfig,
  fallback: number,
): number {
  if (!reading || reading.leftFront === reading.rightFront) return fallback
  const leftIsCloser = config.nearerIsHigher
    ? reading.leftFront > reading.rightFront
    : reading.leftFront < reading.rightFront
  return leftIsCloser ? 1 : -1
}
