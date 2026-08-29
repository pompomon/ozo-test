import { describe, expect, it, vi } from 'vitest'
import { ActionScheduler } from './ActionScheduler.ts'
import { abortableDelay } from './EvoBehaviorAdapter.ts'
import type { RobotAction, RobotActionPort } from './types.ts'

class FakeActionPort implements RobotActionPort {
  readonly executed: RobotAction[] = []
  cleanups = 0
  failure?: Error

  async execute(action: RobotAction, signal: AbortSignal): Promise<void> {
    this.executed.push(action)
    if (this.failure) throw this.failure
    if (action.type === 'WAIT') await abortableDelay(action.durationMs, signal)
  }

  async cleanup(): Promise<void> {
    this.cleanups += 1
  }
}

describe('ActionScheduler', () => {
  it('keeps one plan active and ignores lower-priority work', async () => {
    vi.useFakeTimers()
    try {
      const port = new FakeActionPort()
      const scheduler = new ActionScheduler(port)
      const active = scheduler.schedule([{ type: 'WAIT', durationMs: 1_000 }], 20)
      await Promise.resolve()
      const ignored = scheduler.schedule([{ type: 'STOP_MOTION' }], 10)
      expect(ignored.accepted).toBe(false)
      expect(await ignored.completion).toBe('ignored')
      await scheduler.cancel()
      expect(await active.completion).toBe('cancelled')
      expect(port.cleanups).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels an old plan before starting a higher-priority plan', async () => {
    vi.useFakeTimers()
    try {
      const port = new FakeActionPort()
      const scheduler = new ActionScheduler(port)
      const old = scheduler.schedule([{ type: 'WAIT', durationMs: 1_000 }], 10)
      await Promise.resolve()
      const next = scheduler.schedule([{ type: 'STOP_MOTION' }], 80)
      expect(await old.completion).toBe('cancelled')
      expect(await next.completion).toBe('completed')
      expect(port.executed.at(-1)?.type).toBe('STOP_MOTION')
      expect(port.cleanups).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('cleans up and reports action failures', async () => {
    const port = new FakeActionPort()
    port.failure = new Error('action failed')
    const scheduler = new ActionScheduler(port)
    const ticket = scheduler.schedule([{ type: 'STOP_MOTION' }], 10)
    await expect(ticket.completion).rejects.toThrow('action failed')
    expect(port.cleanups).toBe(1)
  })

  it('reports cancellation that occurs during cleanup', async () => {
    let releaseCleanup!: () => void
    const cleanup = new Promise<void>((resolve) => {
      releaseCleanup = resolve
    })
    const port = new FakeActionPort()
    port.cleanup = vi.fn(() => cleanup)
    const scheduler = new ActionScheduler(port)
    const ticket = scheduler.schedule([{ type: 'STOP_MOTION' }], 10)
    await vi.waitFor(() => expect(port.cleanup).toHaveBeenCalled())

    const cancellation = scheduler.cancel()
    releaseCleanup()

    await cancellation
    expect(await ticket.completion).toBe('cancelled')
  })
})
