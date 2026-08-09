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
    expect(new DataView(stop!.data.buffer, stop!.data.byteOffset, stop!.data.byteLength).getUint32(2, true)).toBe(0)
    expect(controller.snapshot.phase).toBe('ready')
    expect(controller.snapshot.wheels).toEqual({ left: 0, right: 0 })
    await controller.disconnect()
  })

  it('recovers from a single transient drive 105 timeout while staying armed', async () => {
    vi.useFakeTimers()
    try {
      let movementRequests = 0
      const responder = createModernResponder()
      const transport = new FakeTransport(EVO_3_PROFILE, async (write, fake) => {
        if (readMessageId(write.data) === 104) {
          movementRequests += 1
          if (movementRequests === 1) return
        }
        await responder(write, fake)
      })
      const controller = new EvoController(transport)
      await controller.connect()
      await controller.arm()
      controller.setDrive(1, 1)
      await vi.advanceTimersByTimeAsync(2_300)
      expect(transport.writes.filter((write) => readMessageId(write.data) === 104).length).toBeGreaterThan(1)
      expect(controller.snapshot.phase).toBe('armed')
    } finally {
      vi.useRealTimers()
    }
  })

  it('escalates to safe stop after repeated drive 105 timeouts', async () => {
    vi.useFakeTimers()
    try {
      const responder = createModernResponder()
      const transport = new FakeTransport(EVO_3_PROFILE, async (write, fake) => {
        if (readMessageId(write.data) === 104) return
        await responder(write, fake)
      })
      const controller = new EvoController(transport)
      await controller.connect()
      await controller.arm()
      controller.setDrive(1, 1)
      await vi.advanceTimersByTimeAsync(4_300)
      expect(controller.snapshot.phase).toBe('ready')
      const diagnostics = controller.exportDiagnostics()
      expect(diagnostics).toContain('Drive acknowledgment timeout (1/2)')
      expect(diagnostics).toContain('Drive acknowledgment timeout (2/2)')
      expect(diagnostics).toContain('Drive communication failed')
    } finally {
      vi.useRealTimers()
    }
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

  it('locks controls if a disarm stop is not acknowledged', async () => {
    let failStops = false
    const responder = createModernResponder()
    const transport = new FakeTransport(EVO_3_PROFILE, async (write, fake) => {
      if (failStops && readMessageId(write.data) === 120) {
        throw new Error('Simulated stop failure')
      }
      await responder(write, fake)
    })
    const controller = new EvoController(transport)
    await controller.connect()
    await controller.arm()
    failStops = true
    await controller.disarm()
    expect(controller.snapshot).toMatchObject({
      phase: 'error',
      wheels: { left: 0, right: 0 },
    })
    expect(controller.snapshot.error).toContain('not acknowledged')
    await controller.disconnect()
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
