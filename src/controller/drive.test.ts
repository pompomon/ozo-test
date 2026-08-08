import { describe, expect, it } from 'vitest'
import {
  mixJoystick,
  normalizedToMillimetersPerSecond,
  normalizeWheelSpeeds,
} from './drive.ts'

describe('drive mixing', () => {
  it('maps forward, reverse, and rotation inputs', () => {
    expect(mixJoystick(0, 1)).toEqual({ left: 1, right: 1 })
    expect(mixJoystick(0, -1)).toEqual({ left: -1, right: -1 })
    expect(mixJoystick(1, 0)).toEqual({ left: 1, right: -1 })
  })

  it('applies a dead zone and rescales the usable range', () => {
    expect(mixJoystick(0.03, 0.02)).toEqual({ left: 0, right: 0 })
    expect(mixJoystick(0, 0.54, 0.08).left).toBeCloseTo(0.5)
  })

  it('normalizes mixed wheel values without changing their ratio', () => {
    expect(normalizeWheelSpeeds(2, 1)).toEqual({ left: 1, right: 0.5 })
    expect(normalizeWheelSpeeds(Number.NaN, 1)).toEqual({ left: 0, right: 0 })
  })

  it('enforces Evo’s 300 mm/s speed ceiling', () => {
    expect(normalizedToMillimetersPerSecond({ left: 1, right: -0.5 }, 500)).toEqual({
      left: 300,
      right: -150,
    })
  })
})

