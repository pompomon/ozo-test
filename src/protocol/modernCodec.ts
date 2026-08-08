const FIXED_POINT_SCALE = 2 ** 24
const FIXED_POINT_MIN = -128
const FIXED_POINT_MAX = 128 - 1 / FIXED_POINT_SCALE

export const MODERN_MESSAGE = {
  memReadRequest: 1,
  memReadResponse: 2,
  velocityRequest: 104,
  velocityResponse: 105,
  setLedRequest: 110,
  setLedResponse: 111,
  playToneRequest: 118,
  playToneResponse: 119,
  stopExecutionRequest: 120,
  stopExecutionResponse: 121,
} as const

function assertIntegerInRange(value: number, min: number, max: number, name: string): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be an integer from ${min} to ${max}`)
  }
}

function createPacket(length: number, messageId: number): { bytes: Uint8Array; view: DataView } {
  const bytes = new Uint8Array(length)
  const view = new DataView(bytes.buffer)
  view.setUint16(0, messageId, true)
  return { bytes, view }
}

export function encodeS8_24(value: number): number {
  if (!Number.isFinite(value) || value < FIXED_POINT_MIN || value > FIXED_POINT_MAX) {
    throw new RangeError(`S8.24 value must be between ${FIXED_POINT_MIN} and ${FIXED_POINT_MAX}`)
  }
  return Math.trunc(value * FIXED_POINT_SCALE)
}

export function decodeS8_24(value: number): number {
  return value / FIXED_POINT_SCALE
}

export function encodeMemRead(address: number, length: number): Uint8Array {
  assertIntegerInRange(address, 0, 0xffff_ffff, 'address')
  assertIntegerInRange(length, 1, 15, 'length')
  const { bytes, view } = createPacket(8, MODERN_MESSAGE.memReadRequest)
  view.setUint32(2, address, true)
  view.setUint16(6, length, true)
  return bytes
}

export interface MemReadResponse {
  readonly result: number
  readonly data: Uint8Array
}

export function decodeMemReadResponse(packet: Uint8Array): MemReadResponse {
  if (packet.length < 5) {
    throw new RangeError('Memory response is shorter than its 5-byte header')
  }
  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength)
  if (view.getUint16(0, true) !== MODERN_MESSAGE.memReadResponse) {
    throw new Error('Unexpected memory response message ID')
  }
  const length = view.getUint16(3, true)
  if (length > 15 || packet.length !== length + 5) {
    throw new RangeError('Memory response length is invalid')
  }
  return {
    result: packet[2],
    data: packet.slice(5),
  }
}

export function encodeVelocity(
  requestId: number,
  linearMetersPerSecond: number,
  angularRadiansPerSecond: number,
  durationMs: number,
): Uint8Array {
  assertIntegerInRange(requestId, 0, 0xffff_ffff, 'requestId')
  assertIntegerInRange(durationMs, -1, 0x7fff_ffff, 'durationMs')
  const { bytes, view } = createPacket(18, MODERN_MESSAGE.velocityRequest)
  view.setUint32(2, requestId, true)
  view.setInt32(6, encodeS8_24(linearMetersPerSecond), true)
  view.setInt32(10, encodeS8_24(angularRadiansPerSecond), true)
  view.setInt32(14, durationMs, true)
  return bytes
}

export function encodeSetLed(
  mask: number,
  red: number,
  green: number,
  blue: number,
  alpha = 255,
): Uint8Array {
  assertIntegerInRange(mask, 0, 0xffff, 'mask')
  for (const [name, value] of Object.entries({ red, green, blue, alpha })) {
    assertIntegerInRange(value, 0, 255, name)
  }
  const { bytes, view } = createPacket(8, MODERN_MESSAGE.setLedRequest)
  view.setUint16(2, mask, true)
  bytes.set([red, green, blue, alpha], 4)
  return bytes
}

export function encodePlayTone(
  requestId: number,
  frequencyHz: number,
  durationMs: number,
  volume = 100,
): Uint8Array {
  assertIntegerInRange(requestId, 0, 0xffff_ffff, 'requestId')
  assertIntegerInRange(frequencyHz, 20, 20_000, 'frequencyHz')
  assertIntegerInRange(durationMs, 1, 0xffff, 'durationMs')
  assertIntegerInRange(volume, 0, 100, 'volume')
  const { bytes, view } = createPacket(11, MODERN_MESSAGE.playToneRequest)
  view.setUint32(2, requestId, true)
  view.setUint16(6, frequencyHz, true)
  view.setUint16(8, durationMs, true)
  bytes[10] = volume
  return bytes
}

export function encodeStopExecution(requestId: number): Uint8Array {
  assertIntegerInRange(requestId, 0, 0xffff_ffff, 'requestId')
  const { bytes, view } = createPacket(6, MODERN_MESSAGE.stopExecutionRequest)
  view.setUint32(2, requestId, true)
  return bytes
}

export function readMessageId(packet: Uint8Array): number {
  if (packet.length < 2) {
    throw new RangeError('Packet is too short to contain a message ID')
  }
  return new DataView(packet.buffer, packet.byteOffset, packet.byteLength).getUint16(0, true)
}

export function readRequestId(packet: Uint8Array): number | undefined {
  if (packet.length < 6) {
    return undefined
  }
  return new DataView(packet.buffer, packet.byteOffset, packet.byteLength).getUint32(2, true)
}

export function assertCallSucceeded(packet: Uint8Array, expectedMessageId: number): void {
  if (packet.length !== 3 || readMessageId(packet) !== expectedMessageId) {
    throw new Error('Malformed command response')
  }
  if (packet[2] !== 0) {
    throw new Error(`Evo rejected the command with status ${packet[2]}`)
  }
}
