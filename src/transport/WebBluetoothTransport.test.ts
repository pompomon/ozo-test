import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  LEGACY_CONTROL_UUID,
  LEGACY_DRIVE_UUID,
  LEGACY_SERVICE_UUID,
  MODERN_CONTROL_UUID,
  MODERN_SERVICE_UUID,
} from '../protocol/profile.ts'
import { WebBluetoothTransport, webBluetoothSupport } from './WebBluetoothTransport.ts'

class FakeCharacteristic extends EventTarget implements BluetoothRemoteGATTCharacteristic {
  readonly properties = {
    notify: true,
    indicate: false,
    write: true,
    writeWithoutResponse: true,
  }
  readonly service: BluetoothRemoteGATTService
  readonly uuid: string
  value?: DataView
  readonly writes: Uint8Array[] = []

  constructor(service: BluetoothRemoteGATTService, uuid: string) {
    super()
    this.service = service
    this.uuid = uuid
  }

  async startNotifications(): Promise<BluetoothRemoteGATTCharacteristic> {
    return this
  }

  async stopNotifications(): Promise<BluetoothRemoteGATTCharacteristic> {
    return this
  }

  async writeValue(value: BufferSource): Promise<void> {
    this.record(value)
  }

  async writeValueWithResponse(value: BufferSource): Promise<void> {
    this.record(value)
  }

  async writeValueWithoutResponse(value: BufferSource): Promise<void> {
    this.record(value)
  }

  notify(bytes: Uint8Array): void {
    this.value = new DataView(Uint8Array.from(bytes).buffer)
    this.dispatchEvent(new Event('characteristicvaluechanged'))
  }

  private record(value: BufferSource): void {
    const bytes =
      value instanceof ArrayBuffer
        ? new Uint8Array(value)
        : new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    this.writes.push(bytes.slice())
  }
}

class FakeService implements BluetoothRemoteGATTService {
  readonly device: BluetoothDevice
  readonly uuid: string
  readonly characteristics = new Map<string, FakeCharacteristic>()

  constructor(device: BluetoothDevice, uuid: string) {
    this.device = device
    this.uuid = uuid
  }

  async getCharacteristic(uuid: BluetoothCharacteristicUUID): Promise<BluetoothRemoteGATTCharacteristic> {
    const characteristic = this.characteristics.get(String(uuid))
    if (!characteristic) throw new DOMException('Missing characteristic', 'NotFoundError')
    return characteristic
  }
}

class FakeServer implements BluetoothRemoteGATTServer {
  connected = false
  readonly device: BluetoothDevice
  readonly services = new Map<string, FakeService>()

  constructor(device: BluetoothDevice) {
    this.device = device
  }

  async connect(): Promise<BluetoothRemoteGATTServer> {
    this.connected = true
    return this
  }

  disconnect(): void {
    this.connected = false
  }

  async getPrimaryService(uuid: BluetoothServiceUUID): Promise<BluetoothRemoteGATTService> {
    const service = this.services.get(String(uuid))
    if (!service) throw new DOMException('Missing service', 'NotFoundError')
    return service
  }
}

class FakeDevice extends EventTarget implements BluetoothDevice {
  readonly id = 'private-test-id'
  readonly name = 'OzoEvo-Test'
  readonly gatt: FakeServer

  constructor() {
    super()
    this.gatt = new FakeServer(this)
  }
}

function modernDevice(): { device: FakeDevice; characteristic: FakeCharacteristic } {
  const device = new FakeDevice()
  const service = new FakeService(device, MODERN_SERVICE_UUID)
  const characteristic = new FakeCharacteristic(service, MODERN_CONTROL_UUID)
  service.characteristics.set(MODERN_CONTROL_UUID, characteristic)
  device.gatt.services.set(MODERN_SERVICE_UUID, service)
  return { device, characteristic }
}

function setBluetooth(bluetooth: Bluetooth | undefined): void {
  Object.defineProperty(navigator, 'bluetooth', { configurable: true, value: bluetooth })
}

afterEach(() => {
  Object.defineProperty(globalThis, 'isSecureContext', { configurable: true, value: true })
  setBluetooth({
    requestDevice: () => Promise.reject(new DOMException('No device selected', 'NotFoundError')),
  })
})

describe('WebBluetoothTransport', () => {
  it('reports secure-context and browser support failures', () => {
    Object.defineProperty(globalThis, 'isSecureContext', { configurable: true, value: false })
    expect(webBluetoothSupport()).toEqual({
      supported: false,
      reason: 'Web Bluetooth requires HTTPS or localhost.',
    })
    Object.defineProperty(globalThis, 'isSecureContext', { configurable: true, value: true })
    setBluetooth(undefined)
    expect(webBluetoothSupport().reason).toContain('Chrome')
  })

  it('surfaces device-picker permission denial', async () => {
    setBluetooth({
      requestDevice: vi.fn(() => Promise.reject(new DOMException('Permission denied', 'SecurityError'))),
    })
    await expect(new WebBluetoothTransport().connect()).rejects.toThrow('Permission denied')
  })

  it('discovers the modern service, writes, and copies notifications', async () => {
    const { device, characteristic } = modernDevice()
    const requestDevice = vi.fn(() => Promise.resolve(device))
    setBluetooth({ requestDevice })
    const transport = new WebBluetoothTransport()
    const connection = await transport.connect()
    expect(connection.profile.id).toBe('evo-3')

    const packets: Uint8Array[] = []
    transport.subscribe((packet) => packets.push(packet))
    characteristic.notify(Uint8Array.of(121, 0, 0, 0, 0, 0))
    characteristic.value!.setUint8(0, 99)
    expect([...packets[0]]).toEqual([121, 0, 0, 0, 0, 0])

    await transport.write(Uint8Array.of(1, 2, 3), 'control')
    expect([...characteristic.writes[0]]).toEqual([1, 2, 3])
    expect(requestDevice).toHaveBeenCalledWith(expect.objectContaining({
      optionalServices: expect.arrayContaining([MODERN_SERVICE_UUID, LEGACY_SERVICE_UUID]),
    }))
    await transport.disconnect()
  })

  it('detects the legacy characteristics but marks the profile incomplete', async () => {
    const device = new FakeDevice()
    const service = new FakeService(device, LEGACY_SERVICE_UUID)
    const drive = new FakeCharacteristic(service, LEGACY_DRIVE_UUID)
    const control = new FakeCharacteristic(service, LEGACY_CONTROL_UUID)
    service.characteristics.set(LEGACY_DRIVE_UUID, drive)
    service.characteristics.set(LEGACY_CONTROL_UUID, control)
    device.gatt.services.set(LEGACY_SERVICE_UUID, service)
    setBluetooth({ requestDevice: () => Promise.resolve(device) })

    const transport = new WebBluetoothTransport()
    expect((await transport.connect()).profile.id).toBe('legacy')
    await transport.write(Uint8Array.of(0x40), 'drive')
    expect([...drive.writes[0]]).toEqual([0x40])
    await transport.disconnect()
  })
})

