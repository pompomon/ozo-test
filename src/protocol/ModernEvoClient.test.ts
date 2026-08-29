import { afterEach, describe, expect, it, vi } from 'vitest'
import { FakeTransport, createModernResponder } from '../test/FakeTransport.ts'
import { TransportQueueCancelledError } from '../transport/EvoTransport.ts'
import { ModernEvoClient, MovementSupersededError, MovementTimeoutError } from './ModernEvoClient.ts'
import { EXECUTION_STATE, readMessageId } from './modernCodec.ts'

const clients: ModernEvoClient[] = []

function requestIdOf(packet: Uint8Array): number {
  return new DataView(packet.buffer, packet.byteOffset, packet.byteLength).getUint32(2, true)
}

function audioState(requestId: number, state: number): Uint8Array {
  const packet = new Uint8Array(7)
  const view = new DataView(packet.buffer)
  view.setUint16(0, 259, true)
  view.setUint32(2, requestId, true)
  packet[6] = state
  return packet
}

function requestResponse(messageId: number, requestId: number): Uint8Array {
  const packet = new Uint8Array(6)
  const view = new DataView(packet.buffer)
  view.setUint16(0, messageId, true)
  view.setUint32(2, requestId, true)
  return packet
}

function memoryResponse(data: readonly number[]): Uint8Array {
  const packet = new Uint8Array(5 + data.length)
  const view = new DataView(packet.buffer)
  view.setUint16(0, 2, true)
  view.setUint16(3, data.length, true)
  packet.set(data, 5)
  return packet
}

afterEach(() => {
  for (const client of clients.splice(0)) client.dispose()
})

