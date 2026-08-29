import type { RobotAction, RobotActionPort } from './types.ts'

export interface BehaviorController {
  setDrive(left: number, right: number): void
  stopMotion(): Promise<void>
  setLights(mask: number, color: string, brightness: number): Promise<void>
  playTone(frequencyHz: number, durationMs: number, signal?: AbortSignal): Promise<void>
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
  private motionActive = false
  private soundActive = false

  constructor(controller: BehaviorController) {
    this.controller = controller
  }

  async execute(action: RobotAction, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw abortError()
    switch (action.type) {
      case 'DRIVE':
        this.motionActive = true
        this.controller.setDrive(action.left, action.right)
        try {
          await abortableDelay(action.durationMs, signal)
        } finally {
          await this.controller.stopMotion()
          this.motionActive = false
        }
        return
      case 'LIGHTS':
        await this.controller.setLights(action.mask, action.color, action.brightness)
        return
      case 'TONE':
        this.soundActive = true
        await this.controller.playTone(action.frequencyHz, action.durationMs, signal)
        this.soundActive = false
        return
      case 'WAIT':
        await abortableDelay(action.durationMs, signal)
        return
      case 'STOP_MOTION':
        if (!this.motionActive) return
        await this.controller.stopMotion()
        this.motionActive = false
        return
      case 'STOP_SOUND':
        if (!this.soundActive) return
        await this.controller.stopSound()
        this.soundActive = false
        return
    }
  }

  async cleanup(force: boolean): Promise<void> {
    let failure: unknown
    if (force || this.motionActive) {
      try {
        await this.controller.stopMotion()
        this.motionActive = false
      } catch (error) {
        failure = error
      }
    }
    if (force || this.soundActive) {
      try {
        await this.controller.stopSound()
        this.soundActive = false
      } catch (error) {
        failure ??= error
      }
    }
    if (failure !== undefined) throw failure
  }
}
