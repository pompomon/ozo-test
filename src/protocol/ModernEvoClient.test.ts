import { afterEach, describe, expect, it } from 'vitest'
import { FakeTransport, createModernResponder } from '../test/FakeTransport.ts'
import { ModernEvoClient } from './ModernEvoClient.ts'
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
    expect(diagnostics).toEqual([
      expect.stringContaining('malformed'),
      expect.stringContaining('unsolicited'),
    ])
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
})

