import { afterEach, describe, expect, it, vi } from 'vitest'
import { EvoController } from '../controller/EvoController.ts'
import { readMessageId } from '../protocol/modernCodec.ts'
import { EVO_3_PROFILE } from '../protocol/profile.ts'
import { FakeTransport, createModernResponder } from '../test/FakeTransport.ts'
import { BehaviorRuntime } from './BehaviorRuntime.ts'

const resources: { runtime: BehaviorRuntime; controller: EvoController }[] = []

afterEach(async () => {
  for (const { runtime, controller } of resources.splice(0)) {
    await runtime.dispose()
    await controller.disconnect()
  }
})

async function connectedRuntime(): Promise<{
  runtime: BehaviorRuntime
  controller: EvoController
  transport: FakeTransport
}> {
  const transport = new FakeTransport(EVO_3_PROFILE, createModernResponder())
  const controller = new EvoController(transport)
  const runtime = new BehaviorRuntime(controller, { seed: 123 })
  resources.push({ runtime, controller })
  runtime.start()
  await controller.connect()
  await controller.arm()
  return { runtime, controller, transport }
}

describe('BehaviorRuntime', () => {
  it('requires explicit arming before autonomy can start', async () => {
    const controller = new EvoController(
      new FakeTransport(EVO_3_PROFILE, createModernResponder()),
    )
    const runtime = new BehaviorRuntime(controller, { seed: 1 })
    resources.push({ runtime, controller })
    await expect(runtime.enable()).rejects.toThrow(/Arm Evo/)
    expect(runtime.snapshot.status).toBe('disabled')
  })

  it('switches safely between autonomous and armed manual modes', async () => {
    const { runtime, controller } = await connectedRuntime()
    await runtime.enable()
    expect(runtime.snapshot).toMatchObject({ status: 'running', state: 'IDLE' })
    expect(controller.snapshot.phase).toBe('armed')

    await runtime.disable()
    expect(runtime.snapshot.status).toBe('disabled')
    expect(controller.snapshot.phase).toBe('armed')
    expect(controller.snapshot.wheels).toEqual({ left: 0, right: 0 })
  })

  it('keeps ownership while stop cleanup is still running', async () => {
    let releaseStop!: () => void
    const blockedStop = new Promise<void>((resolve) => {
      releaseStop = resolve
    })
    let blockStops = false
    const responder = createModernResponder()
    const transport = new FakeTransport(EVO_3_PROFILE, async (write, fake) => {
      if (blockStops && readMessageId(write.data) === 120) await blockedStop
      await responder(write, fake)
    })
    const controller = new EvoController(transport)
    const runtime = new BehaviorRuntime(controller, { seed: 123 })
    resources.push({ runtime, controller })
    runtime.start()
    await controller.connect()
    await controller.arm()
    await runtime.enable()

    blockStops = true
    const stopping = runtime.stop()
    expect(runtime.snapshot.status).toBe('stopping')
    releaseStop()
    await stopping
    expect(runtime.snapshot.status).toBe('disabled')
  })

  it('waits for startup polling to stop before releasing ownership', async () => {
    const { runtime, controller } = await connectedRuntime()
    let finishStartup!: (stop: () => void) => void
    const stopPolling = vi.fn()
    vi.spyOn(controller, 'startReactiveSensorPolling').mockReturnValue(
      new Promise((resolve) => {
        finishStartup = resolve
      }),
    )

    const enabling = runtime.enable()
    await vi.waitFor(() => expect(runtime.snapshot.status).toBe('starting'))
    const disabling = runtime.disable()
    let disabled = false
    void disabling.then(() => {
      disabled = true
    })
    await Promise.resolve()
    expect(runtime.snapshot.status).toBe('stopping')
    expect(disabled).toBe(false)

    finishStartup(stopPolling)
    await expect(enabling).rejects.toThrow(/interrupted/)
    await disabling
    expect(stopPolling).toHaveBeenCalledOnce()
    expect(runtime.snapshot.status).toBe('disabled')
  })

  it('waits for an in-progress emergency stop before stopping', async () => {
    let releaseStop!: () => void
    const blockedStop = new Promise<void>((resolve) => {
      releaseStop = resolve
    })
    let blockStops = false
    const responder = createModernResponder()
    const transport = new FakeTransport(EVO_3_PROFILE, async (write, fake) => {
      if (blockStops && readMessageId(write.data) === 120) await blockedStop
      await responder(write, fake)
    })
    const controller = new EvoController(transport)
    const runtime = new BehaviorRuntime(controller, { seed: 123 })
    resources.push({ runtime, controller })
    runtime.start()
    await controller.connect()
    await controller.arm()
    await runtime.enable()

    blockStops = true
    const emergencyStop = runtime.emergencyStop()
    const stopping = runtime.stop()
    let stopped = false
    void stopping.then(() => {
      stopped = true
    })
    await Promise.resolve()
    expect(runtime.snapshot.status).toBe('stopping')
    expect(stopped).toBe(false)

    releaseStop()
    await Promise.all([emergencyStop, stopping])
    expect(runtime.snapshot.status).toBe('disabled')
  })

  it('escalates an in-progress normal shutdown to an emergency stop', async () => {
    let releaseStop!: () => void
    const blockedStop = new Promise<void>((resolve) => {
      releaseStop = resolve
    })
    let blockStops = false
    const responder = createModernResponder()
    const transport = new FakeTransport(EVO_3_PROFILE, async (write, fake) => {
      if (blockStops && readMessageId(write.data) === 120) await blockedStop
      await responder(write, fake)
    })
    const controller = new EvoController(transport)
    const runtime = new BehaviorRuntime(controller, { seed: 123 })
    resources.push({ runtime, controller })
    runtime.start()
    await controller.connect()
    await controller.arm()
    await runtime.enable()

    blockStops = true
    const disabling = runtime.disable()
    expect(runtime.snapshot.status).toBe('stopping')
    const emergencyStop = runtime.emergencyStop()
    expect(controller.snapshot.phase).toBe('stopping')

    releaseStop()
    await Promise.all([disabling, emergencyStop])
    expect(runtime.snapshot.status).toBe('disabled')
    expect(controller.snapshot.phase).toBe('ready')
  })

  it('processes explicit dance requests through the state engine', async () => {
    const { runtime } = await connectedRuntime()
    await runtime.enable()
    runtime.requestDance()
    await vi.waitFor(() => {
      expect(runtime.snapshot.state).toBe('DANCING')
    })
  })

  it('transitions from a busy idle plan to curious without false sensor staleness', async () => {
    vi.useFakeTimers()
    try {
      const transport = new FakeTransport(EVO_3_PROFILE, createModernResponder())
      const controller = new EvoController(transport)
      const runtime = new BehaviorRuntime(controller, {
        seed: 123,
        config: {
          engineTickMs: 100,
          reactiveSensorIntervalMs: 100,
          sensorStaleMs: 800,
          idleToCuriousMs: 200,
          boredAfterMs: 10_000,
          sleepAfterMs: 20_000,
        },
      })
      resources.push({ runtime, controller })
      runtime.start()
      await controller.connect()
      await controller.arm()
      await runtime.enable()

      await vi.advanceTimersByTimeAsync(350)
      expect(runtime.snapshot).toMatchObject({
        status: 'running',
        state: 'CURIOUS',
      })
      expect(controller.snapshot.phase).toBe('armed')
    } finally {
      vi.useRealTimers()
    }
  })

  it('performs every stationary dance stage before entering excited', async () => {
    vi.useFakeTimers()
    try {
      const transport = new FakeTransport(EVO_3_PROFILE, createModernResponder())
      const controller = new EvoController(transport)
      const runtime = new BehaviorRuntime(controller, {
        seed: 123,
        config: {
          reactiveSensorIntervalMs: 100,
          sensorStaleMs: 1_000,
        },
      })
      resources.push({ runtime, controller })
      runtime.start()
      await controller.connect()
      await controller.arm()
      await runtime.enable()
      runtime.requestDance()

      await vi.advanceTimersByTimeAsync(2_000)
      const toneFrequencies = transport.writes
        .filter((write) => readMessageId(write.data) === 118)
        .map((write) => new DataView(
          write.data.buffer,
          write.data.byteOffset,
          write.data.byteLength,
        ).getUint16(6, true))
      expect(toneFrequencies.slice(0, 3)).toEqual([392, 523, 659])
      expect(runtime.snapshot).toMatchObject({
        status: 'running',
        state: 'EXCITED',
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('retains the stale-sensor fail-safe after focused-read retries are exhausted', async () => {
    vi.useFakeTimers()
    try {
      let dropSafetyReads = false
      const responder = createModernResponder()
      const transport = new FakeTransport(EVO_3_PROFILE, async (write, fake) => {
        if (dropSafetyReads && readMessageId(write.data) === 1) {
          const view = new DataView(
            write.data.buffer,
            write.data.byteOffset,
            write.data.byteLength,
          )
          if (view.getUint32(2, true) === 113 && view.getUint16(6, true) === 13) return
        }
        await responder(write, fake)
      })
      const controller = new EvoController(transport)
      const runtime = new BehaviorRuntime(controller, {
        seed: 123,
        config: {
          engineTickMs: 100,
          reactiveSensorIntervalMs: 100,
          sensorStaleMs: 700,
        },
      })
      resources.push({ runtime, controller })
      runtime.start()
      await controller.connect()
      await controller.arm()
      await runtime.enable()
      dropSafetyReads = true

      await vi.advanceTimersByTimeAsync(1_500)
      expect(runtime.snapshot).toMatchObject({
        status: 'faulted',
        state: 'IDLE',
        error: 'Reactive sensor data became stale',
      })
      expect(controller.snapshot.phase).toBe('ready')
    } finally {
      vi.useRealTimers()
    }
  })

  it('starts in a stationary scared state when the baseline says Evo is picked up', async () => {
    const transport = new FakeTransport(EVO_3_PROFILE, createModernResponder({
      113: [1, 5, 0, 0, 0],
    }))
    const controller = new EvoController(transport)
    const runtime = new BehaviorRuntime(controller, {
      seed: 1,
      config: { movementEnabled: true },
    })
    resources.push({ runtime, controller })
    runtime.start()
    await controller.connect()
    await controller.arm()
    await runtime.enable()
    await vi.waitFor(() => {
      expect(runtime.snapshot.state).toBe('SCARED')
    })
    expect(controller.snapshot.wheels).toEqual({ left: 0, right: 0 })
  })

  it('drops autonomy and reports an unexpected disconnect', async () => {
    const { runtime, transport } = await connectedRuntime()
    await runtime.enable()
    transport.simulateDisconnect()
    expect(runtime.snapshot.status).toBe('stopping')
    await vi.waitFor(() => {
      expect(runtime.snapshot).toMatchObject({
        status: 'faulted',
        state: 'IDLE',
        error: 'Simulated disconnect',
      })
    })
  })

  it('cancels autonomy as soon as the controller starts a focus-loss stop', async () => {
    const { runtime, controller } = await connectedRuntime()
    await runtime.enable()
    const stopping = controller.emergencyStop('Control focus was lost')
    expect(controller.snapshot.phase).toBe('stopping')
    expect(runtime.snapshot.status).toBe('stopping')
    await stopping
    expect(controller.snapshot.phase).toBe('ready')
    await vi.waitFor(() => {
      expect(runtime.snapshot.status).toBe('disabled')
    })
  })

  it('uses the emergency-stop path when an autonomous action fails', async () => {
    const responder = createModernResponder()
    const transport = new FakeTransport(EVO_3_PROFILE, async (write, fake) => {
      if (readMessageId(write.data) === 110) throw new Error('Simulated LED failure')
      await responder(write, fake)
    })
    const controller = new EvoController(transport)
    const runtime = new BehaviorRuntime(controller, { seed: 4 })
    resources.push({ runtime, controller })
    runtime.start()
    await controller.connect()
    await controller.arm()
    await runtime.enable()

    await vi.waitFor(() => {
      expect(runtime.snapshot.status).toBe('faulted')
    })
    expect(runtime.snapshot.error).toContain('Behavior action failed')
    expect(controller.snapshot.phase).toBe('ready')
  })
})
