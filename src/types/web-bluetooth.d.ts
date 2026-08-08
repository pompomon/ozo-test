interface BluetoothRequestDeviceFilter {
  name?: string
  namePrefix?: string
  services?: BluetoothServiceUUID[]
  manufacturerData?: BluetoothManufacturerDataFilter[]
}

interface BluetoothManufacturerDataFilter {
  companyIdentifier: number
  dataPrefix?: BufferSource
  mask?: BufferSource
}

interface RequestDeviceOptions {
  filters?: BluetoothRequestDeviceFilter[]
  optionalServices?: BluetoothServiceUUID[]
  acceptAllDevices?: boolean
}

type BluetoothServiceUUID = number | string
type BluetoothCharacteristicUUID = number | string

interface Bluetooth {
  getAvailability?(): Promise<boolean>
  requestDevice(options?: RequestDeviceOptions): Promise<BluetoothDevice>
}

interface BluetoothDevice extends EventTarget {
  readonly id: string
  readonly name?: string
  readonly gatt?: BluetoothRemoteGATTServer
}

interface BluetoothRemoteGATTServer {
  readonly connected: boolean
  readonly device: BluetoothDevice
  connect(): Promise<BluetoothRemoteGATTServer>
  disconnect(): void
  getPrimaryService(service: BluetoothServiceUUID): Promise<BluetoothRemoteGATTService>
}

interface BluetoothRemoteGATTService {
  readonly device: BluetoothDevice
  readonly uuid: string
  getCharacteristic(characteristic: BluetoothCharacteristicUUID): Promise<BluetoothRemoteGATTCharacteristic>
}

interface BluetoothCharacteristicProperties {
  readonly notify: boolean
  readonly indicate: boolean
  readonly write: boolean
  readonly writeWithoutResponse: boolean
}

interface BluetoothRemoteGATTCharacteristic extends EventTarget {
  readonly properties: BluetoothCharacteristicProperties
  readonly service: BluetoothRemoteGATTService
  readonly uuid: string
  readonly value?: DataView
  startNotifications(): Promise<BluetoothRemoteGATTCharacteristic>
  stopNotifications(): Promise<BluetoothRemoteGATTCharacteristic>
  writeValue(value: BufferSource): Promise<void>
  writeValueWithResponse?(value: BufferSource): Promise<void>
  writeValueWithoutResponse?(value: BufferSource): Promise<void>
}

interface WakeLockSentinel extends EventTarget {
  readonly released: boolean
  readonly type: 'screen'
  release(): Promise<void>
}

interface WakeLock {
  request(type: 'screen'): Promise<WakeLockSentinel>
}

interface Navigator {
  readonly bluetooth?: Bluetooth
  readonly wakeLock?: WakeLock
}

