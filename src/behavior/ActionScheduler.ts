import type { RobotAction, RobotActionPort } from './types.ts'

export type ScheduleOutcome = 'completed' | 'cancelled' | 'ignored'

export interface ScheduleTicket {
  readonly accepted: boolean
  readonly generation: number
  readonly completion: Promise<ScheduleOutcome>
}

interface ActiveSchedule {
  readonly generation: number
  readonly priority: number
  readonly controller: AbortController
  readonly completion: Promise<ScheduleOutcome>
}

function wasAborted(error: unknown, signal: AbortSignal): boolean {
  return (
    signal.aborted ||
    (error instanceof DOMException && error.name === 'AbortError') ||
    (error instanceof Error && error.name === 'AbortError')
  )
}

export class ActionScheduler {
  private readonly port: RobotActionPort
  private active?: ActiveSchedule
  private generation = 0

  constructor(port: RobotActionPort) {
    this.port = port
  }

  get busy(): boolean {
    return this.active !== undefined
  }

  schedule(
    actions: readonly RobotAction[],
    priority: number,
    forceInterrupt = false,
  ): ScheduleTicket {
    if (this.active && priority < this.active.priority && !forceInterrupt) {
      return {
        accepted: false,
        generation: this.active.generation,
        completion: Promise.resolve('ignored'),
      }
    }

    const previous = this.active
    previous?.controller.abort()
    const generation = ++this.generation
    const controller = new AbortController()
    const previousCompletion = previous?.completion.catch(() => 'cancelled' as const)
    const completion = (previousCompletion ?? Promise.resolve('completed' as const)).then(
      () => this.execute(generation, actions, controller),
    )
    this.active = { generation, priority, controller, completion }
    return { accepted: true, generation, completion }
  }

  async cancel(): Promise<void> {
    const active = this.active
    if (!active) {
      await this.port.cleanup()
      return
    }
    active.controller.abort()
    await active.completion
  }

  private async execute(
    generation: number,
    actions: readonly RobotAction[],
    controller: AbortController,
  ): Promise<ScheduleOutcome> {
    const { signal } = controller
    let outcome: ScheduleOutcome = 'completed'
    let failure: unknown
    try {
      if (signal.aborted) {
        outcome = 'cancelled'
      } else {
        for (const action of actions) {
          if (signal.aborted) {
            outcome = 'cancelled'
            break
          }
          await this.port.execute(action, signal)
        }
      }
      if (signal.aborted) outcome = 'cancelled'
    } catch (error) {
      if (wasAborted(error, signal)) {
        outcome = 'cancelled'
      } else {
        failure = error
      }
    }

    try {
      await this.port.cleanup()
    } catch (error) {
      failure ??= error
    } finally {
      if (this.active?.generation === generation) {
        this.active = undefined
      }
    }

    if (signal.aborted) outcome = 'cancelled'
    if (failure !== undefined) throw failure
    return outcome
  }
}
