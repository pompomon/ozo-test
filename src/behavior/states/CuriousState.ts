import {
  BEHAVIOR_PRIORITY,
  type BehaviorContext,
  type BehaviorState,
  type RobotAction,
} from '../types.ts'
import { movement, noExitActions, repeat, transition } from './helpers.ts'

function curiousPlan(context: BehaviorContext): readonly RobotAction[] {
  const direction = context.random.next() < 0.5 ? -1 : 1
  const speed = context.config.curiousSpeed
  return [
    { type: 'LIGHTS', mask: 0xff, color: '#42d9f5', brightness: 42 },
    ...movement(context.config, speed, speed, 650),
    { type: 'STOP_MOTION' },
    { type: 'WAIT', durationMs: 450 },
    ...movement(context.config, direction * speed, -direction * speed, 420),
    { type: 'STOP_MOTION' },
    { type: 'WAIT', durationMs: 650 },
  ]
}

export const CuriousState: BehaviorState = {
  id: 'CURIOUS',
  enter: curiousPlan,
  update(context) {
    if (context.stateElapsedMs >= context.config.curiousDurationMs) {
      return transition('IDLE', 'curiosity period completed', BEHAVIOR_PRIORITY.timer)
    }
    return undefined
  },
  handleEvent(context, event) {
    if (event.type === 'STATE_COMPLETED') {
      return repeat(curiousPlan(context), BEHAVIOR_PRIORITY.ambient)
    }
    return undefined
  },
  exit: noExitActions,
}
