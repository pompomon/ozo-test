import { describe, expect, it } from 'vitest'
import { BehaviorEngine } from './BehaviorEngine.ts'
import { createBehaviorConfig, SeededRandom } from './config.ts'
import type { Clock } from './types.ts'

function testClock(): Clock & { value: number } {
  return {
    value: 0,
    now() {
      return this.value
    },
  }
}

describe('BehaviorEngine', () => {
  it('moves from idle to curious on its configured timer', () => {
    const clock = testClock()
    const engine = new BehaviorEngine(
      createBehaviorConfig({
        idleToCuriousMs: 100,
        boredAfterMs: 10_000,
        sleepAfterMs: 20_000,
      }),
      clock,
      new SeededRandom(2),
    )
    engine.start()
    clock.value = 101
    expect(engine.handleEvent({ type: 'TICK', at: clock.value })?.transition?.to).toBe('CURIOUS')
  })

  it('uses explicit interaction, dance, and hazard transitions', () => {
    const clock = testClock()
    const engine = new BehaviorEngine(
      createBehaviorConfig({ repeatedObstacleCount: 2 }),
      clock,
      new SeededRandom(7),
    )
    engine.start()

    clock.value = 10
    expect(engine.handleEvent({
      type: 'USER_INTERACTION',
      source: 'ui',
      at: clock.value,
    })?.transition).toMatchObject({ from: 'IDLE', to: 'EXCITED' })

    clock.value = 20
    expect(engine.handleEvent({ type: 'DANCE_REQUESTED', at: clock.value })?.transition)
      .toMatchObject({ from: 'EXCITED', to: 'DANCING' })

    const reading = { leftRear: 0, leftFront: 90, rightRear: 0, rightFront: 20 }
    clock.value = 30
    expect(engine.handleEvent({
      type: 'OBSTACLE_DETECTED',
      reading,
      at: clock.value,
    })?.transition).toMatchObject({ from: 'DANCING', to: 'SCARED' })

    clock.value = 40
    expect(engine.handleEvent({
      type: 'OBSTACLE_DETECTED',
      reading,
      at: clock.value,
    })?.transition).toMatchObject({ from: 'SCARED', to: 'ANGRY' })
  })

  it('enters bored and sleeping states based only on external inactivity', () => {
    const clock = testClock()
    const config = createBehaviorConfig({
      boredAfterMs: 1_000,
      sleepAfterMs: 2_000,
      idleToCuriousMs: 10_000,
    })
    const engine = new BehaviorEngine(config, clock, new SeededRandom(3))
    engine.start()

    clock.value = 1_001
    expect(engine.handleEvent({ type: 'TICK', at: clock.value })?.transition?.to).toBe('BORED')
    clock.value = 31_002
    expect(engine.handleEvent({ type: 'TICK', at: clock.value })?.transition?.to).toBe('SLEEPING')
  })

  it('does not immediately re-enter boredom after its wandering period', () => {
    const clock = testClock()
    const config = createBehaviorConfig({
      boredAfterMs: 1_000,
      sleepAfterMs: 100_000,
      boredDurationMs: 2_000,
      idleToCuriousMs: 50_000,
    })
    const engine = new BehaviorEngine(config, clock, new SeededRandom(3))
    engine.start()
    clock.value = 1_001
    engine.handleEvent({ type: 'TICK', at: clock.value })
    clock.value = 3_002
    expect(engine.handleEvent({ type: 'TICK', at: clock.value })?.transition?.to).toBe('IDLE')
    clock.value = 3_500
    expect(engine.handleEvent({ type: 'TICK', at: clock.value })).toBeUndefined()
  })

  it('wakes from sleep on a button interaction', () => {
    const clock = testClock()
    const config = createBehaviorConfig({
      boredAfterMs: 1_000,
      sleepAfterMs: 2_000,
      idleToCuriousMs: 10_000,
    })
    const engine = new BehaviorEngine(config, clock, new SeededRandom(3))
    engine.start()
    clock.value = 2_001
    expect(engine.handleEvent({ type: 'TICK', at: clock.value })?.transition?.to).toBe('SLEEPING')
    clock.value = 2_100
    expect(engine.handleEvent({
      type: 'BUTTON_PRESSED',
      press: 'Short',
      at: clock.value,
    })?.transition?.to).toBe('EXCITED')
  })

  it('keeps pickup responses stationary even when movement is configured', () => {
    const clock = testClock()
    const engine = new BehaviorEngine(
      createBehaviorConfig({ movementEnabled: true }),
      clock,
      new SeededRandom(5),
    )
    engine.start()
    const decision = engine.handleEvent({ type: 'PICKED_UP', at: 1 })
    expect(decision?.transition?.to).toBe('SCARED')
    expect(decision?.actions.some((action) => action.type === 'DRIVE')).toBe(false)
  })

  it('does not escape through rear readings in the hysteresis band', () => {
    const clock = testClock()
    const engine = new BehaviorEngine(
      createBehaviorConfig({ movementEnabled: true, repeatedObstacleCount: 2 }),
      clock,
      new SeededRandom(5),
    )
    engine.start()
    const reading = { leftRear: 60, leftFront: 90, rightRear: 60, rightFront: 20 }
    const scared = engine.handleEvent({ type: 'OBSTACLE_DETECTED', reading, at: 1 })
    const angry = engine.handleEvent({ type: 'OBSTACLE_DETECTED', reading, at: 2 })
    expect(scared?.transition?.to).toBe('SCARED')
    expect(scared?.actions.some((action) => action.type === 'DRIVE')).toBe(false)
    expect(angry?.transition?.to).toBe('ANGRY')
    expect(angry?.actions.some((action) => action.type === 'DRIVE')).toBe(false)
  })

  it('uses updated active-hazard readings for repeated escape plans', () => {
    const clock = testClock()
    const engine = new BehaviorEngine(
      createBehaviorConfig({ movementEnabled: true }),
      clock,
      new SeededRandom(5),
    )
    engine.start()
    engine.handleEvent({
      type: 'OBSTACLE_DETECTED',
      reading: { leftRear: 0, leftFront: 90, rightRear: 0, rightFront: 20 },
      at: 1,
    })
    expect(engine.handleEvent({
      type: 'OBSTACLE_UPDATED',
      reading: { leftRear: 60, leftFront: 90, rightRear: 60, rightFront: 20 },
      at: 2,
    })).toBeUndefined()
    const repeated = engine.handleEvent({ type: 'STATE_COMPLETED', state: 'SCARED', at: 3 })
    expect(repeated?.actions.some((action) => action.type === 'DRIVE')).toBe(false)
  })

  it('produces repeatable plans from a seeded random source', () => {
    const config = createBehaviorConfig({ movementEnabled: true })
    const clock = testClock()
    const first = new BehaviorEngine(config, clock, new SeededRandom(99)).start()
    const second = new BehaviorEngine(config, clock, new SeededRandom(99)).start()
    expect(first.actions).toEqual(second.actions)
  })

  it('rejects unsafe timing and proximity configurations', () => {
    expect(() => createBehaviorConfig({
      boredAfterMs: 5_000,
      sleepAfterMs: 5_000,
    })).toThrow(/sleepAfterMs/)
    expect(() => createBehaviorConfig({
      obstacleThreshold: 80,
      obstacleClearThreshold: 90,
    })).toThrow(/hysteresis/)
    expect(() => createBehaviorConfig({
      reactiveSensorIntervalMs: 500,
      sensorStaleMs: 500,
    })).toThrow(/sensorStaleMs/)
  })
})
