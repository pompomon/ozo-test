import { decodeS8_24 } from './modernCodec.ts'

export interface Timestamped {
  readonly timestamp: number
}

export interface PickupState extends Timestamped {
  readonly pickedUp: boolean
}

export interface EvoTelemetry {
  readonly firmware: string
  readonly firmwareRawMajor: number
  readonly battery: Timestamped & {
    readonly voltageMv: number
    readonly percent: number
    readonly charging: boolean
  }
  readonly proximity: Timestamped & {
    readonly leftRear: number
    readonly leftFront: number
    readonly rightRear: number
    readonly rightFront: number
  }
  readonly colorSensor: Timestamped & {
    readonly red: number
    readonly green: number
    readonly blue: number
    readonly clear: number
    readonly lightSource: 'on' | 'off'
  }
  readonly processedColor: Timestamped & {
    readonly normalized: readonly [number, number, number]
    readonly transformed: readonly [number, number, number]
    readonly lightSource: 'on' | 'off'
  }
  readonly line: Timestamped & {
    readonly color: string
    readonly lightSource: 'on' | 'off'
  }
  readonly surfaceColor: Timestamped & {
    readonly color: string
    readonly lightSource: 'on' | 'off'
    readonly counter: number
  }
  readonly surface: Timestamped & {
    readonly type: string
    readonly proximity: number
    readonly pickedUp: boolean
  }
  readonly colorCode: Timestamped & { readonly code: number }
  readonly encoders: Timestamped & { readonly left: number; readonly right: number }
  readonly position: Timestamped & {
    readonly originCounter: number
    readonly x: number
    readonly y: number
    readonly angleX: number
    readonly angleY: number
  }
  readonly charger: Timestamped & { readonly state: string }
  readonly button: Timestamped & { readonly press: string }
  readonly lineSensors: Timestamped & {
    readonly raw: readonly number[]
    readonly normalized: readonly number[]
    readonly position: number
    readonly width: number
    readonly characteristics: number
    readonly bitmap: number
  }
  readonly irMessages: Readonly<Record<'leftRear' | 'leftFront' | 'rightRear' | 'rightFront', Timestamped & {
    readonly message: number
    readonly intensity: number
  }>>
  readonly receivedAt: number
}

export interface ReactiveSensors {
  readonly proximity: EvoTelemetry['proximity']
  readonly pickup: PickupState
  readonly button: EvoTelemetry['button']
  readonly receivedAt: number
}

export interface ReactiveSafetySensors {
  readonly proximity: EvoTelemetry['proximity']
  readonly pickup: PickupState
  readonly receivedAt: number
}

export const MEMORY_REGION = {
  firmware: { address: 65_580, length: 4 },
  lineSensors: { address: 0, length: 28 },
  colorSensor: { address: 56, length: 13 },
  processedColor: { address: 69, length: 11 },
  surfaceProximity: { address: 80, length: 6 },
  lineColor: { address: 86, length: 6 },
  colorCode: { address: 92, length: 8 },
  surfaceColor: { address: 100, length: 8 },
  surfaceType: { address: 108, length: 5 },
  pickup: { address: 113, length: 5 },
  proximity: { address: 118, length: 8 },
  reactiveSafety: { address: 113, length: 13 },
  irMessageLeftRear: { address: 126, length: 6 },
  irMessageLeftFront: { address: 132, length: 6 },
  irMessageRightRear: { address: 138, length: 6 },
  irMessageRightFront: { address: 144, length: 6 },
  encoders: { address: 150, length: 12 },
  position: { address: 162, length: 21 },
  charger: { address: 183, length: 5 },
  battery: { address: 188, length: 8 },
  button: { address: 196, length: 5 },
} as const

