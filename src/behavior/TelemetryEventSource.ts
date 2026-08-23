import type { ReactiveSensors } from '../protocol/telemetry.ts'
import type { BehaviorConfig } from './config.ts'
import type {
  BehaviorEvent,
  Clock,
  ObstacleReading,
} from './types.ts'

function readingOf(sensors: ReactiveSensors): ObstacleReading {
  return {
    leftRear: sensors.proximity.leftRear,
    leftFront: sensors.proximity.leftFront,
    rightRear: sensors.proximity.rightRear,
    rightFront: sensors.proximity.rightFront,
  }
}

function readingKey(sensors: ReactiveSensors): string {
  const reading = readingOf(sensors)
  return [
    sensors.proximity.timestamp,
    reading.leftRear,
    reading.leftFront,
    reading.rightRear,
    reading.rightFront,
  ].join(':')
}

export class TelemetryEventSource {
  private readonly config: BehaviorConfig
  private readonly clock: Clock
  private startedAt: number
  private initialized = false
  private lastReceivedAt?: number
  private lastProximityKey?: string
  private lastPickupTimestamp?: number
  private pickedUp = false
  private lastButtonTimestamp?: number
  private obstacleActive = false
  private obstacleSamples = 0
  private rearObstacleActive = false
  private rearObstacleSamples = 0
  private clearSamples = 0
  private staleEmitted = false

  constructor(config: BehaviorConfig, clock: Clock) {
    this.config = config
    this.clock = clock
    this.startedAt = clock.now()
  }

  reset(at = this.clock.now()): void {
    this.startedAt = at
    this.initialized = false
    this.lastReceivedAt = undefined
    this.lastProximityKey = undefined
    this.lastPickupTimestamp = undefined
    this.pickedUp = false
    this.lastButtonTimestamp = undefined
    this.obstacleActive = false
    this.obstacleSamples = 0
    this.rearObstacleActive = false
    this.rearObstacleSamples = 0
    this.clearSamples = 0
    this.staleEmitted = false
  }

  ingest(sensors: ReactiveSensors, at = this.clock.now()): readonly BehaviorEvent[] {
    const events: BehaviorEvent[] = []
    this.lastReceivedAt = sensors.receivedAt
    this.staleEmitted = false

    if (!this.initialized) {
      this.initialized = true
      this.lastProximityKey = readingKey(sensors)
      this.lastPickupTimestamp = sensors.pickup.timestamp
      this.pickedUp = sensors.pickup.pickedUp
      this.lastButtonTimestamp = sensors.button.timestamp
      if (this.pickedUp) events.push({ type: 'PICKED_UP', at })
      return events
    }

    if (
      sensors.pickup.timestamp !== this.lastPickupTimestamp ||
      sensors.pickup.pickedUp !== this.pickedUp
    ) {
      if (sensors.pickup.pickedUp !== this.pickedUp) {
        events.push({
          type: sensors.pickup.pickedUp ? 'PICKED_UP' : 'PUT_DOWN',
          at,
        })
      }
      this.lastPickupTimestamp = sensors.pickup.timestamp
      this.pickedUp = sensors.pickup.pickedUp
    }

    if (sensors.button.timestamp !== this.lastButtonTimestamp) {
      this.lastButtonTimestamp = sensors.button.timestamp
      if (sensors.button.press !== 'Release') {
        events.push({ type: 'BUTTON_PRESSED', at, press: sensors.button.press })
      }
    }

    const proximityKey = readingKey(sensors)
    if (proximityKey !== this.lastProximityKey) {
      this.lastProximityKey = proximityKey
      const reading = readingOf(sensors)
      this.updateObstacle(reading, at, events)
    }
    return events
  }

  checkStale(at = this.clock.now()): BehaviorEvent | undefined {
    const lastReceivedAt = this.lastReceivedAt ?? this.startedAt
    if (this.staleEmitted || at - lastReceivedAt < this.config.sensorStaleMs) {
      return undefined
    }
    this.staleEmitted = true
    return { type: 'SENSOR_STALE', at, lastReceivedAt: this.lastReceivedAt }
  }

  private updateObstacle(
    reading: ObstacleReading,
    at: number,
    events: BehaviorEvent[],
  ): void {
    const near = (value: number): boolean =>
      this.config.nearerIsHigher
        ? value >= this.config.obstacleThreshold
        : value <= this.config.obstacleThreshold
    const clear = (value: number): boolean =>
      this.config.nearerIsHigher
        ? value <= this.config.obstacleClearThreshold
        : value >= this.config.obstacleClearThreshold

    const frontNear = near(reading.leftFront) || near(reading.rightFront)
    const rearNear = near(reading.leftRear) || near(reading.rightRear)
    const allClear = [
      reading.leftFront,
      reading.rightFront,
      reading.leftRear,
      reading.rightRear,
    ].every(clear)

    if (!this.obstacleActive) {
      this.clearSamples = 0
      this.obstacleSamples = frontNear || rearNear ? this.obstacleSamples + 1 : 0
      if (this.obstacleSamples >= this.config.obstacleDebounceSamples) {
        this.obstacleActive = true
        this.rearObstacleActive = rearNear
        this.obstacleSamples = 0
        events.push({ type: 'OBSTACLE_DETECTED', at, reading })
      }
      return
    }

    this.obstacleSamples = 0
    if (rearNear && !this.rearObstacleActive) {
      this.rearObstacleSamples += 1
      if (this.rearObstacleSamples >= this.config.obstacleDebounceSamples) {
        this.rearObstacleActive = true
        this.rearObstacleSamples = 0
        events.push({ type: 'OBSTACLE_DETECTED', at, reading })
      }
    } else if (!rearNear) {
      this.rearObstacleSamples = 0
      if (clear(reading.leftRear) && clear(reading.rightRear)) {
        this.rearObstacleActive = false
      }
    }

    this.clearSamples = allClear ? this.clearSamples + 1 : 0
    if (this.clearSamples >= this.config.obstacleDebounceSamples) {
      this.obstacleActive = false
      this.rearObstacleActive = false
      this.clearSamples = 0
      events.push({ type: 'OBSTACLE_CLEARED', at, reading })
    }
  }
}
