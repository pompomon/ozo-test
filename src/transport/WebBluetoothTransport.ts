import {
  EVO_3_PROFILE,
  LEGACY_CONTROL_UUID,
  LEGACY_DRIVE_UUID,
  LEGACY_PROFILE,
  LEGACY_SERVICE_UUID,
  MODERN_CONTROL_UUID,
  MODERN_SERVICE_UUID,
  type ProtocolProfile,
} from '../protocol/profile.ts'
import type {
  DisconnectHandler,
  EvoTransport,
  PacketHandler,
  TransportChannel,
  TransportConnection,
  TransportWriteOptions,
} from './EvoTransport.ts'

interface WriteTask {
  readonly data: Uint8Array
  readonly channel: TransportChannel
  readonly replaceKey?: string
  readonly resolve: () => void
  readonly reject: (error: Error) => void
}

const requestOptions: RequestDeviceOptions = {
  filters: [
    { services: [MODERN_SERVICE_UUID] },
    { namePrefix: 'OzoEvo' },
    { namePrefix: 'Evo' },
    {
      manufacturerData: [
        {
          companyIdentifier: 0x03eb,
          dataPrefix: Uint8Array.of(0),
        },
      ],
    },
  ],
  optionalServices: [MODERN_SERVICE_UUID, LEGACY_SERVICE_UUID],
}

function toError(value: unknown, fallback: string): Error {
  return value instanceof Error ? value : new Error(fallback)
}

export function webBluetoothSupport(): { supported: boolean; reason?: string } {
  if (!globalThis.isSecureContext) {
    return { supported: false, reason: 'Web Bluetooth requires HTTPS or localhost.' }
  }
  if (!navigator.bluetooth) {
    return {
      supported: false,
      reason: 'Web Bluetooth is unavailable. Use current Chrome on Android or Chrome/Edge on Windows.',
    }
  }
  return { supported: true }
}

export class WebBluetoothTransport implements EvoTransport {
  private device?: BluetoothDevice
  private server?: BluetoothRemoteGATTServer
  private controlCharacteristic?: BluetoothRemoteGATTCharacteristic
  private driveCharacteristic?: BluetoothRemoteGATTCharacteristic
  private packetHandlers = new Set<PacketHandler>()
  private disconnectHandlers = new Set<DisconnectHandler>()
  private writeQueue: WriteTask[] = []
  private writing = false
  private intentionalDisconnect = false

  connection?: TransportConnection

  get connected(): boolean {
    return this.server?.connected === true && this.connection !== undefined
  }

  async connect(): Promise<TransportConnection> {
    const support = webBluetoothSupport()
    if (!support.supported) {
      throw new Error(support.reason)
    }
    await this.disconnect()
    this.intentionalDisconnect = false

    const device = await navigator.bluetooth!.requestDevice(requestOptions)
    if (!device.gatt) {
      throw new Error('The selected device does not expose a Bluetooth GATT server.')
    }

    this.device = device
    device.addEventListener('gattserverdisconnected', this.handleGattDisconnect)
    this.server = await device.gatt.connect()

    try {
      const profile = await this.discoverProfile(this.server)
      this.connection = {
        name: device.name?.slice(0, 40) || 'Ozobot Evo',
        profile,
      }
      return this.connection
    } catch (error) {
      await this.disconnect()
      throw toError(error, 'The selected device is not a compatible Ozobot Evo.')
    }
  }

  async disconnect(): Promise<void> {
    this.intentionalDisconnect = true
    this.failQueued(new Error('Bluetooth connection closed'))
    if (this.controlCharacteristic && this.connection?.profile.id === 'evo-3') {
      this.controlCharacteristic.removeEventListener('characteristicvaluechanged', this.handleNotification)
      try {
        await this.controlCharacteristic.stopNotifications()
      } catch {
        // The platform may already have torn down GATT.
      }
    }
    if (this.device) {
      this.device.removeEventListener('gattserverdisconnected', this.handleGattDisconnect)
    }
    if (this.server?.connected) {
      this.server.disconnect()
    }
    this.resetConnection()
  }

