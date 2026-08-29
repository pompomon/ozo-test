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

function angryPlan(context: BehaviorContext): readonly RobotAction[] {
  const speed = context.config.angrySpeed
  const fallback = context.random.next() < 0.5 ? -1 : 1
  const turn = turnAwayDirection(context.obstacle, context.config, fallback)
  return [
    { type: 'STOP_MOTION' },
    { type: 'LIGHTS', mask: 0xff, color: '#ff6a00', brightness: 95 },
    { type: 'TONE', frequencyHz: 330, durationMs: 180 },
    { type: 'TONE', frequencyHz: 294, durationMs: 220 },
    ...(!context.pickedUp && rearIsClear(context.obstacle, context.config)
      ? movement(context.config, turn * speed, -turn * speed, 480)
      : []),
    { type: 'STOP_MOTION' },
    { type: 'WAIT', durationMs: 700 },
  ]
}

export const AngryState: BehaviorState = {
  id: 'ANGRY',
  enter: angryPlan,
  update(context) {
    if (
      !context.obstacleActive &&
      !context.pickedUp &&
      context.stateElapsedMs >= context.config.angryCooldownMs
    ) {
      return transition('IDLE', 'anger cooldown completed', BEHAVIOR_PRIORITY.timer)
    }
    return undefined
  },
  handleEvent(context, event) {
    if (event.type === 'STATE_COMPLETED') {
      return repeat(angryPlan(context), BEHAVIOR_PRIORITY.hazard)
    }
    return undefined
  },
  exit: noExitActions,
}
