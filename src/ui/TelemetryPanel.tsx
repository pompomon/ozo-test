import type { EvoTelemetry } from '../protocol/telemetry.ts'

interface TelemetryPanelProps {
  readonly telemetry?: EvoTelemetry
  readonly onRefresh: () => void
  readonly disabled: boolean
}

function format(value: number, digits = 2): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(digits)
}

export function TelemetryPanel({ telemetry, onRefresh, disabled }: TelemetryPanelProps) {
  return (
    <section className="panel panel--wide" aria-labelledby="telemetry-title">
      <div className="panel__heading">
        <div>
          <p className="eyebrow">Live data</p>
          <h2 id="telemetry-title">Telemetry</h2>
        </div>
        <button className="button button--quiet" disabled={disabled} onClick={onRefresh}>
          Refresh
        </button>
      </div>
      {!telemetry ? (
        <p className="empty-state">Connect a compatible Evo to read its sensors.</p>
      ) : (
        <>
          <div className="telemetry-grid">
            <article>
              <span>Battery</span>
              <strong>{telemetry.battery.percent}%</strong>
              <small>
                {telemetry.battery.voltageMv} mV · {telemetry.battery.charging ? 'charging' : 'not charging'}
              </small>
            </article>
            <article>
              <span>IR proximity</span>
              <strong>
                {telemetry.proximity.leftFront} · {telemetry.proximity.rightFront}
              </strong>
              <small>
                Front L/R · rear {telemetry.proximity.leftRear}/{telemetry.proximity.rightRear}
              </small>
            </article>
            <article>
              <span>Surface</span>
              <strong>{telemetry.surfaceColor.color}</strong>
              <small>
                {telemetry.surface.type} · {telemetry.surface.pickedUp ? 'picked up' : 'on surface'}
              </small>
            </article>
            <article>
              <span>Line</span>
              <strong>{telemetry.line.color}</strong>
              <small>
                position {format(telemetry.lineSensors.position)} · width {format(telemetry.lineSensors.width)}
              </small>
            </article>
            <article>
              <span>Position</span>
              <strong>
                {format(telemetry.position.x)} · {format(telemetry.position.y)}
              </strong>
              <small>angle {format(telemetry.position.angleX)} rad</small>
            </article>
            <article>
              <span>Wheel encoders</span>
              <strong>
                {telemetry.encoders.left} · {telemetry.encoders.right}
              </strong>
              <small>Left · right ticks</small>
            </article>
            <article>
              <span>Color sensor</span>
              <strong>
                {telemetry.processedColor.normalized.join(' · ')}
              </strong>
              <small>Normalized R · G · B</small>
            </article>
            <article>
              <span>Status</span>
              <strong>{telemetry.charger.state}</strong>
              <small>Button: {telemetry.button.press}</small>
            </article>
          </div>
          <details className="telemetry-details">
            <summary>Raw and extended sensor values</summary>
            <dl>
              <div><dt>Firmware</dt><dd>{telemetry.firmware}</dd></div>
              <div><dt>Raw color R/G/B/C</dt><dd>{telemetry.colorSensor.red} / {telemetry.colorSensor.green} / {telemetry.colorSensor.blue} / {telemetry.colorSensor.clear}</dd></div>
              <div><dt>Line sensors raw</dt><dd>{telemetry.lineSensors.raw.join(', ')}</dd></div>
              <div><dt>Line sensors normalized</dt><dd>{telemetry.lineSensors.normalized.join(', ')}</dd></div>
              <div><dt>Color code</dt><dd>0x{telemetry.colorCode.code.toString(16)}</dd></div>
              <div><dt>Surface proximity</dt><dd>{telemetry.surface.proximity}</dd></div>
              <div><dt>IR messages L-rear / L-front</dt><dd>{telemetry.irMessages.leftRear.message} ({telemetry.irMessages.leftRear.intensity}) / {telemetry.irMessages.leftFront.message} ({telemetry.irMessages.leftFront.intensity})</dd></div>
              <div><dt>IR messages R-rear / R-front</dt><dd>{telemetry.irMessages.rightRear.message} ({telemetry.irMessages.rightRear.intensity}) / {telemetry.irMessages.rightFront.message} ({telemetry.irMessages.rightFront.intensity})</dd></div>
            </dl>
          </details>
        </>
      )}
    </section>
  )
}

