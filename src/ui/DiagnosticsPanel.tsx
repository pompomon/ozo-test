import type { DiagnosticEntry } from '../controller/EvoController.ts'

interface DiagnosticsPanelProps {
  readonly entries: readonly DiagnosticEntry[]
  readonly exportText: () => string
  readonly onClear: () => void
}

export function DiagnosticsPanel({ entries, exportText, onClear }: DiagnosticsPanelProps) {
  const copy = async (): Promise<void> => {
    await navigator.clipboard.writeText(exportText())
  }

  const download = (): void => {
    const url = URL.createObjectURL(new Blob([exportText()], { type: 'text/plain' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = 'evo-control-diagnostics.txt'
    anchor.click()
    URL.revokeObjectURL(url)
  }

  return (
    <section className="panel panel--wide" aria-labelledby="diagnostics-title">
      <div className="panel__heading">
        <div>
          <p className="eyebrow">Stored only here</p>
          <h2 id="diagnostics-title">Diagnostics</h2>
        </div>
        <div className="button-row">
          <button className="button button--quiet" onClick={() => void copy()} disabled={!entries.length}>
            Copy
          </button>
          <button className="button button--quiet" onClick={download} disabled={!entries.length}>
            Export
          </button>
          <button className="button button--quiet" onClick={onClear} disabled={!entries.length}>
            Clear
          </button>
        </div>
      </div>
      <div className="diagnostics" role="log" aria-live="polite">
        {entries.length === 0 ? (
          <p className="empty-state">Connection and safety events will appear here.</p>
        ) : (
          entries
            .slice()
            .reverse()
            .map((entry) => (
              <p key={entry.id} className={`diagnostic diagnostic--${entry.level}`}>
                <time>{new Date(entry.timestamp).toLocaleTimeString()}</time>
                <span>{entry.message}</span>
              </p>
            ))
        )}
      </div>
    </section>
  )
}

