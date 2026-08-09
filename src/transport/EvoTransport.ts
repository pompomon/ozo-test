import type { ProtocolProfile } from '../protocol/profile.ts'

export type TransportChannel = 'control' | 'drive'

export type TransportQueueCancelReason = 'replaced' | 'cleared'

export class TransportQueueCancelledError extends Error {
  readonly replaceKey?: string
  readonly reason: TransportQueueCancelReason

  constructor(reason: TransportQueueCancelReason, replaceKey?: string) {
    super(
      reason === 'replaced'
        ? `Queued write was replaced${replaceKey ? ` (${replaceKey})` : ''}`
        : `Queued write was cleared${replaceKey ? ` (${replaceKey})` : ''}`,
    )
    this.name = 'TransportQueueCancelledError'
    this.reason = reason
    this.replaceKey = replaceKey
  }
}

export interface TransportWriteOptions {
  readonly priority?: boolean
  readonly replaceKey?: string
}

export interface TransportConnection {
  readonly name: string
  readonly profile: ProtocolProfile
}

export type PacketHandler = (packet: Uint8Array) => void
export type DisconnectHandler = (reason?: Error) => void

export interface EvoTransport {
  readonly connected: boolean
  readonly connection?: TransportConnection
  connect(): Promise<TransportConnection>
  disconnect(): Promise<void>
  write(data: Uint8Array, channel: TransportChannel, options?: TransportWriteOptions): Promise<void>
  clearQueued(replaceKey?: string): void
  subscribe(handler: PacketHandler): () => void
  onDisconnect(handler: DisconnectHandler): () => void
}
