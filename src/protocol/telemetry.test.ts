import { describe, expect, it } from 'vitest'
import { encodeS8_24 } from './modernCodec.ts'
import {
  parseBattery,
  parseFirmware,
  parseLineSensors,
  parsePickup,
  parsePosition,
  parseProcessedColor,
  parseSurface,
} from './telemetry.ts'

function setTimestamp(bytes: Uint8Array, offset: number, value: number): Uint8Array {
  new DataView(bytes.buffer).setUint32(offset, value, true)
  return bytes
}

describe('Evo telemetry decoding', () => {
  it('masks the firmware major-version compatibility bit', () => {
    expect(parseFirmware(Uint8Array.of(0x83, 7, 4, 0))).toEqual({
      version: '3.7.4',
      rawMajor: 0x83,
    })
  })

  it('parses battery state and charging flag', () => {
    const bytes = Uint8Array.of(0x74, 0x0e, 75, 1, 0, 0, 0, 0)
    setTimestamp(bytes, 4, 1234)
    expect(parseBattery(bytes)).toEqual({
      voltageMv: 3700,
      percent: 75,
      charging: true,
      timestamp: 1234,
    })
  })

  it('parses processed color sensor values', () => {
    const bytes = Uint8Array.of(1, 2, 3, 4, 5, 6, 1, 0, 0, 0, 0)
    setTimestamp(bytes, 7, 99)
    expect(parseProcessedColor(bytes)).toEqual({
      normalized: [1, 2, 3],
      transformed: [4, 5, 6],
      lightSource: 'on',
      timestamp: 99,
    })
  })

  it('decodes fixed-point position values', () => {
    const bytes = new Uint8Array(21)
    const view = new DataView(bytes.buffer)
    bytes[0] = 2
    view.setInt32(1, encodeS8_24(1.5), true)
    view.setInt32(5, encodeS8_24(-0.25), true)
    view.setInt32(9, encodeS8_24(0.5), true)
    view.setInt32(13, encodeS8_24(-0.5), true)
    view.setUint32(17, 42, true)
    expect(parsePosition(bytes)).toEqual({
      originCounter: 2,
      x: 1.5,
      y: -0.25,
      angleX: 0.5,
      angleY: -0.5,
      timestamp: 42,
    })
  })

  it('decodes line arrays and attributes', () => {
    const bytes = new Uint8Array(28)
    bytes.set([1, 2, 3, 4, 5, 6, 7], 0)
    bytes.set([11, 12, 13, 14, 15, 16, 17], 7)
    const view = new DataView(bytes.buffer)
    view.setInt32(14, encodeS8_24(0.25), true)
    view.setInt32(18, encodeS8_24(0.75), true)
    bytes[22] = 3
    bytes[23] = 0b001_1100
    view.setUint32(24, 777, true)
    expect(parseLineSensors(bytes)).toEqual({
      raw: [1, 2, 3, 4, 5, 6, 7],
      normalized: [11, 12, 13, 14, 15, 16, 17],
      position: 0.25,
      width: 0.75,
      characteristics: 3,
      bitmap: 0b001_1100,
      timestamp: 777,
    })
  })

  it('combines surface state timestamps', () => {
    const type = setTimestamp(Uint8Array.of(1, 0, 0, 0, 0), 1, 10)
    const proximity = setTimestamp(Uint8Array.of(44, 1, 0, 0, 0, 0), 2, 12)
    const pickup = setTimestamp(Uint8Array.of(1, 0, 0, 0, 0), 1, 11)
    expect(parseSurface(type, proximity, pickup)).toEqual({
      type: 'Screen',
      proximity: 300,
      pickedUp: true,
      timestamp: 12,
    })
  })

  it('parses focused pickup state', () => {
    const pickup = setTimestamp(Uint8Array.of(1, 0, 0, 0, 0), 1, 45)
    expect(parsePickup(pickup)).toEqual({ pickedUp: true, timestamp: 45 })
  })

  it('rejects malformed or out-of-range telemetry', () => {
    expect(() => parseFirmware(Uint8Array.of(3, 7))).toThrow(RangeError)
    expect(() => parseBattery(Uint8Array.of(0, 0, 101, 0, 0, 0, 0, 0))).toThrow(/percentage/)
    expect(() => parseProcessedColor(Uint8Array.of(0, 0, 0, 0, 0, 0, 9, 0, 0, 0, 0))).toThrow(/light source/)
    expect(() => parsePickup(Uint8Array.of(2, 0, 0, 0, 0))).toThrow(/pickup state/)
  })
})
