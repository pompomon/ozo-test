import {
  BEHAVIOR_PRIORITY,
  type BehaviorContext,
  type BehaviorState,
  type RobotAction,
} from '../types.ts'
import {
  movement,
  noExitActions,
  rearIsClear,
  repeat,
  transition,
  turnAwayDirection,
} from './helpers.ts'

function scaredPlan(context: BehaviorContext): readonly RobotAction[] {
  const speed = context.config.scaredSpeed
  const fallback = context.random.next() < 0.5 ? -1 : 1
  const turn = turnAwayDirection(context.obstacle, context.config, fallback)
  const escape =
    !context.pickedUp && rearIsClear(context.obstacle, context.config)
      ? [
          ...movement(context.config, -speed, -speed, 420),
          { type: 'STOP_MOTION' } as const,
          ...movement(context.config, turn * speed, -turn * speed, 520),
          { type: 'STOP_MOTION' } as const,
        ]
      : []
  return [
    { type: 'STOP_MOTION' },
    { type: 'STOP_SOUND' },
    { type: 'LIGHTS', mask: 0xff, color: '#ff2138', brightness: 100 },
    { type: 'TONE', frequencyHz: 880, durationMs: 220 },
    ...escape,
    { type: 'WAIT', durationMs: 500 },
  ]
}

export const ScaredState: BehaviorState = {
  id: 'SCARED',
  enter: scaredPlan,
  update(context) {
    if (
      !context.obstacleActive &&
      !context.pickedUp &&
      context.stateElapsedMs >= context.config.scaredCooldownMs
    ) {
      return transition('CURIOUS', 'hazard cleared', BEHAVIOR_PRIORITY.timer)
    }
    return undefined
  },
  handleEvent(context, event) {
    if (event.type === 'STATE_COMPLETED') {
      return repeat(scaredPlan(context), BEHAVIOR_PRIORITY.hazard)
    }
    return undefined
  },
  exit: noExitActions,
}
