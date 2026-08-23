import type { Clock, RandomSource } from './types.ts'

export interface BehaviorConfig {
  readonly engineTickMs: number
  readonly reactiveSensorIntervalMs: number
  readonly sensorStaleMs: number
  readonly idleToCuriousMs: number
  readonly boredAfterMs: number
  readonly sleepAfterMs: number
  readonly curiousDurationMs: number
  readonly excitedDurationMs: number
  readonly scaredCooldownMs: number
  readonly angryCooldownMs: number
  readonly boredDurationMs: number
  readonly ambientMinWaitMs: number
  readonly ambientMaxWaitMs: number
  readonly obstacleThreshold: number
  readonly obstacleClearThreshold: number
  readonly nearerIsHigher: boolean
  readonly obstacleDebounceSamples: number
  readonly repeatedObstacleCount: number
  readonly repeatedObstacleWindowMs: number
  readonly movementEnabled: boolean
  readonly curiousSpeed: number
  readonly excitedSpeed: number
  readonly scaredSpeed: number
  readonly boredSpeed: number
  readonly angrySpeed: number
  readonly danceSpeed: number
}

export const DEFAULT_BEHAVIOR_CONFIG: BehaviorConfig = Object.freeze({
  engineTickMs: 250,
  reactiveSensorIntervalMs: 250,
  sensorStaleMs: 3_000,
  idleToCuriousMs: 20_000,
  boredAfterMs: 60_000,
  sleepAfterMs: 300_000,
  curiousDurationMs: 18_000,
  excitedDurationMs: 8_000,
  scaredCooldownMs: 2_000,
  angryCooldownMs: 5_000,
  boredDurationMs: 30_000,
  ambientMinWaitMs: 4_000,
  ambientMaxWaitMs: 9_000,
  obstacleThreshold: 80,
  obstacleClearThreshold: 55,
  nearerIsHigher: true,
  obstacleDebounceSamples: 2,
  repeatedObstacleCount: 3,
  repeatedObstacleWindowMs: 12_000,
  movementEnabled: false,
  curiousSpeed: 0.3,
  excitedSpeed: 0.55,
  scaredSpeed: 0.5,
  boredSpeed: 0.22,
  angrySpeed: 0.4,
  danceSpeed: 0.48,
})

const POSITIVE_TIMINGS: readonly (keyof BehaviorConfig)[] = [
  'engineTickMs',
  'reactiveSensorIntervalMs',
  'sensorStaleMs',
  'idleToCuriousMs',
  'boredAfterMs',
  'sleepAfterMs',
  'curiousDurationMs',
  'excitedDurationMs',
  'scaredCooldownMs',
  'angryCooldownMs',
  'boredDurationMs',
  'ambientMinWaitMs',
  'ambientMaxWaitMs',
  'repeatedObstacleWindowMs',
]

const SPEEDS: readonly (keyof BehaviorConfig)[] = [
  'curiousSpeed',
  'excitedSpeed',
  'scaredSpeed',
  'boredSpeed',
  'angrySpeed',
  'danceSpeed',
]

export function createBehaviorConfig(overrides: Partial<BehaviorConfig> = {}): BehaviorConfig {
  const config = { ...DEFAULT_BEHAVIOR_CONFIG, ...overrides }
  for (const key of POSITIVE_TIMINGS) {
    const value = config[key]
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      throw new RangeError(`${key} must be a positive finite number`)
    }
  }
  for (const key of SPEEDS) {
    const value = config[key]
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
      throw new RangeError(`${key} must be between 0 and 1`)
    }
  }
  for (const key of ['obstacleThreshold', 'obstacleClearThreshold'] as const) {
    const value = config[key]
    if (!Number.isInteger(value) || value < 0 || value > 255) {
      throw new RangeError(`${key} must be an integer between 0 and 255`)
    }
  }
  for (const key of ['obstacleDebounceSamples', 'repeatedObstacleCount'] as const) {
    const value = config[key]
    if (!Number.isInteger(value) || value < 1) {
      throw new RangeError(`${key} must be a positive integer`)
    }
  }
  if (config.sleepAfterMs <= config.boredAfterMs) {
    throw new RangeError('sleepAfterMs must be greater than boredAfterMs')
  }
  if (config.ambientMaxWaitMs < config.ambientMinWaitMs) {
    throw new RangeError('ambientMaxWaitMs must be at least ambientMinWaitMs')
  }
  if (
    (config.nearerIsHigher && config.obstacleClearThreshold >= config.obstacleThreshold) ||
    (!config.nearerIsHigher && config.obstacleClearThreshold <= config.obstacleThreshold)
  ) {
    throw new RangeError('Obstacle clear threshold must provide hysteresis')
  }
  return Object.freeze(config)
}

export const systemClock: Clock = {
  now: () => Date.now(),
}

export class SeededRandom implements RandomSource {
  private state: number

  constructor(seed: number) {
    if (!Number.isFinite(seed)) throw new TypeError('Random seed must be finite')
    this.state = Math.trunc(seed) >>> 0 || 0x6d2b79f5
  }

  next(): number {
    let value = this.state
    value ^= value << 13
    value ^= value >>> 17
    value ^= value << 5
    this.state = value >>> 0
    return this.state / 0x1_0000_0000
  }
}

export function createSessionSeed(): number {
  const values = new Uint32Array(1)
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(values)
    return values[0] || 1
  }
  return (Date.now() ^ Math.trunc(Math.random() * 0xffff_ffff)) >>> 0 || 1
}