function viewOf(bytes: Uint8Array, expectedLength: number, label: string): DataView {
  if (bytes.length !== expectedLength) {
    throw new RangeError(`${label} must contain exactly ${expectedLength} bytes`)
  }
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

function timestamp(view: DataView, offset: number): number {
  return view.getUint32(offset, true)
}

function lightSource(value: number): 'on' | 'off' {
  if (value === 0) return 'off'
  if (value === 1) return 'on'
  throw new RangeError(`Invalid light source value ${value}`)
}

function enumName(value: number, values: Readonly<Record<number, string>>, label: string): string {
  return values[value] ?? `${label} (${value})`
}

export function parseFirmware(bytes: Uint8Array): { version: string; rawMajor: number } {
  const view = viewOf(bytes, 4, 'Firmware version')
  const rawMajor = bytes[0]
  const major = rawMajor & 0x7f
  return {
    version: `${major}.${bytes[1]}.${view.getUint16(2, true)}`,
    rawMajor,
  }
}

export function parseBattery(bytes: Uint8Array): EvoTelemetry['battery'] {
  const view = viewOf(bytes, 8, 'Battery state')
  const percent = bytes[2]
  if (percent > 100) {
    throw new RangeError(`Invalid battery percentage ${percent}`)
  }
  return {
    voltageMv: view.getUint16(0, true),
    percent,
    charging: (bytes[3] & 1) !== 0,
    timestamp: timestamp(view, 4),
  }
}

export function parseProximity(bytes: Uint8Array): EvoTelemetry['proximity'] {
  const view = viewOf(bytes, 8, 'IR proximity')
  return {
    leftRear: bytes[0],
    leftFront: bytes[1],
    rightRear: bytes[2],
    rightFront: bytes[3],
    timestamp: timestamp(view, 4),
  }
}

export function parseColorSensor(bytes: Uint8Array): EvoTelemetry['colorSensor'] {
  const view = viewOf(bytes, 13, 'Color sensor')
  return {
    red: view.getUint16(0, true),
    green: view.getUint16(2, true),
    blue: view.getUint16(4, true),
    clear: view.getUint16(6, true),
    lightSource: lightSource(bytes[8]),
    timestamp: timestamp(view, 9),
  }
}

export function parseProcessedColor(bytes: Uint8Array): EvoTelemetry['processedColor'] {
  const view = viewOf(bytes, 11, 'Processed color')
  return {
    normalized: [bytes[0], bytes[1], bytes[2]],
    transformed: [bytes[3], bytes[4], bytes[5]],
    lightSource: lightSource(bytes[6]),
    timestamp: timestamp(view, 7),
  }
}

const LINE_COLORS: Readonly<Record<number, string>> = { 0: 'Black', 1: 'Red', 2: 'Green', 3: 'Blue', 255: 'Unknown' }
const SURFACE_COLORS: Readonly<Record<number, string>> = {
  0: 'Black',
  1: 'Red',
  2: 'Green',
  3: 'Yellow',
  4: 'Blue',
  5: 'Magenta',
  6: 'Cyan',
  7: 'White',
  8: 'Unknown',
}

export function parseLineColor(bytes: Uint8Array): EvoTelemetry['line'] {
  const view = viewOf(bytes, 6, 'Line color')
  return {
    color: enumName(bytes[0], LINE_COLORS, 'Unknown'),
    lightSource: lightSource(bytes[1]),
    timestamp: timestamp(view, 2),
  }
}

export function parseSurfaceColor(bytes: Uint8Array): EvoTelemetry['surfaceColor'] {
  const view = viewOf(bytes, 8, 'Surface color')
  return {
    color: enumName(bytes[0], SURFACE_COLORS, 'Unknown'),
    lightSource: lightSource(bytes[1]),
    counter: view.getUint16(2, true),
    timestamp: timestamp(view, 4),
  }
}

export function parseSurface(
  typeBytes: Uint8Array,
  proximityBytes: Uint8Array,
  pickupBytes: Uint8Array,
): EvoTelemetry['surface'] {
  const typeView = viewOf(typeBytes, 5, 'Surface type')
  const proximityView = viewOf(proximityBytes, 6, 'Surface proximity')
  const pickup = parsePickup(pickupBytes)
  return {
    type: enumName(typeBytes[0], { 0: 'Paper', 1: 'Screen', 255: 'Unknown' }, 'Unknown'),
    proximity: proximityView.getUint16(0, true),
    pickedUp: pickup.pickedUp,
    timestamp: Math.max(
      timestamp(typeView, 1),
      timestamp(proximityView, 2),
      pickup.timestamp,
    ),
  }
}

export function parsePickup(bytes: Uint8Array): PickupState {
  const view = viewOf(bytes, 5, 'Pickup state')
  if (bytes[0] > 1) {
    throw new RangeError(`Invalid pickup state ${bytes[0]}`)
  }
  return {
    pickedUp: bytes[0] === 1,
    timestamp: timestamp(view, 1),
  }
}

export function parseColorCode(bytes: Uint8Array): EvoTelemetry['colorCode'] {
  const view = viewOf(bytes, 8, 'Color code')
  return { code: view.getUint32(0, true), timestamp: timestamp(view, 4) }
}

export function parseEncoders(bytes: Uint8Array): EvoTelemetry['encoders'] {
  const view = viewOf(bytes, 12, 'Wheel encoders')
  return {
    left: view.getUint32(0, true),
    right: view.getUint32(4, true),
    timestamp: timestamp(view, 8),
  }
}

function fixed(view: DataView, offset: number): number {
  return decodeS8_24(view.getInt32(offset, true))
}

export function parsePosition(bytes: Uint8Array): EvoTelemetry['position'] {
  const view = viewOf(bytes, 21, 'Relative position')
  return {
    originCounter: bytes[0],
    x: fixed(view, 1),
    y: fixed(view, 5),
    angleX: fixed(view, 9),
    angleY: fixed(view, 13),
    timestamp: timestamp(view, 17),
  }
}

export function parseCharger(bytes: Uint8Array): EvoTelemetry['charger'] {
  const view = viewOf(bytes, 5, 'Charger state')
  return {
    state: enumName(bytes[0], { 0: 'Disconnected', 1: 'Connected', 2: 'Low power' }, 'Unknown'),
    timestamp: timestamp(view, 1),
  }
}

export function parseButton(bytes: Uint8Array): EvoTelemetry['button'] {
  const view = viewOf(bytes, 5, 'Button state')
  return {
    press: enumName(bytes[0], { 0: 'Short', 1: 'Long', 2: 'Double', 3: 'Max', 4: 'Release' }, 'Unknown'),
    timestamp: timestamp(view, 1),
  }
}

export function parseLineSensors(bytes: Uint8Array): EvoTelemetry['lineSensors'] {
  const view = viewOf(bytes, 28, 'Line sensors')
  return {
    raw: Array.from(bytes.slice(0, 7)),
    normalized: Array.from(bytes.slice(7, 14)),
    position: fixed(view, 14),
    width: fixed(view, 18),
    characteristics: bytes[22],
    bitmap: bytes[23],
    timestamp: timestamp(view, 24),
  }
}

export function parseIrMessage(bytes: Uint8Array): EvoTelemetry['irMessages']['leftRear'] {
  const view = viewOf(bytes, 6, 'IR message')
  return { message: bytes[0], intensity: bytes[1], timestamp: timestamp(view, 2) }
}