  write(
    data: Uint8Array,
    channel: TransportChannel,
    options: TransportWriteOptions = {},
  ): Promise<void> {
    if (!this.connected) {
      return Promise.reject(new Error('Evo is not connected'))
    }
    return new Promise<void>((resolve, reject) => {
      if (options.replaceKey) {
        this.removeQueued(options.replaceKey)
      }
      const task: WriteTask = {
        data: data.slice(),
        channel,
        replaceKey: options.replaceKey,
        resolve,
        reject,
      }
      if (options.priority) {
        this.writeQueue.unshift(task)
      } else {
        this.writeQueue.push(task)
      }
      void this.drainWrites()
    })
  }

  clearQueued(replaceKey?: string): void {
    if (replaceKey) {
      this.removeQueued(replaceKey)
      return
    }
    for (const task of this.writeQueue.splice(0)) {
      task.resolve()
    }
  }

  subscribe(handler: PacketHandler): () => void {
    this.packetHandlers.add(handler)
    return () => this.packetHandlers.delete(handler)
  }

  onDisconnect(handler: DisconnectHandler): () => void {
    this.disconnectHandlers.add(handler)
    return () => this.disconnectHandlers.delete(handler)
  }

  private async discoverProfile(server: BluetoothRemoteGATTServer): Promise<ProtocolProfile> {
    try {
      const service = await server.getPrimaryService(MODERN_SERVICE_UUID)
      this.controlCharacteristic = await service.getCharacteristic(MODERN_CONTROL_UUID)
      await this.controlCharacteristic.startNotifications()
      this.controlCharacteristic.addEventListener('characteristicvaluechanged', this.handleNotification)
      return EVO_3_PROFILE
    } catch (modernError) {
      try {
        const service = await server.getPrimaryService(LEGACY_SERVICE_UUID)
        this.driveCharacteristic = await service.getCharacteristic(LEGACY_DRIVE_UUID)
        this.controlCharacteristic = await service.getCharacteristic(LEGACY_CONTROL_UUID)
        return LEGACY_PROFILE
      } catch {
        throw toError(modernError, 'No supported Evo Bluetooth service was found.')
      }
    }
  }

  private readonly handleNotification = (event: Event): void => {
    const characteristic = event.target as BluetoothRemoteGATTCharacteristic
    const value = characteristic.value
    if (!value || value.byteLength > 512) return
    const packet = new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice()
    for (const handler of this.packetHandlers) {
      handler(packet)
    }
  }

  private readonly handleGattDisconnect = (): void => {
    if (this.intentionalDisconnect) return
    const error = new Error('Evo disconnected unexpectedly')
    this.failQueued(error)
    this.resetConnection()
    for (const handler of this.disconnectHandlers) {
      handler(error)
    }
  }

  private async drainWrites(): Promise<void> {
    if (this.writing) return
    this.writing = true
    try {
      while (this.writeQueue.length > 0) {
        const task = this.writeQueue.shift()!
        try {
          const characteristic =
            task.channel === 'drive' ? this.driveCharacteristic : this.controlCharacteristic
          if (!characteristic || !this.connected) {
            throw new Error(`The Evo ${task.channel} characteristic is unavailable`)
          }
          await this.writeCharacteristic(characteristic, task.data)
          task.resolve()
        } catch (error) {
          task.reject(toError(error, 'Bluetooth write failed'))
        }
      }
    } finally {
      this.writing = false
    }
  }

  private async writeCharacteristic(
    characteristic: BluetoothRemoteGATTCharacteristic,
    data: Uint8Array,
  ): Promise<void> {
    const value: ArrayBuffer = Uint8Array.from(data).buffer
    if (characteristic.properties.writeWithoutResponse && characteristic.writeValueWithoutResponse) {
      await characteristic.writeValueWithoutResponse(value)
      return
    }
    if (characteristic.writeValueWithResponse) {
      await characteristic.writeValueWithResponse(value)
      return
    }
    await characteristic.writeValue(value)
  }

  private removeQueued(replaceKey: string): void {
    const retained: WriteTask[] = []
    for (const task of this.writeQueue) {
      if (task.replaceKey === replaceKey) {
        task.resolve()
      } else {
        retained.push(task)
      }
    }
    this.writeQueue = retained
  }

  private failQueued(error: Error): void {
    for (const task of this.writeQueue.splice(0)) {
      task.reject(error)
    }
  }

  private resetConnection(): void {
    this.controlCharacteristic = undefined
    this.driveCharacteristic = undefined
    this.server = undefined
    this.device = undefined
    this.connection = undefined
  }
}
