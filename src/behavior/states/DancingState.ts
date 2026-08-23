import {
  BEHAVIOR_PRIORITY,
  type BehaviorContext,
  type BehaviorState,
  type RobotAction,
} from '../types.ts'
import { movement, noExitActions, transition } from './helpers.ts'

function dancingPlan(context: BehaviorContext): readonly RobotAction[] {
  const speed = context.config.danceSpeed
  return [
    { type: 'LIGHTS', mask: 0xff, color: '#ff3bd4', brightness: 90 },
    { type: 'TONE', frequencyHz: 392, durationMs: 140 },
    ...movement(context.config, speed, -speed, 380),
    { type: 'STOP_MOTION' },
    { type: 'LIGHTS', mask: 0xff, color: '#42f5c8', brightness: 95 },
    { type: 'TONE', frequencyHz: 523, durationMs: 140 },
    ...movement(context.config, -speed, speed, 380),
    { type: 'STOP_MOTION' },
    { type: 'LIGHTS', mask: 0xff, color: '#f5e642', brightness: 100 },
    { type: 'TONE', frequencyHz: 659, durationMs: 180 },
    ...movement(context.config, speed, speed * 0.25, 350),
    { type: 'STOP_MOTION' },
    { type: 'WAIT', durationMs: 250 },
  ]
}

export const DancingState: BehaviorState = {
  id: 'DANCING',
  enter: dancingPlan,
  update() {
    return undefined
  },
  handleEvent(_context, event) {
    if (event.type === 'STATE_COMPLETED') {
      return transition('EXCITED', 'dance completed', BEHAVIOR_PRIORITY.completion)
    }
    return undefined
  },
  exit: noExitActions,
}
