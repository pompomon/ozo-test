import { describe, expect, it } from 'vitest'
import { encodeLegacyDrive, encodeLegacyLed, LEGACY_STOP_FILE } from './legacyCodec.ts'

describe('legacy Evo protocol codec', () => {
  it('uses the reverse-engineered StopFile handshake', () => {
    expect([...LEGACY_STOP_FILE]).toEqual([0x50, 0x02, 0x01])
  })

  it('encodes signed wheel speeds and duration', () => {
    expect([...encodeLegacyDrive(-100, 100, 250)]).toEqual([
      0x40, 0x9c, 0xff, 0x64, 0x00, 0xfa, 0x00,
    ])
  })

  it('encodes the legacy LED packet', () => {
    expect([...encodeLegacyLed(0x1234, 1, 2, 3)]).toEqual([0x44, 0x34, 0x12, 1, 2, 3])
  })

  it('rejects values that do not fit protocol fields', () => {
    expect(() => encodeLegacyDrive(40_000, 0, 10)).toThrow(RangeError)
    expect(() => encodeLegacyDrive(0, 0, -1)).toThrow(RangeError)
    expect(() => encodeLegacyLed(1, 256, 0, 0)).toThrow(RangeError)
  })
})

