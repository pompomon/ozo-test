import { describe, expect, it, vi } from 'vitest'
import { EVO_3_PROFILE, LEGACY_PROFILE } from '../protocol/profile.ts'
import { readMessageId } from '../protocol/modernCodec.ts'
import { FakeTransport, createModernResponder } from '../test/FakeTransport.ts'
import { EvoController } from './EvoController.ts'

describe('EvoController', () => {
  it('connects, detects firmware, and reads telemetry', async () => {
    const transport = new FakeTransport(EVO_3_PROFILE, createModernResponder())
    const controller = new EvoController(transport)
    await controller.connect()
    expect(controller.snapshot).toMatchObject({
      phase: 'ready',
      firmware: '3.7.4',
      deviceName: 'OzoEvo-Test',
    })
    expect(controller.snapshot.telemetry?.firmware).toBe('3.7.4')
    await controller.disconnect()
  })

  it('requires arming and prioritizes a stop after movement', async () => {
    const transport = new FakeTransport(EVO_3_PROFILE, createModernResponder())
    const controller = new EvoController(transport)
    await controller.connect()
    controller.setDrive(1, 1)
    expect(transport.writes.some((write) => readMessageId(write.data) === 104)).toBe(false)

    await controller.arm()
    controller.setDrive(1, 1)
    await vi.waitFor(() => {
      expect(transport.writes.some((write) => readMessageId(write.data) === 104)).toBe(true)
    })
    await controller.emergencyStop()
    const stop = transport.writes.findLast((write) => readMessageId(write.data) === 120)
    expect(stop?.options?.priority).toBe(true)
    expect(controller.snapshot.phase).toBe('ready')
    expect(controller.snapshot.wheels).toEqual({ left: 0, right: 0 })
    await controller.disconnect()
  })

  it('never enables motors for the incomplete legacy profile', async () => {
    const transport = new FakeTransport(LEGACY_PROFILE)
    const controller = new EvoController(transport)
    await controller.connect()
    expect(controller.snapshot.phase).toBe('incompatible')
    expect([...transport.writes[0].data]).toEqual([0x50, 0x02, 0x01])
    await controller.arm()
    expect(controller.snapshot.phase).toBe('incompatible')
    await controller.disconnect()
  })

  it('clears armed state and commands after an unexpected disconnect', async () => {
    const transport = new FakeTransport(EVO_3_PROFILE, createModernResponder())
    const controller = new EvoController(transport)
    await controller.connect()
    await controller.arm()
    transport.simulateDisconnect()
    expect(controller.snapshot).toMatchObject({
      phase: 'error',
      wheels: { left: 0, right: 0 },
    })
  })

  it('redacts the selected device name from exported diagnostics', async () => {
    const transport = new FakeTransport(EVO_3_PROFILE, createModernResponder())
    const controller = new EvoController(transport)
    await controller.connect()
    const exported = controller.exportDiagnostics()
    expect(exported).not.toContain('OzoEvo-Test')
    expect(exported).toContain('[device]')
    await controller.disconnect()
  })
})

