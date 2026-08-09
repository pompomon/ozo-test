import { describe, expect, it } from 'vitest'
import {
  EVO_3_PROFILE,
  isFullyCompatible,
  LEGACY_PROFILE,
  missingCapabilities,
} from './profile.ts'

describe('firmware capability profiles', () => {
  it('enables every required feature for the modern service', () => {
    expect(isFullyCompatible(EVO_3_PROFILE)).toBe(true)
    expect(missingCapabilities(EVO_3_PROFILE)).toEqual([])
  })

  it('blocks legacy firmware that cannot meet all requirements', () => {
    expect(isFullyCompatible(LEGACY_PROFILE)).toBe(false)
    expect(missingCapabilities(LEGACY_PROFILE)).toEqual([
      'sound',
      'battery',
      'firmware',
      'telemetry',
    ])
  })
})

