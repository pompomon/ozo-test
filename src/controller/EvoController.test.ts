import { describe, expect, it, vi } from 'vitest'
import { EVO_3_PROFILE, LEGACY_PROFILE } from '../protocol/profile.ts'
import { readMessageId } from '../protocol/modernCodec.ts'
import type { ReactiveSensors } from '../protocol/telemetry.ts'
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

  it('switches from full telemetry to focused non-overlapping sensor polling', async () => {
    const transport = new FakeTransport(EVO_3_PROFILE, createModernResponder({
      113: [1, 5, 0, 0, 0],
      118: [1, 2, 3, 4, 6, 0, 0, 0],
      196: [0, 7, 0, 0, 0],
    }))
    const controller = new EvoController(transport)
    await controller.connect()
    await controller.arm()
    transport.writes.splice(0)
    const samples: number[] = []
    const stop = await controller.startReactiveSensorPolling(
      (sensors) => samples.push(sensors.proximity.leftFront),
      () => undefined,
      1_000,
    )
    stop()

    expect(samples).toEqual([2])
    const reads = transport.writes
      .filter((write) => readMessageId(write.data) === 1)
      .map((write) => {
        const view = new DataView(write.data.buffer, write.data.byteOffset, write.data.byteLength)
        return { address: view.getUint32(2, true), length: view.getUint16(6, true) }
      })
    expect(reads).toEqual([
      { address: 113, length: 13 },
    ])
    await controller.disconnect()
  })

  it('cancels an in-flight telemetry refresh before focused polling starts', async () => {
    let dropNextMemoryRead = false
    const responder = createModernResponder()
    const transport = new FakeTransport(EVO_3_PROFILE, async (write, fake) => {
      if (dropNextMemoryRead && readMessageId(write.data) === 1) {
        dropNextMemoryRead = false
        return
      }
      await responder(write, fake)
    })
    const controller = new EvoController(transport)
    await controller.connect()
    await controller.arm()
    transport.writes.splice(0)
    dropNextMemoryRead = true

    const telemetry = controller.refreshTelemetry()
    await vi.waitFor(() => expect(transport.writes).toHaveLength(1))
    const polling = controller.startReactiveSensorPolling(
      () => undefined,
      () => undefined,
      1_000,
    )
    const stop = await polling
    await telemetry

    const reads = transport.writes
      .filter((write) => readMessageId(write.data) === 1)
      .map((write) => {
        const view = new DataView(write.data.buffer, write.data.byteOffset, write.data.byteLength)
        return { address: view.getUint32(2, true), length: view.getUint16(6, true) }
      })
    expect(reads).toEqual([
      { address: 65_580, length: 4 },
      { address: 0, length: 1 },
      { address: 113, length: 13 },
    ])
    stop()
    await controller.disconnect()
  })

  it('accepts one delayed focused safety response without overlapping a retry', async () => {
    vi.useFakeTimers()
    try {
      let safetyReads = 0
      const responder = createModernResponder()
      const transport = new FakeTransport(EVO_3_PROFILE, async (write, fake) => {
        if (readMessageId(write.data) === 1) {
          const view = new DataView(
            write.data.buffer,
            write.data.byteOffset,
            write.data.byteLength,
          )
          if (view.getUint32(2, true) === 113 && view.getUint16(6, true) === 13) {
            safetyReads += 1
            if (safetyReads === 1) {
              setTimeout(() => {
                void responder(write, fake)
              }, 750)
              return
            }
          }
        }
        await responder(write, fake)
      })
      const controller = new EvoController(transport)
      await controller.connect()
      await controller.arm()
      const samples: ReactiveSensors[] = []
      const errors = vi.fn()
      const polling = controller.startReactiveSensorPolling(
        (sensors) => samples.push(sensors),
        errors,
        1_000,
      )

      await vi.advanceTimersByTimeAsync(751)
      const stop = await polling
      expect(safetyReads).toBe(1)
      expect(samples).toHaveLength(1)
      expect(errors).not.toHaveBeenCalled()
      stop()
      await controller.disconnect()
    } finally {
      vi.useRealTimers()
    }
  })

  it('pauses movement before retrying a focused safety read', async () => {
    vi.useFakeTimers()
    try {
      let dropNextSafetyRead = false
      const responder = createModernResponder()
      const transport = new FakeTransport(EVO_3_PROFILE, async (write, fake) => {
        if (dropNextSafetyRead && readMessageId(write.data) === 1) {
          const view = new DataView(
            write.data.buffer,
            write.data.byteOffset,
            write.data.byteLength,
          )
          if (view.getUint32(2, true) === 113 && view.getUint16(6, true) === 13) {
            dropNextSafetyRead = false
            return
          }
        }
        await responder(write, fake)
      })
      const controller = new EvoController(transport)
      await controller.connect()
      await controller.arm()
      const errors = vi.fn()
      const stop = await controller.startReactiveSensorPolling(
        () => undefined,
        errors,
        250,
      )
      dropNextSafetyRead = true
      controller.setDrive(1, 1)
      const stopsBeforeRetry = transport.writes
        .filter((write) => readMessageId(write.data) === 120)
        .length

      await vi.advanceTimersByTimeAsync(751)
      expect(controller.snapshot.wheels).toEqual({ left: 0, right: 0 })
      expect(controller.snapshot.phase).toBe('armed')
      expect(errors).not.toHaveBeenCalled()
      expect(controller.exportDiagnostics()).toContain('movement paused for retry')
      const retryStops = transport.writes
        .filter((write) => readMessageId(write.data) === 120)
        .slice(stopsBeforeRetry)
      expect(retryStops).toHaveLength(1)
      expect(retryStops[0].options?.priority).toBe(true)

      const movementWrites = (): number => transport.writes
        .filter((write) => readMessageId(write.data) === 104)
        .length
      const beforeBlockedDrive = movementWrites()
      controller.setDrive(1, 1)
      await Promise.resolve()
      expect(movementWrites()).toBe(beforeBlockedDrive)

      await vi.advanceTimersByTimeAsync(501)
      controller.setDrive(1, 1)
      await vi.waitFor(() => expect(movementWrites()).toBeGreaterThan(beforeBlockedDrive))
      stop()
      await controller.disconnect()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps safety samples fresh when the lower-rate button read fails', async () => {
    vi.useFakeTimers()
    try {
      let pollingStarted = false
      const responder = createModernResponder()
      const transport = new FakeTransport(EVO_3_PROFILE, async (write, fake) => {
        if (pollingStarted && readMessageId(write.data) === 1) {
          const view = new DataView(
            write.data.buffer,
            write.data.byteOffset,
            write.data.byteLength,
          )
          if (view.getUint32(2, true) === 196) return
        }
        await responder(write, fake)
      })
      const controller = new EvoController(transport)
      await controller.connect()
      await controller.arm()
      pollingStarted = true
      const samples: ReactiveSensors[] = []
      const errors = vi.fn()
      const stop = await controller.startReactiveSensorPolling(
        (sensors) => samples.push(sensors),
        errors,
        250,
      )

      await vi.advanceTimersByTimeAsync(1_751)
      expect(samples.length).toBeGreaterThan(3)
      expect(errors).not.toHaveBeenCalled()
      expect(controller.exportDiagnostics()).toContain('Reactive button read failed')
      stop()
      await controller.disconnect()
    } finally {
      vi.useRealTimers()
    }
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
    const stopping = controller.emergencyStop()
    expect(controller.snapshot.phase).toBe('stopping')
    controller.setDrive(1, 1)
    expect(controller.snapshot.wheels).toEqual({ left: 0, right: 0 })
    await stopping
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

  it('does not deliver a focused sensor sample after polling is cancelled', async () => {
    const responder = createModernResponder()
    let blockReactiveRead = false
    let releaseRead = (): void => undefined
    const blocked = new Promise<void>((resolve) => {
      releaseRead = resolve
    })
    const transport = new FakeTransport(EVO_3_PROFILE, async (write, fake) => {
      if (blockReactiveRead && readMessageId(write.data) === 1) await blocked
      await responder(write, fake)
    })
    const controller = new EvoController(transport)
    await controller.connect()
    await controller.arm()
    transport.writes.splice(0)
    blockReactiveRead = true
    const samples: number[] = []
    const polling = controller.startReactiveSensorPolling(
      (sensors) => samples.push(sensors.receivedAt),
      () => undefined,
      1_000,
    )
    const assertion = expect(polling).rejects.toThrow(/interrupted/)
    await vi.waitFor(() => {
      expect(transport.writes.some((write) => readMessageId(write.data) === 1)).toBe(true)
    })
    await controller.disarm()
    releaseRead()
    await assertion
    expect(samples).toEqual([])
    await controller.disconnect()
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

  it('upgrades an in-flight weaker stop when queued sound must be cleared', async () => {
    const transport = new FakeTransport(EVO_3_PROFILE, createModernResponder())
    const controller = new EvoController(transport)
    await controller.connect()
    await controller.arm()

    const client = (controller as any).client
    const stopMovement = vi.spyOn(client, 'stopMovement')
    await Promise.all([controller.stopMotion(), controller.stopMotionAndQueuedSound()])

    expect(stopMovement).toHaveBeenNthCalledWith(1, false, false)
    expect(stopMovement).toHaveBeenNthCalledWith(2, false, true)
    await controller.disconnect()
  })

  it('sends another stop after an earlier stop settles', async () => {
    const transport = new FakeTransport(EVO_3_PROFILE, createModernResponder())
    const controller = new EvoController(transport)
    await controller.connect()
    await controller.arm()

    const client = (controller as any).client
    const stopMovement = vi.spyOn(client, 'stopMovement')
    await controller.stopMotion()
    await controller.stopMotion()

    expect(stopMovement).toHaveBeenCalledTimes(2)
    await controller.disconnect()
  })

  it('does not log a sound stop when no command was sent', async () => {
    const controller = new EvoController(
      new FakeTransport(EVO_3_PROFILE, createModernResponder()),
    )
    await controller.connect()
    controller.clearDiagnostics()

    await controller.stopSound()
    expect(controller.exportDiagnostics()).not.toContain('Stopped sound')
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

  it('cancels a pending arm if shutdown starts while arming', async () => {
    const transport = new FakeTransport(EVO_3_PROFILE, createModernResponder())
    const controller = new EvoController(transport)
    await controller.connect()

    const previousWakeLock = navigator.wakeLock
    let resolveWakeLock!: (lock: { released: boolean; release: () => Promise<void> }) => void
    const wakeLockRequest = new Promise<{ released: boolean; release: () => Promise<void> }>((resolve) => {
      resolveWakeLock = resolve
    })
    Object.defineProperty(navigator, 'wakeLock', {
      configurable: true,
      value: { request: vi.fn(() => wakeLockRequest) },
    })

    try {
      const arm = controller.arm()
      await vi.waitFor(() => expect(controller.snapshot.phase).toBe('arming'))
      const stopping = controller.emergencyStop()
      resolveWakeLock({ released: false, release: async () => undefined })
      await stopping
      await arm
      expect(controller.snapshot.phase).toBe('ready')
    } finally {
      if (previousWakeLock === undefined) {
        Reflect.deleteProperty(navigator, 'wakeLock')
      } else {
        Object.defineProperty(navigator, 'wakeLock', {
          configurable: true,
          value: previousWakeLock,
        })
      }
      await controller.disconnect()
    }
  })

  it('cancels a pending arm when focus is lost while arming', async () => {
    const transport = new FakeTransport(EVO_3_PROFILE, createModernResponder())
    const controller = new EvoController(transport)
    await controller.connect()

    const previousWakeLock = navigator.wakeLock
    let resolveWakeLock!: (lock: { released: boolean; release: () => Promise<void> }) => void
    const wakeLockRequest = new Promise<{ released: boolean; release: () => Promise<void> }>((resolve) => {
      resolveWakeLock = resolve
    })
    Object.defineProperty(navigator, 'wakeLock', {
      configurable: true,
      value: { request: vi.fn(() => wakeLockRequest) },
    })

    try {
      controller.installSafetyHandlers()
      const arm = controller.arm()
      await vi.waitFor(() => expect(controller.snapshot.phase).toBe('arming'))
      const stop = controller.emergencyStop('Control focus was lost')
      window.dispatchEvent(new Event('blur'))
      resolveWakeLock({ released: false, release: async () => undefined })
      await stop
      await arm
      expect(controller.snapshot.phase).toBe('ready')
    } finally {
      if (previousWakeLock === undefined) {
        Reflect.deleteProperty(navigator, 'wakeLock')
      } else {
        Object.defineProperty(navigator, 'wakeLock', {
          configurable: true,
          value: previousWakeLock,
        })
      }
      await controller.disconnect()
    }
  })

  it('returns to ready when another tab holds motor control', async () => {
    const transport = new FakeTransport(EVO_3_PROFILE, createModernResponder())
    const controller = new EvoController(transport)
    await controller.connect()
    const previousLocks = navigator.locks
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: {
        request: vi.fn(async (_name, _options, callback) => callback(null)),
      },
    })

    try {
      await controller.arm()
      expect(controller.snapshot).toMatchObject({
        phase: 'ready',
        error: 'Another tab already holds motor control.',
      })
      await controller.arm()
      expect(controller.snapshot.phase).toBe('ready')
    } finally {
      if (previousLocks === undefined) {
        Reflect.deleteProperty(navigator, 'locks')
      } else {
        Object.defineProperty(navigator, 'locks', {
          configurable: true,
          value: previousLocks,
        })
      }
      await controller.disconnect()
    }
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

  it('awaits an in-flight disarm before disconnecting', async () => {
    let blockStops = false
    let releaseStop = (): void => undefined
    const stopBlocked = new Promise<void>((resolve) => {
      releaseStop = resolve
    })
    const responder = createModernResponder()
    const transport = new FakeTransport(EVO_3_PROFILE, async (write, fake) => {
      if (blockStops && readMessageId(write.data) === 120) await stopBlocked
      await responder(write, fake)
    })
    const controller = new EvoController(transport)
    await controller.connect()
    await controller.arm()
    blockStops = true

    const disarm = controller.disarm()
    await vi.waitFor(() => expect(controller.snapshot.phase).toBe('stopping'))
    let repeatedDisarmSettled = false
    const repeatedDisarm = controller.disarm().then(() => {
      repeatedDisarmSettled = true
    })
    const disconnect = controller.disconnect()
    await Promise.resolve()

    expect(repeatedDisarmSettled).toBe(false)
    expect(transport.connected).toBe(true)
    releaseStop()
    await Promise.all([disarm, repeatedDisarm, disconnect])
    expect(controller.snapshot.phase).toBe('disconnected')
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
