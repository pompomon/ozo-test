function assertInt16(value: number, name: string): void {
  if (!Number.isInteger(value) || value < -32_768 || value > 32_767) {
    throw new RangeError(`${name} must fit in a signed 16-bit integer`)
  }
}

function assertByte(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 255) {
    throw new RangeError(`${name} must be a byte`)
  }
}

export const LEGACY_STOP_FILE = Uint8Array.of(0x50, 0x02, 0x01)

export function encodeLegacyDrive(left: number, right: number, durationMs: number): Uint8Array {
  assertInt16(left, 'left')
  assertInt16(right, 'right')
  if (!Number.isInteger(durationMs) || durationMs < 0 || durationMs > 0xffff) {
    throw new RangeError('durationMs must fit in an unsigned 16-bit integer')
  }
  const bytes = new Uint8Array(7)
  const view = new DataView(bytes.buffer)
  bytes[0] = 0x40
  view.setInt16(1, left, true)
  view.setInt16(3, right, true)
  view.setUint16(5, durationMs, true)
  return bytes
}

export function encodeLegacyLed(mask: number, red: number, green: number, blue: number): Uint8Array {
  if (!Number.isInteger(mask) || mask < 0 || mask > 0xffff) {
    throw new RangeError('mask must fit in an unsigned 16-bit integer')
  }
  for (const [name, value] of Object.entries({ red, green, blue })) {
    assertByte(value, name)
  }
  const bytes = new Uint8Array(6)
  const view = new DataView(bytes.buffer)
  bytes[0] = 0x44
  view.setUint16(1, mask, true)
  bytes.set([red, green, blue], 3)
  return bytes
}

