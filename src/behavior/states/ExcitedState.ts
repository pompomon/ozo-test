import {
  BEHAVIOR_PRIORITY,
  type BehaviorContext,
  type BehaviorState,
  type RobotAction,
} from '../types.ts'
import { movement, noExitActions, transition } from './helpers.ts'

function excitedPlan(context: BehaviorContext): readonly RobotAction[] {
  const speed = context.config.excitedSpeed
  return [
    { type: 'LIGHTS', mask: 0xff, color: '#72ff5f', brightness: 80 },
    { type: 'TONE', frequencyHz: 523, durationMs: 160 },
    ...movement(context.config, speed, -speed, 300),
    { type: 'STOP_MOTION' },
    { type: 'LIGHTS', mask: 0xff, color: '#f5e642', brightness: 90 },
    { type: 'TONE', frequencyHz: 659, durationMs: 160 },
    ...movement(context.config, -speed, speed, 300),
    { type: 'STOP_MOTION' },
    { type: 'WAIT', durationMs: 300 },
  ]
}

export const ExcitedState: BehaviorState = {
  id: 'EXCITED',
  enter: excitedPlan,
  update(context) {
    if (context.stateElapsedMs >= context.config.excitedDurationMs) {
      return transition('CURIOUS', 'excitement timer elapsed', BEHAVIOR_PRIORITY.timer)
    }
    return undefined
  },
  handleEvent(_context, event) {
    if (event.type === 'STATE_COMPLETED') {
      return transition('CURIOUS', 'excited sequence completed', BEHAVIOR_PRIORITY.completion)
    }
    return undefined
  },
  exit: noExitActions,
}
