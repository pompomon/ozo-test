import { describe, expect, it } from 'vitest'
import type { ReactiveSensors } from '../protocol/telemetry.ts'
import { createBehaviorConfig } from './config.ts'
import { TelemetryEventSource } from './TelemetryEventSource.ts'
import type { Clock } from './types.ts'

function sensors(
  timestamp: number,
  values: Partial<{
    leftRear: number
    leftFront: number
    rightRear: number
    rightFront: number
    pickedUp: boolean
    pickupTimestamp: number
    buttonTimestamp: number
    press: string
  }> = {},
): ReactiveSensors {
  return {
    proximity: {
      leftRear: values.leftRear ?? 0,
      leftFront: values.leftFront ?? 0,
      rightRear: values.rightRear ?? 0,
      rightFront: values.rightFront ?? 0,
      timestamp,
    },
    pickup: {
      pickedUp: values.pickedUp ?? false,
      timestamp: values.pickupTimestamp ?? timestamp,
    },
    button: {
      press: values.press ?? 'Release',
      timestamp: values.buttonTimestamp ?? timestamp,
    },
    receivedAt: timestamp,
  }
}

describe('TelemetryEventSource', () => {
  it('debounces obstacle edges with threshold hysteresis', () => {
    const clock: Clock = { now: () => 0 }
    const source = new TelemetryEventSource(createBehaviorConfig(), clock)
    expect(source.ingest(sensors(0))).toEqual([])
    expect(source.ingest(sensors(1, { leftFront: 90 }))).toEqual([])
    expect(source.ingest(sensors(2, { leftFront: 91 }))).toEqual([
      expect.objectContaining({ type: 'OBSTACLE_DETECTED' }),
    ])
    expect(source.ingest(sensors(3, { leftFront: 50 }))).toEqual([])
    expect(source.ingest(sensors(4, { leftFront: 49 }))).toEqual([
      expect.objectContaining({ type: 'OBSTACLE_CLEARED' }),
    ])
  })

  it('counts the baseline proximity reading toward obstacle detection', () => {
    const source = new TelemetryEventSource(createBehaviorConfig(), { now: () => 0 })
    expect(source.ingest(sensors(0, { leftFront: 90 }))).toEqual([])
    expect(source.ingest(sensors(1, { leftFront: 91 }))).toEqual([
      expect.objectContaining({ type: 'OBSTACLE_DETECTED' }),
    ])
  })

  it('deduplicates timestamps and emits pickup and button edges', () => {
    const source = new TelemetryEventSource(createBehaviorConfig(), { now: () => 0 })
    source.ingest(sensors(0))
    const events = source.ingest(sensors(1, {
      pickedUp: true,
      pickupTimestamp: 10,
      buttonTimestamp: 11,
      press: 'Short',
    }))
    expect(events.map((event) => event.type)).toEqual(['PICKED_UP', 'BUTTON_PRESSED'])
    expect(source.ingest(sensors(2, {
      pickedUp: true,
      pickupTimestamp: 10,
      buttonTimestamp: 11,
      press: 'Short',
    }))).toEqual([])
  })

  it('interrupts an active front hazard when a rear obstacle appears', () => {
    const source = new TelemetryEventSource(createBehaviorConfig(), { now: () => 0 })
    source.ingest(sensors(0))
    source.ingest(sensors(1, { leftFront: 90 }))
    source.ingest(sensors(2, { leftFront: 91 }))
    expect(source.ingest(sensors(3, { leftFront: 91, leftRear: 90 }))).toEqual([])
    expect(source.ingest(sensors(4, { leftFront: 91, leftRear: 91 }))).toEqual([
      expect.objectContaining({
        type: 'OBSTACLE_DETECTED',
        reading: expect.objectContaining({ leftRear: 91 }),
      }),
    ])
  })

  it('detects stale samples and resets its baseline', () => {
    let now = 0
    const source = new TelemetryEventSource(
      createBehaviorConfig({ sensorStaleMs: 1_000 }),
      { now: () => now },
    )
    source.ingest(sensors(0))
    now = 1_001
    expect(source.checkStale()).toMatchObject({ type: 'SENSOR_STALE', lastReceivedAt: 0 })
    expect(source.checkStale()).toBeUndefined()
    source.reset(now)
    expect(source.ingest(sensors(now, { pickedUp: true }))).toEqual([
      expect.objectContaining({ type: 'PICKED_UP' }),
    ])
  })

  it('uses the injected clock time for stale sample checks', () => {
    const source = new TelemetryEventSource(
      createBehaviorConfig({ sensorStaleMs: 1_000 }),
      { now: () => 0 },
    )
    source.ingest(sensors(10_000), 100)
    expect(source.checkStale(1_101)).toMatchObject({
      type: 'SENSOR_STALE',
      lastReceivedAt: 100,
    })
  })
})
