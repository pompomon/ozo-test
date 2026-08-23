import {
  BEHAVIOR_PRIORITY,
  type BehaviorContext,
  type BehaviorState,
  type RobotAction,
} from '../types.ts'
import { movement, noExitActions, repeat, transition, waitDuration } from './helpers.ts'

function idlePlan(context: BehaviorContext): readonly RobotAction[] {
  const choice = context.random.next()
  const ambient: readonly RobotAction[] =
    choice < 0.34
      ? [{ type: 'TONE', frequencyHz: 262, durationMs: 120 }]
      : choice < 0.67
        ? [{ type: 'LIGHTS', mask: 0xff, color: '#42f5c8', brightness: 24 }]
        : movement(context.config, 0.12, -0.12, 180)
  return [
    { type: 'STOP_MOTION' },
    { type: 'LIGHTS', mask: 0xff, color: '#247b72', brightness: 18 },
    { type: 'WAIT', durationMs: waitDuration(context) },
    ...ambient,
    { type: 'WAIT', durationMs: 350 },
  ]
}

export const IdleState: BehaviorState = {
  id: 'IDLE',
  enter: idlePlan,
  update(context) {
    if (context.stateElapsedMs >= context.config.idleToCuriousMs) {
      return transition('CURIOUS', 'idle curiosity timer elapsed', BEHAVIOR_PRIORITY.timer)
    }
    return undefined
  },
  handleEvent(context, event) {
    if (event.type === 'STATE_COMPLETED') {
      return repeat(idlePlan(context), BEHAVIOR_PRIORITY.ambient)
    }
    return undefined
  },
  exit: noExitActions,
}
