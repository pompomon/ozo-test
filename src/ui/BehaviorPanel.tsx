import type { BehaviorRuntimeSnapshot } from '../behavior/types.ts'

interface BehaviorPanelProps {
  readonly snapshot: BehaviorRuntimeSnapshot
  readonly available: boolean
  readonly onEnable: () => void
  readonly onDisable: () => void
  readonly onInteract: () => void
  readonly onDance: () => void
}

const STATUS_LABELS: Readonly<Record<BehaviorRuntimeSnapshot['status'], string>> = {
  disabled: 'Manual control',
  starting: 'Starting…',
  running: 'Autonomous',
  stopping: 'Stopping…',
  faulted: 'Stopped for safety',
}

export function BehaviorPanel({
  snapshot,
  available,
  onEnable,
  onDisable,
  onInteract,
  onDance,
}: BehaviorPanelProps) {
  const active = ['starting', 'running', 'stopping'].includes(snapshot.status)
  const changing = ['starting', 'stopping'].includes(snapshot.status)

  return (
    <section className="panel panel--wide behavior-panel" aria-labelledby="behavior-title">
      <div className="panel__heading">
        <div>
          <p className="eyebrow">Personality engine</p>
          <h2 id="behavior-title">Autonomous behavior</h2>
        </div>
        <span role="status" className={`behavior-status behavior-status--${snapshot.status}`}>
          {STATUS_LABELS[snapshot.status]}
        </span>
      </div>
      <div className="behavior-summary">
        <div>
          <span>Current state</span>
          <strong>{snapshot.status === 'running' ? snapshot.state : '—'}</strong>
        </div>
        <div>
          <span>Last transition</span>
          <strong>{snapshot.lastTransition?.reason ?? 'None yet'}</strong>
        </div>
        <div>
          <span>Session seed</span>
          <strong>{snapshot.sessionSeed}</strong>
        </div>
      </div>
      {snapshot.error && (
        <p className="behavior-error" role="alert">{snapshot.error}</p>
      )}
      {!snapshot.movementEnabled && (
        <p className="control-help">
          Autonomous movement is locked until proximity direction and thresholds are validated on
          physical hardware. Lights, tones, sensors, and personality states remain active.
        </p>
      )}
      <div className="button-row behavior-actions">
        <button
          className="button button--primary"
          disabled={!available || active || changing}
          onClick={onEnable}
        >
          Enable personality
        </button>
        <button
          className="button button--quiet"
          disabled={!active || changing}
          onClick={onDisable}
        >
          Return to manual
        </button>
        <button
          className="button button--quiet"
          disabled={snapshot.status !== 'running'}
          onClick={onInteract}
        >
          Say hello
        </button>
        <button
          className="button button--quiet"
          disabled={snapshot.status !== 'running'}
          onClick={onDance}
        >
          Dance
        </button>
      </div>
      {!available && snapshot.status === 'disabled' && (
        <p className="control-help">Connect and arm Evo before enabling autonomous behavior.</p>
      )}
    </section>
  )
}
