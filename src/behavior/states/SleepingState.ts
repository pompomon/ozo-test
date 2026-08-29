import {
  BEHAVIOR_PRIORITY,
  type BehaviorContext,
  type BehaviorState,
  type RobotAction,
} from '../types.ts'
import { noExitActions, repeat } from './helpers.ts'

function sleepingPlan(context: BehaviorContext): readonly RobotAction[] {
  return [
    { type: 'STOP_MOTION' },
    { type: 'STOP_SOUND' },
    { type: 'LIGHTS', mask: 0xff, color: '#173a63', brightness: 8 },
    { type: 'WAIT', durationMs: context.config.ambientMaxWaitMs },
  ]
}

export const SleepingState: BehaviorState = {
  id: 'SLEEPING',
  enter: sleepingPlan,
  update() {
    return undefined
  },
  handleEvent(context, event) {
    if (event.type === 'STATE_COMPLETED') {
      return repeat(sleepingPlan(context), BEHAVIOR_PRIORITY.ambient)
    }
    return undefined
  },
  exit: noExitActions,
}
