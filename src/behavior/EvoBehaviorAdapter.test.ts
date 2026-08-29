import { describe, expect, it, vi } from 'vitest'
import { EvoBehaviorAdapter, type BehaviorController } from './EvoBehaviorAdapter.ts'

class FakeBehaviorController implements BehaviorController {
  readonly drives: { left: number; right: number }[] = []
  stops = 0
  soundStops = 0
  lights = 0
  tones = 0

  setDrive(left: number, right: number): void {
    this.drives.push({ left, right })
  }

  async stopMotion(): Promise<void> {
    this.stops += 1
  }

  async setLights(): Promise<void> {
    this.lights += 1
  }

  async playTone(): Promise<void> {
    this.tones += 1
  }

  async stopSound(): Promise<void> {
    this.soundStops += 1
  }
}

describe('EvoBehaviorAdapter', () => {
  it('maps a bounded drive action and always stops afterward', async () => {
    vi.useFakeTimers()
    try {
      const controller = new FakeBehaviorController()
      const adapter = new EvoBehaviorAdapter(controller)
      const execution = adapter.execute(
        { type: 'DRIVE', left: 0.3, right: -0.3, durationMs: 100 },
        new AbortController().signal,
      )
      await vi.advanceTimersByTimeAsync(100)
      await execution
      expect(controller.drives).toEqual([{ left: 0.3, right: -0.3 }])
      expect(controller.stops).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops a drive when its action is interrupted', async () => {
    const controller = new FakeBehaviorController()
    const adapter = new EvoBehaviorAdapter(controller)
    const cancellation = new AbortController()
    const execution = adapter.execute(
      { type: 'DRIVE', left: 0.2, right: 0.2, durationMs: 1_000 },
      cancellation.signal,
    )
    cancellation.abort()
    await expect(execution).rejects.toMatchObject({ name: 'AbortError' })
    expect(controller.stops).toBe(1)
  })
})
