import type { RobotAction, RobotActionPort } from './types.ts'

export interface BehaviorController {
  setDrive(left: number, right: number): void
  stopMotion(): Promise<void>
  setLights(mask: number, color: string, brightness: number): Promise<void>
  playTone(frequencyHz: number, durationMs: number): Promise<void>
  stopSound(): Promise<void>
}

function abortError(): DOMException {
  return new DOMException('Behavior action was cancelled', 'AbortError')
}

export function abortableDelay(durationMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError())
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort)
      resolve()
    }, Math.max(0, durationMs))
    const abort = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      reject(abortError())
    }
    signal.addEventListener('abort', abort, { once: true })
  })
}

export class EvoBehaviorAdapter implements RobotActionPort {
  private readonly controller: BehaviorController

  constructor(controller: BehaviorController) {
    this.controller = controller
  }

  async execute(action: RobotAction, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw abortError()
    switch (action.type) {
      case 'DRIVE':
        this.controller.setDrive(action.left, action.right)
        try {
          await abortableDelay(action.durationMs, signal)
        } finally {
          await this.controller.stopMotion()
        }
        return
      case 'LIGHTS':
        await this.controller.setLights(action.mask, action.color, action.brightness)
        return
      case 'TONE':
        await this.controller.playTone(action.frequencyHz, action.durationMs)
        await abortableDelay(action.durationMs, signal)
        return
      case 'WAIT':
        await abortableDelay(action.durationMs, signal)
        return
      case 'STOP_MOTION':
        await this.controller.stopMotion()
        return
      case 'STOP_SOUND':
        await this.controller.stopSound()
        return
    }
  }

  async cleanup(): Promise<void> {
    let failure: unknown
    try {
      await this.controller.stopMotion()
    } catch (error) {
      failure = error
    }
    try {
      await this.controller.stopSound()
    } catch (error) {
      failure ??= error
    }
    if (failure !== undefined) throw failure
  }
}
