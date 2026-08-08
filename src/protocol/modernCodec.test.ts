import { describe, expect, it } from 'vitest'
import {
  assertCallSucceeded,
  decodeMemReadResponse,
  decodeS8_24,
  encodeMemRead,
  encodePlayTone,
  encodeS8_24,
  encodeSetLed,
  encodeStopExecution,
  encodeVelocity,
  readMessageId,
} from './modernCodec.ts'

describe('modern Evo protocol codec', () => {
  it('encodes the official little-endian memory read vector', () => {
    expect([...encodeMemRead(65_580, 4)]).toEqual([1, 0, 0x2c, 0, 1, 0, 4, 0])
  })

  it('encodes the fixed-point velocity vector', () => {
    expect([...encodeVelocity(0x0200_0001, 0.1, -1.5, 250)]).toEqual([
      0x68, 0x00, 0x01, 0x00, 0x00, 0x02, 0x99, 0x99, 0x19,
      0x00, 0x00, 0x00, 0x80, 0xfe, 0xfa, 0x00, 0x00, 0x00,
    ])
  })

  it('encodes LED, tone, and stop packets', () => {
    expect([...encodeSetLed(0xff, 10, 20, 30)]).toEqual([110, 0, 255, 0, 10, 20, 30, 255])
    expect([...encodePlayTone(0x0200_0001, 392, 500)]).toEqual([
      118, 0, 1, 0, 0, 2, 136, 1, 244, 1, 100,
    ])
    expect([...encodeStopExecution(0x0200_0001)]).toEqual([120, 0, 1, 0, 0, 2])
  })

  it('round-trips S8.24 values within one least-significant bit', () => {
    for (const value of [-127.5, -1.25, 0, 0.1, 42.75, 127.5]) {
      expect(decodeS8_24(encodeS8_24(value))).toBeCloseTo(value, 6)
    }
  })

  it('validates ranges before encoding', () => {
    expect(() => encodeMemRead(-1, 4)).toThrow(RangeError)
    expect(() => encodeMemRead(0, 16)).toThrow(RangeError)
    expect(() => encodePlayTone(1, 0, 100)).toThrow(RangeError)
    expect(() => encodeVelocity(1, 128, 0, 10)).toThrow(RangeError)
  })

  it('rejects malformed and mismatched responses', () => {
    expect(() => readMessageId(Uint8Array.of(1))).toThrow(RangeError)
    expect(() => decodeMemReadResponse(Uint8Array.of(2, 0, 0))).toThrow(RangeError)
    expect(() => decodeMemReadResponse(Uint8Array.of(3, 0, 0, 0, 0))).toThrow()
    expect(() => assertCallSucceeded(Uint8Array.of(111, 0, 2), 111)).toThrow(/status 2/)
  })

  it('decodes a valid memory response without sharing its backing packet', () => {
    const packet = Uint8Array.of(2, 0, 0, 3, 0, 7, 8, 9)
    const decoded = decodeMemReadResponse(packet)
    packet[5] = 99
    expect([...decoded.data]).toEqual([7, 8, 9])
  })
})

