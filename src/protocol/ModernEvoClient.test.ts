import { afterEach, describe, expect, it, vi } from 'vitest'
import { FakeTransport, createModernResponder } from '../test/FakeTransport.ts'
import { TransportQueueCancelledError } from '../transport/EvoTransport.ts'
import { ModernEvoClient, MovementSupersededError, MovementTimeoutError } from './ModernEvoClient.ts'
import { readMessageId } from './modernCodec.ts'

const clients: ModernEvoClient[] = []

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
