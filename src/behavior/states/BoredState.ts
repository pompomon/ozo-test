import {
  BEHAVIOR_PRIORITY,
  type BehaviorContext,
  type BehaviorState,
  type RobotAction,
} from '../types.ts'
import { movement, noExitActions, repeat, transition } from './helpers.ts'

function boredPlan(context: BehaviorContext): readonly RobotAction[] {
  const direction = context.random.next() < 0.5 ? -1 : 1
  const speed = context.config.boredSpeed
  return [
    { type: 'LIGHTS', mask: 0xff, color: '#865dff', brightness: 35 },
    { type: 'WAIT', durationMs: 700 },
    ...movement(context.config, speed, speed * 0.55, 800),
    { type: 'STOP_MOTION' },
    ...movement(context.config, direction * speed, -direction * speed, 350),
    { type: 'STOP_MOTION' },
    { type: 'WAIT', durationMs: 900 },
  ]
}

export const BoredState: BehaviorState = {
  id: 'BORED',
  enter: boredPlan,
  update(context) {
    if (context.stateElapsedMs >= context.config.boredDurationMs) {
      return transition('IDLE', 'bored wandering completed', BEHAVIOR_PRIORITY.timer)
    }
    return undefined
  },
  handleEvent(context, event) {
    if (event.type === 'STATE_COMPLETED') {
      return repeat(boredPlan(context), BEHAVIOR_PRIORITY.ambient)
    }
    return undefined
  },
  exit: noExitActions,
}
