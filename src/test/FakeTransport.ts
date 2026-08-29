import { EVO_3_PROFILE, type ProtocolProfile } from '../protocol/profile.ts'
import type {
  DisconnectHandler,
  EvoTransport,
  PacketHandler,
  TransportChannel,
  TransportConnection,
  TransportWriteOptions,
} from '../transport/EvoTransport.ts'

export interface RecordedWrite {
  readonly data: Uint8Array
  readonly channel: TransportChannel
  readonly options?: TransportWriteOptions
}

export type WriteResponder = (write: RecordedWrite, transport: FakeTransport) => void | Promise<void>

export class FakeTransport implements EvoTransport {
  readonly profile: ProtocolProfile
  private readonly responder?: WriteResponder
  connected = false
  connection?: TransportConnection
  readonly writes: RecordedWrite[] = []
  readonly clearedReplaceKeys: (string | undefined)[] = []
  private readonly packetHandlers = new Set<PacketHandler>()
  private readonly disconnectHandlers = new Set<DisconnectHandler>()

  constructor(
    profile: ProtocolProfile = EVO_3_PROFILE,
    responder?: WriteResponder,
  ) {
    this.profile = profile
    this.responder = responder
  }

  async connect(): Promise<TransportConnection> {
    this.connected = true
    this.connection = { name: 'OzoEvo-Test', profile: this.profile }
    return this.connection
  }

  async disconnect(): Promise<void> {
    this.connected = false
    this.connection = undefined
  }

  async write(
    data: Uint8Array,
    channel: TransportChannel,
    options?: TransportWriteOptions,
  ): Promise<void> {
    if (!this.connected) throw new Error('Fake transport is disconnected')
    const write = { data: data.slice(), channel, options }
    this.writes.push(write)
    await this.responder?.(write, this)
  }

  clearQueued(replaceKey?: string): void {
    this.clearedReplaceKeys.push(replaceKey)
  }

  subscribe(handler: PacketHandler): () => void {
    this.packetHandlers.add(handler)
    return () => this.packetHandlers.delete(handler)
  }

  onDisconnect(handler: DisconnectHandler): () => void {
    this.disconnectHandlers.add(handler)
    return () => this.disconnectHandlers.delete(handler)
  }

  emit(packet: Uint8Array): void {
    for (const handler of this.packetHandlers) handler(packet.slice())
  }

  simulateDisconnect(reason = new Error('Simulated disconnect')): void {
    this.connected = false
    this.connection = undefined
    for (const handler of this.disconnectHandlers) handler(reason)
  }
}

export interface MutableModernResponder {
  readonly responder: WriteResponder
  setMemory(address: number, data: readonly number[]): void
}

function audioExecutionState(requestId: number, executionState: number): Uint8Array {
  const response = new Uint8Array(7)
  const view = new DataView(response.buffer)
  view.setUint16(0, 259, true)
  view.setUint32(2, requestId, true)
  response[6] = executionState
  return response
}

export function createMutableModernResponder(
  memoryOverrides: Readonly<Record<number, readonly number[]>> = {},
): MutableModernResponder {
  const memory = new Uint8Array(65_700)
  memory.set([3, 7, 4, 0], 65_580)
  for (const [address, data] of Object.entries(memoryOverrides)) {
    memory.set(data, Number(address))
  }

  const responder: WriteResponder = ({ data }, transport): void => {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
    const messageId = view.getUint16(0, true)
    let response: Uint8Array | undefined
    if (messageId === 1) {
      const address = view.getUint32(2, true)
      const length = view.getUint16(6, true)
      response = new Uint8Array(5 + length)
      const responseView = new DataView(response.buffer)
      responseView.setUint16(0, 2, true)
      response[2] = 0
      responseView.setUint16(3, length, true)
      response.set(memory.slice(address, address + length), 5)
    } else if ([104, 118, 120].includes(messageId)) {
      const responseIds: Readonly<Record<number, number>> = { 104: 105, 118: 119, 120: 121 }
      response = new Uint8Array(6)
      const responseView = new DataView(response.buffer)
      const requestId = view.getUint32(2, true)
      responseView.setUint16(0, responseIds[messageId], true)
      responseView.setUint32(2, requestId, true)
      if (messageId === 118) {
        const durationMs = view.getUint16(8, true)
        queueMicrotask(() => transport.emit(response!))
        queueMicrotask(() => transport.emit(audioExecutionState(requestId, 0)))
        setTimeout(() => transport.emit(audioExecutionState(requestId, 1)), durationMs)
        return
      }
    } else if (messageId === 110) {
      response = Uint8Array.of(111, 0, 0)
    }
    if (response) queueMicrotask(() => transport.emit(response))
  }

  return {
    responder,
    setMemory(address, data) {
      memory.set(data, address)
    },
  }
}

export function createModernResponder(
  memoryOverrides: Readonly<Record<number, readonly number[]>> = {},
): WriteResponder {
  return createMutableModernResponder(memoryOverrides).responder
}