describe('ModernEvoClient', () => {
  it('stops all execution immediately after connecting', async () => {
    const transport = new FakeTransport(undefined, createModernResponder())
    await transport.connect()
    const client = new ModernEvoClient(transport)
    clients.push(client)
    await client.initialize()
    expect(readMessageId(transport.writes[0].data)).toBe(120)
    expect(transport.writes[0].options?.priority).toBe(true)
  })

  it('uses BLE-source request IDs and bounded movement commands', async () => {
    const transport = new FakeTransport(undefined, createModernResponder())
    await transport.connect()
    const client = new ModernEvoClient(transport)
    clients.push(client)
    await client.setWheels(100, -100, 250)
    const packet = transport.writes[0].data
    const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength)
    expect(readMessageId(packet)).toBe(104)
    expect(view.getUint32(2, true)).toBe(0x0200_0001)
    expect(view.getInt32(14, true)).toBe(250)
    expect(transport.writes[0].options?.replaceKey).toBe('movement')
  })

  it('reads and validates the complete telemetry map in 15-byte chunks', async () => {
    const transport = new FakeTransport(undefined, createModernResponder({
      188: [0x74, 0x0e, 80, 1, 1, 0, 0, 0],
    }))
    await transport.connect()
    const client = new ModernEvoClient(transport)
    clients.push(client)
    const telemetry = await client.readTelemetry()
    expect(telemetry.firmware).toBe('3.7.4')
    expect(telemetry.battery).toMatchObject({ voltageMv: 3700, percent: 80, charging: true })

    const positionReads = transport.writes
      .filter((write) => readMessageId(write.data) === 1)
      .map((write) => {
        const view = new DataView(write.data.buffer, write.data.byteOffset, write.data.byteLength)
        return { address: view.getUint32(2, true), length: view.getUint16(6, true) }
      })
      .filter(({ address }) => address === 162 || address === 177)
    expect(positionReads).toEqual([
      { address: 162, length: 15 },
      { address: 177, length: 6 },
    ])
  })

  it('reads only the focused reactive sensor regions', async () => {
    const transport = new FakeTransport(undefined, createModernResponder({
      113: [1, 9, 0, 0, 0],
      118: [4, 80, 3, 70, 10, 0, 0, 0],
      196: [0, 11, 0, 0, 0],
    }))
    await transport.connect()
    const client = new ModernEvoClient(transport)
    clients.push(client)
    const sensors = await client.readReactiveSensors()
    expect(sensors.proximity).toMatchObject({
      leftRear: 4,
      leftFront: 80,
      rightRear: 3,
      rightFront: 70,
    })
    expect(sensors.pickup).toEqual({ pickedUp: true, timestamp: 9 })
    expect(sensors.button).toEqual({ press: 'Short', timestamp: 11 })

    const reads = transport.writes.map((write) => {
      const view = new DataView(write.data.buffer, write.data.byteOffset, write.data.byteLength)
      return { address: view.getUint32(2, true), length: view.getUint16(6, true) }
    })
    expect(reads).toEqual([
      { address: 113, length: 13 },
      { address: 196, length: 5 },
    ])
  })

  it('stops a failed telemetry batch without running orphaned reads', async () => {
    const transport = new FakeTransport(undefined, ({ data }, fake) => {
      if (readMessageId(data) !== 1) return
      queueMicrotask(() => fake.emit(Uint8Array.of(2, 0, 1, 0, 0)))
    })
    await transport.connect()
    const client = new ModernEvoClient(transport)
    clients.push(client)

    await expect(client.readTelemetry()).rejects.toThrow(/status 1/)
    expect(transport.writes.map((write) => readMessageId(write.data))).toEqual([1])
  })

  it('serializes complete short RPC transactions', async () => {
    let releaseRead!: () => void
    const blockedRead = new Promise<void>((resolve) => {
      releaseRead = resolve
    })
    const responder = createModernResponder()
    const transport = new FakeTransport(undefined, async (write, fake) => {
      if (readMessageId(write.data) === 1) await blockedRead
      await responder(write, fake)
    })
    await transport.connect()
    const client = new ModernEvoClient(transport)
    clients.push(client)

    const sensors = client.readReactiveSafetySensors()
    await vi.waitFor(() => expect(transport.writes).toHaveLength(1))
    const led = client.setLed(1, 2, 3, 4)
    await Promise.resolve()
    expect(transport.writes.map((write) => readMessageId(write.data))).toEqual([1])

    releaseRead()
    await Promise.all([sensors, led])
    expect(transport.writes.map((write) => readMessageId(write.data))).toEqual([1, 110])
  })

  it('allows movement to interleave between full telemetry reads', async () => {
    let releaseRead!: () => void
    const blockedRead = new Promise<void>((resolve) => {
      releaseRead = resolve
    })
    let blockFirstRead = true
    const responder = createModernResponder()
    const transport = new FakeTransport(undefined, async (write, fake) => {
      if (blockFirstRead && readMessageId(write.data) === 1) {
        blockFirstRead = false
        await blockedRead
      }
      await responder(write, fake)
    })
    await transport.connect()
    const client = new ModernEvoClient(transport)
    clients.push(client)

    const telemetry = client.readTelemetry()
    await vi.waitFor(() => expect(transport.writes).toHaveLength(1))
    const movement = client.setWheels(100, 100, 250)
    releaseRead()
    await movement
    expect(transport.writes.slice(0, 2).map((write) => readMessageId(write.data)))
      .toEqual([1, 104])
    await telemetry
  })

  it('drains a delayed uncorrelated response before retrying a safety read', async () => {
    vi.useFakeTimers()
    try {
      let safetyReads = 0
      const diagnostics: string[] = []
      const transport = new FakeTransport(undefined, ({ data }, fake) => {
        if (readMessageId(data) !== 1) return
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
        const address = view.getUint32(2, true)
        const length = view.getUint16(6, true)
        if (address === 113 && length === 13) {
          safetyReads += 1
          const response = safetyReads === 1
            ? memoryResponse([1, 1, 0, 0, 0, 90, 0, 0, 0, 0, 0, 0, 0])
            : memoryResponse([0, 2, 0, 0, 0, 1, 2, 3, 4, 0, 0, 0, 0])
          if (safetyReads === 1) {
            setTimeout(() => fake.emit(response), 1_100)
          } else {
            queueMicrotask(() => fake.emit(response))
          }
          return
        }
        setTimeout(() => fake.emit(memoryResponse(new Array<number>(length).fill(0))), 200)
      })
      await transport.connect()
      const client = new ModernEvoClient(transport, (message) => diagnostics.push(message))
      clients.push(client)
      const retry = vi.fn()

      const sample = client.readReactiveSafetySensors(undefined, retry)
      await vi.advanceTimersByTimeAsync(1_201)
      await expect(sample).resolves.toMatchObject({
        pickup: { pickedUp: false, timestamp: 2 },
        proximity: { leftRear: 1, leftFront: 2, rightRear: 3, rightFront: 4 },
      })
      expect(retry).toHaveBeenCalled()
      expect(safetyReads).toBe(2)
      expect(diagnostics).toContain(
        'Discarded late memory response after an uncorrelated timeout',
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('waits for terminal audio state after response 119', async () => {
    let toneRequestId = 0
    const transport = new FakeTransport(undefined, ({ data }, fake) => {
      if (readMessageId(data) !== 118) return
      toneRequestId = requestIdOf(data)
      queueMicrotask(() => fake.emit(requestResponse(119, toneRequestId)))
    })
    await transport.connect()
    const client = new ModernEvoClient(transport)
    clients.push(client)
    let settled = false

    const tone = client.playTone(392, 140).then(() => {
      settled = true
    })
    await vi.waitFor(() => expect(toneRequestId).not.toBe(0))
    await Promise.resolve()
    expect(settled).toBe(false)
    transport.emit(audioState(toneRequestId, EXECUTION_STATE.running))
    expect(settled).toBe(false)
    transport.emit(audioState(toneRequestId, EXECUTION_STATE.finishedNormal))
    await tone
    expect(settled).toBe(true)
  })

  it('uses a normal audio completion event when response 119 is lost', async () => {
    const diagnostics: string[] = []
    let toneRequestId = 0
    const transport = new FakeTransport(undefined, ({ data }, fake) => {
      if (readMessageId(data) !== 118) return
      toneRequestId = requestIdOf(data)
      queueMicrotask(() => fake.emit(audioState(toneRequestId, EXECUTION_STATE.running)))
      queueMicrotask(() => fake.emit(audioState(toneRequestId, EXECUTION_STATE.finishedNormal)))
    })
    await transport.connect()
    const client = new ModernEvoClient(transport, (message) => diagnostics.push(message))
    clients.push(client)

    await expect(client.playTone(392, 140)).resolves.toBeUndefined()
    expect(await client.stopSound()).toBe(false)
    transport.emit(requestResponse(119, toneRequestId))
    expect(diagnostics).toEqual([])
  })

  it('rejects a correlated audio execution failure', async () => {
    const transport = new FakeTransport(undefined, ({ data }, fake) => {
      if (readMessageId(data) !== 118) return
      const requestId = requestIdOf(data)
      queueMicrotask(() => fake.emit(requestResponse(119, requestId)))
      queueMicrotask(() => fake.emit(audioState(requestId, EXECUTION_STATE.invalidRequest)))
    })
    await transport.connect()
    const client = new ModernEvoClient(transport)
    clients.push(client)

    await expect(client.playTone(392, 140)).rejects.toThrow(/invalidRequest/)
  })

  it('uses a duration-aware wait for a long tone when response 119 is lost', async () => {
    vi.useFakeTimers()
    try {
      const transport = new FakeTransport(undefined, ({ data }, fake) => {
        if (readMessageId(data) !== 118) return
        const requestId = requestIdOf(data)
        queueMicrotask(() => fake.emit(audioState(requestId, EXECUTION_STATE.running)))
        setTimeout(() => {
          fake.emit(audioState(requestId, EXECUTION_STATE.finishedNormal))
        }, 3_000)
      })
      await transport.connect()
      const client = new ModernEvoClient(transport)
      clients.push(client)

      const assertion = expect(client.playTone(392, 3_000)).resolves.toBeUndefined()
      await vi.advanceTimersByTimeAsync(3_001)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels queued tones without sending them after stopSound', async () => {
    let releaseRead!: () => void
    const blockedRead = new Promise<void>((resolve) => {
      releaseRead = resolve
    })
    let blockReads = false
    const responder = createModernResponder()
    const transport = new FakeTransport(undefined, async (write, fake) => {
      const messageId = readMessageId(write.data)
      if (messageId === 118) {
        queueMicrotask(() => fake.emit(requestResponse(119, requestIdOf(write.data))))
        return
      }
      if (messageId === 1 && blockReads) await blockedRead
      await responder(write, fake)
    })
    await transport.connect()
    const client = new ModernEvoClient(transport)
    clients.push(client)

    const firstTone = client.playTone(392, 1_000).catch((error: unknown) => error)
    await vi.waitFor(() => {
      expect(transport.writes.filter((write) => readMessageId(write.data) === 118))
        .toHaveLength(1)
    })
    blockReads = true
    const firmware = client.readFirmware()
    await vi.waitFor(() => {
      expect(transport.writes.some((write) => readMessageId(write.data) === 1)).toBe(true)
    })
    const queuedTone = client.playTone(523, 1_000).catch((error: unknown) => error)

    await expect(client.stopSound()).resolves.toBe(true)
    releaseRead()
    await firmware
    await expect(firstTone).resolves.toMatchObject({ name: 'RequestCancelledError' })
    await expect(queuedTone).resolves.toMatchObject({ name: 'RequestCancelledError' })
    expect(transport.writes.filter((write) => readMessageId(write.data) === 118))
      .toHaveLength(1)
  })

  it('preempts an ordinary RPC with a priority stop', async () => {
    vi.useFakeTimers()
    try {
      const responder = createModernResponder()
      const transport = new FakeTransport(undefined, async (write, fake) => {
        if (readMessageId(write.data) === 1) return
        await responder(write, fake)
      })
      await transport.connect()
      const client = new ModernEvoClient(transport)
      clients.push(client)
      const telemetry = client.readTelemetry().catch((error: unknown) => error)
      await vi.waitFor(() => {
        expect(transport.writes.map((write) => readMessageId(write.data))).toEqual([1])
      })

      await client.stopMovement(true)
      expect(transport.writes.map((write) => readMessageId(write.data))).toEqual([1, 120])
      expect(transport.writes[1].options?.priority).toBe(true)

      await expect(telemetry).resolves.toMatchObject({
        message: expect.stringContaining('cancelled'),
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not use a late stop acknowledgment for a newer stop', async () => {
    vi.useFakeTimers()
    try {
      const transport = new FakeTransport(undefined, () => undefined)
      await transport.connect()
      const client = new ModernEvoClient(transport)
      clients.push(client)

      for (let index = 0; index < 2; index += 1) {
        const timedOutStop = client.stopMovement()
        const assertion = expect(timedOutStop).rejects.toThrow(/Timed out/)
        await vi.advanceTimersByTimeAsync(1_001)
        await assertion
      }

      let settled = false
      const currentStop = client.stopMovement().then(() => {
        settled = true
      })
      await vi.waitFor(() => expect(transport.writes).toHaveLength(3))
      transport.emit(requestResponse(121, 0))
      await Promise.resolve()
      expect(settled).toBe(false)

      transport.emit(requestResponse(121, 0))
      await Promise.resolve()
      expect(settled).toBe(false)

      transport.emit(requestResponse(121, 0))
      await currentStop
      expect(settled).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores a cancelled write failure after a new memory request starts', async () => {
    let rejectCancelledWrite!: (error: Error) => void
    const cancelledWrite = new Promise<void>((_, reject) => {
      rejectCancelledWrite = reject
    })
    let memoryWrites = 0
    const transport = new FakeTransport(undefined, ({ data }) => {
      if (readMessageId(data) !== 1) return
      memoryWrites += 1
      if (memoryWrites === 1) return cancelledWrite
    })
    await transport.connect()
    const client = new ModernEvoClient(transport)
    clients.push(client)

    const cancelledRead = client.readFirmware()
    await vi.waitFor(() => expect(memoryWrites).toBe(1))
    client.cancelOrdinaryRequests()
    await expect(cancelledRead).rejects.toThrow(/cancelled/)

    const nextRead = client.readFirmware()
    await vi.waitFor(() => expect(memoryWrites).toBe(2))
    rejectCancelledWrite(new Error('cancelled write settled late'))
    await Promise.resolve()

    transport.emit(memoryResponse([0]))
    await vi.waitFor(() => expect(memoryWrites).toBe(3))
    transport.emit(memoryResponse([3, 7, 4, 0]))
    await expect(nextRead).resolves.toEqual({ version: '3.7.4', rawMajor: 3 })
  })

  it('rejects unsolicited malformed notifications without breaking later requests', async () => {
    const diagnostics: string[] = []
    const transport = new FakeTransport(undefined, createModernResponder())
    await transport.connect()
    const client = new ModernEvoClient(transport, (message) => diagnostics.push(message))
    clients.push(client)
    transport.emit(Uint8Array.of(1))
    transport.emit(Uint8Array.of(0xff, 0xff))
    await client.initialize()
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.stringContaining('malformed'),
      expect.stringContaining('unsolicited'),
    ]))
  })

  it('serializes no-ID LED responses safely', async () => {
    const transport = new FakeTransport(undefined, createModernResponder())
    await transport.connect()
    const client = new ModernEvoClient(transport)
    clients.push(client)
    await Promise.all([
      client.setLed(1, 1, 2, 3),
      client.setLed(2, 4, 5, 6),
    ])
    expect(transport.writes.map((write) => readMessageId(write.data))).toEqual([110, 110])
  })

  it('classifies a missing 105 acknowledgment as a movement timeout', async () => {
    vi.useFakeTimers()
    try {
      const responder = createModernResponder()
      const transport = new FakeTransport(undefined, async (write, fake) => {
        if (readMessageId(write.data) === 104) return
        await responder(write, fake)
      })
      await transport.connect()
      const client = new ModernEvoClient(transport, () => undefined, { movementTimeoutMs: 300 })
      clients.push(client)
      const movement = client.setWheels(120, 120, 250)
      const assertion = expect(movement).rejects.toBeInstanceOf(MovementTimeoutError)
      await vi.advanceTimersByTimeAsync(301)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })

  it('accepts delayed 105 acknowledgments within the movement timeout budget', async () => {
    vi.useFakeTimers()
    try {
      const responder = createModernResponder()
      const transport = new FakeTransport(undefined, async (write, fake) => {
        if (readMessageId(write.data) !== 104) {
          await responder(write, fake)
          return
        }
        const view = new DataView(write.data.buffer, write.data.byteOffset, write.data.byteLength)
        const response = new Uint8Array(6)
        const responseView = new DataView(response.buffer)
        responseView.setUint16(0, 105, true)
        responseView.setUint32(2, view.getUint32(2, true), true)
        setTimeout(() => fake.emit(response), 250)
      })
      await transport.connect()
      const client = new ModernEvoClient(transport, () => undefined, { movementTimeoutMs: 400 })
      clients.push(client)
      const movement = client.setWheels(120, 120, 250)
      await vi.advanceTimersByTimeAsync(251)
      await expect(movement).resolves.toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('starts the movement acknowledgment timeout after the write completes', async () => {
    vi.useFakeTimers()
    try {
      const transport = new FakeTransport(undefined, async (write, fake) => {
        await new Promise((resolve) => setTimeout(resolve, 250))
        const request = new DataView(write.data.buffer, write.data.byteOffset, write.data.byteLength)
        const response = new Uint8Array(6)
        const responseView = new DataView(response.buffer)
        responseView.setUint16(0, 105, true)
        responseView.setUint32(2, request.getUint32(2, true), true)
        setTimeout(() => fake.emit(response), 250)
      })
      await transport.connect()
      const client = new ModernEvoClient(transport, () => undefined, { movementTimeoutMs: 300 })
      clients.push(client)
      const movement = client.setWheels(120, 120, 250)
      await vi.advanceTimersByTimeAsync(501)
      await expect(movement).resolves.toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not classify a movement write deadline as an acknowledgment timeout', async () => {
    vi.useFakeTimers()
    try {
      const transport = new FakeTransport(undefined, () => new Promise(() => undefined))
      await transport.connect()
      const client = new ModernEvoClient(transport, () => undefined, { movementTimeoutMs: 300 })
      clients.push(client)
      const movement = client.setWheels(120, 120, 250)
      const assertion = expect(movement).rejects.not.toBeInstanceOf(MovementTimeoutError)
      await vi.advanceTimersByTimeAsync(301)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not emit diagnostics for successful movement lifecycle events', async () => {
    const diagnostics: string[] = []
    const transport = new FakeTransport(undefined, createModernResponder())
    await transport.connect()
    const client = new ModernEvoClient(transport, (message) => diagnostics.push(message))
    clients.push(client)
    await client.setWheels(100, 100, 250)
    expect(diagnostics).toEqual([])
  })

  it('classifies queued movement replacement as superseded instead of timeout', async () => {
    const transport = new FakeTransport(undefined, async (write, fake) => {
      if (readMessageId(write.data) === 104) {
        throw new TransportQueueCancelledError('replaced', 'movement')
      }
      await createModernResponder()(write, fake)
    })
    await transport.connect()
    const client = new ModernEvoClient(transport)
    clients.push(client)
    await expect(client.setWheels(80, 80, 250)).rejects.toBeInstanceOf(MovementSupersededError)
  })
})
