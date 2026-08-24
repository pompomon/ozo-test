import { afterEach, describe, expect, it, vi } from 'vitest'
import { EvoController } from '../controller/EvoController.ts'
import { readMessageId } from '../protocol/modernCodec.ts'
import { EVO_3_PROFILE } from '../protocol/profile.ts'
import { FakeTransport, createModernResponder } from '../test/FakeTransport.ts'
import { BehaviorRuntime } from './BehaviorRuntime.ts'

const resources: { runtime: BehaviorRuntime; controller: EvoController }[] = []

afterEach(async () => {
  for (const { runtime, controller } of resources.splice(0)) {
    runtime.dispose()
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

  it('processes explicit dance requests through the state engine', async () => {
    const { runtime } = await connectedRuntime()
    await runtime.enable()
    runtime.requestDance()
    await vi.waitFor(() => {
      expect(runtime.snapshot.state).toBe('DANCING')
    })
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
