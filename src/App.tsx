import { useEffect, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { BehaviorRuntime } from './behavior/BehaviorRuntime.ts'
import type { BehaviorRuntimeSnapshot } from './behavior/types.ts'
import { EvoController, type ControllerSnapshot } from './controller/EvoController.ts'
import { mixJoystick } from './controller/drive.ts'
import { missingCapabilities } from './protocol/profile.ts'
import { usePwa } from './pwa/usePwa.ts'
import { BehaviorPanel } from './ui/BehaviorPanel.tsx'
import { DiagnosticsPanel } from './ui/DiagnosticsPanel.tsx'
import { Joystick } from './ui/Joystick.tsx'
import { TelemetryPanel } from './ui/TelemetryPanel.tsx'

const defaultController = new EvoController()

const LED_GROUPS = [
  { label: 'Front', mask: 0x3e },
  { label: 'Top', mask: 0x01 },
  { label: 'Button', mask: 0x40 },
  { label: 'Back', mask: 0x80 },
] as const

const TONES = [
  { label: 'C4 · 262 Hz', value: 262 },
  { label: 'E4 · 330 Hz', value: 330 },
  { label: 'G4 · 392 Hz', value: 392 },
  { label: 'C5 · 523 Hz', value: 523 },
  { label: 'Alert · 880 Hz', value: 880 },
] as const

interface AppProps {
  readonly controller?: EvoController
  readonly behaviorRuntime?: BehaviorRuntime
}

function useController(controller: EvoController): ControllerSnapshot {
  const [snapshot, setSnapshot] = useState(controller.snapshot)
  useEffect(() => controller.subscribe(setSnapshot), [controller])
  return snapshot
}

function useBehaviorRuntime(runtime: BehaviorRuntime): BehaviorRuntimeSnapshot {
  const [snapshot, setSnapshot] = useState(runtime.snapshot)
  useEffect(() => runtime.subscribe(setSnapshot), [runtime])
  useEffect(() => {
    runtime.start()
    return () => {
      void runtime.stop().catch(() => undefined)
    }
  }, [runtime])
  return snapshot
}

export default function App({
  controller = defaultController,
  behaviorRuntime: providedBehaviorRuntime,
}: AppProps) {
  const ownedBehaviorRuntime = useMemo(() => new BehaviorRuntime(controller), [controller])
  const behaviorRuntime = providedBehaviorRuntime ?? ownedBehaviorRuntime
  const snapshot = useController(controller)
  const behavior = useBehaviorRuntime(behaviorRuntime)
  const [leftWheel, setLeftWheel] = useState(0)
  const [rightWheel, setRightWheel] = useState(0)
  const [ledMask, setLedMask] = useState(0xff)
  const [ledColor, setLedColor] = useState('#42f5c8')
  const [brightness, setBrightness] = useState(60)
  const [tone, setTone] = useState(392)
  const [toneDuration, setToneDuration] = useState(500)
  const [actionError, setActionError] = useState<string>()
  const armed = snapshot.phase === 'armed'
  const motorsBusy = armed || snapshot.phase === 'stopping'
  const pwa = usePwa(motorsBusy)
  const connected = ['connecting', 'ready', 'armed', 'stopping', 'incompatible'].includes(snapshot.phase)
  const controlsEnabled = ['ready', 'armed'].includes(snapshot.phase)
  const autonomous = ['starting', 'running', 'stopping'].includes(behavior.status)
  const manualControlsEnabled = controlsEnabled && !autonomous
  const manualDriveEnabled = armed && !autonomous

  useEffect(() => controller.installSafetyHandlers(), [controller])

  useEffect(() => {
    if (!manualDriveEnabled) {
      setLeftWheel(0)
      setRightWheel(0)
    }
  }, [manualDriveEnabled])

  useEffect(() => {
    if (!armed) return
    const pressed = new Set<string>()
    const movementKeys = new Set(['w', 'a', 's', 'd', 'arrowup', 'arrowleft', 'arrowdown', 'arrowright'])
    const updateDrive = (): void => {
      if (!manualDriveEnabled) return
      const y = Number(pressed.has('w') || pressed.has('arrowup')) - Number(pressed.has('s') || pressed.has('arrowdown'))
      const x = Number(pressed.has('d') || pressed.has('arrowright')) - Number(pressed.has('a') || pressed.has('arrowleft'))
      const wheels = mixJoystick(x, y)
      controller.setDrive(wheels.left, wheels.right)
    }
    const keyDown = (event: KeyboardEvent): void => {
      if (event.target instanceof Element && event.target.matches('input, select, textarea')) return
      const key = event.key.toLowerCase()
      if (key === ' ') {
        event.preventDefault()
        void behaviorRuntime.emergencyStop('Emergency stop pressed with Space')
        return
      }
      if (!manualDriveEnabled || !movementKeys.has(key)) return
      event.preventDefault()
      pressed.add(key)
      updateDrive()
    }
    const keyUp = (event: KeyboardEvent): void => {
      const key = event.key.toLowerCase()
      if (!manualDriveEnabled || !movementKeys.has(key)) return
      event.preventDefault()
      pressed.delete(key)
      updateDrive()
    }
    window.addEventListener('keydown', keyDown)
    window.addEventListener('keyup', keyUp)
    return () => {
      window.removeEventListener('keydown', keyDown)
      window.removeEventListener('keyup', keyUp)
    }
  }, [armed, behaviorRuntime, controller, manualDriveEnabled])

  const status = useMemo(() => {
    switch (snapshot.phase) {
      case 'unsupported': return 'Unsupported browser'
      case 'disconnected': return 'Disconnected'
      case 'selecting': return 'Choose an Evo'
      case 'connecting': return 'Detecting firmware'
      case 'ready': return 'Connected · safe'
      case 'armed': return 'Motors armed'
      case 'stopping': return 'Stopping motors'
      case 'incompatible': return 'Unsupported firmware'
      case 'error': return 'Connection error'
    }
  }, [snapshot.phase])

  const run = (action: () => Promise<void>): void => {
    setActionError(undefined)
    void action().catch((error: unknown) => {
      setActionError(error instanceof Error ? error.message : String(error))
    })
  }

  const updateWheel = (side: 'left' | 'right', value: number): void => {
    if (!manualDriveEnabled) return
    if (side === 'left') {
      setLeftWheel(value)
      controller.setDrive(value / 100, rightWheel / 100)
    } else {
      setRightWheel(value)
      controller.setDrive(leftWheel / 100, value / 100)
    }
  }

  const releaseWheel = (side: 'left' | 'right'): void => {
    if (side === 'left') {
      setLeftWheel(0)
      if (manualDriveEnabled) controller.setDrive(0, rightWheel / 100)
    } else {
      setRightWheel(0)
      if (manualDriveEnabled) controller.setDrive(leftWheel / 100, 0)
    }
  }

  return (
    <div className="app-shell">
      <header className="hero">
        <div className="hero__brand">
          <span className="brand-mark" aria-hidden="true">E</span>
          <div>
            <p className="eyebrow">Private · direct · browser-based</p>
            <h1>Evo Control</h1>
          </div>
        </div>
        <div className={`status-pill status-pill--${snapshot.phase}`}>
          <span aria-hidden="true" />
          {status}
        </div>
      </header>

      <main>
        {(snapshot.supportReason || snapshot.error || actionError) && (
          <div className="notice notice--warning" role="alert">
            <strong>{snapshot.phase === 'unsupported' ? 'Browser not supported.' : 'Attention.'}</strong>
            <span>{snapshot.supportReason ?? snapshot.error ?? actionError}</span>
          </div>
        )}
        <div className="notice notice--safety">
          <strong>First run?</strong>
          <span>
            Protocol values come from public Ozobot sources and still require validation on your robot.
            Test with its wheels lifted.
          </span>
        </div>
        {pwa.updateAvailable && (
          <div className="notice">
            <span>A new app version is ready.</span>
            <button className="button button--quiet" disabled={motorsBusy} onClick={pwa.applyUpdate}>
              {motorsBusy ? 'Disarm to update' : 'Apply update'}
            </button>
          </div>
        )}

        <section className="connection-card" aria-labelledby="connection-title">
          <div>
            <p className="eyebrow">Bluetooth</p>
            <h2 id="connection-title">{snapshot.deviceName ?? 'Your Ozobot Evo'}</h2>
            <p>
              {snapshot.profile
                ? `${snapshot.profile.label}${snapshot.firmware ? ` · firmware ${snapshot.firmware}` : ''}`
                : 'Pair directly from Chrome. No account, backend, or saved device identifier.'}
            </p>
          </div>
          <div className="connection-card__actions">
            {connected ? (
              <button
                className="button button--quiet"
                disabled={snapshot.phase === 'stopping' || behavior.status === 'stopping'}
                onClick={() => run(() => behaviorRuntime.disconnect())}
              >
                Disconnect
              </button>
            ) : (
              <button
                className="button button--primary"
                disabled={snapshot.phase === 'unsupported' || snapshot.phase === 'selecting'}
                onClick={() => run(() => controller.connect())}
              >
                {snapshot.phase === 'selecting' ? 'Picker open…' : snapshot.phase === 'error' ? 'Try again' : 'Choose Evo'}
              </button>
            )}
            {pwa.canInstall && (
              <button className="button button--quiet" onClick={() => run(pwa.install)}>
                Install app
              </button>
            )}
          </div>
        </section>

        {snapshot.phase === 'incompatible' && snapshot.profile && (
          <div className="notice notice--warning" role="alert">
            <strong>Required features are missing.</strong>
            <span>
              Missing {missingCapabilities(snapshot.profile).join(', ')}. This protocol profile is
              not safe for autonomous control, so motors remain locked.
            </span>
          </div>
        )}

        <div className="dashboard">
          <BehaviorPanel
            snapshot={behavior}
            available={armed}
            onEnable={() => run(() => behaviorRuntime.enable())}
            onDisable={() => run(() => behaviorRuntime.disable())}
            onInteract={() => behaviorRuntime.notifyInteraction()}
            onDance={() => behaviorRuntime.requestDance()}
          />
          <section className="panel drive-panel" aria-labelledby="drive-title">
            <div className="panel__heading">
              <div>
                <p className="eyebrow">Dead-man control</p>
                <h2 id="drive-title">Drive</h2>
              </div>
              <button
                className={`button ${armed ? 'button--quiet' : 'button--arm'}`}
                disabled={!controlsEnabled || behavior.status === 'stopping'}
                onClick={() => run(armed ? () => behaviorRuntime.disarm() : () => controller.arm())}
              >
                {armed ? 'Disarm' : 'Arm motors'}
              </button>
            </div>
            <Joystick
              disabled={!manualDriveEnabled}
              onChange={(x, y) => {
                if (!manualDriveEnabled) return
                const wheels = mixJoystick(x, y)
                controller.setDrive(wheels.left, wheels.right)
              }}
            />
            <div className="speed-control">
              <label htmlFor="speed-limit">Maximum speed</label>
              <output>{snapshot.maximumSpeed} mm/s</output>
              <input
                id="speed-limit"
                type="range"
                min="50"
                max="300"
                step="10"
                value={snapshot.maximumSpeed}
                disabled={!manualControlsEnabled}
                onChange={(event) => controller.setMaximumSpeed(Number(event.target.value))}
              />
            </div>
            <p className="keyboard-hint">Windows: hold WASD or arrows to drive. Space is emergency stop.</p>
          </section>

          <section className="panel" aria-labelledby="wheels-title">
            <div className="panel__heading">
              <div>
                <p className="eyebrow">Independent</p>
                <h2 id="wheels-title">Wheels</h2>
              </div>
            </div>
            <p className="control-help">Sliders return to zero when released.</p>
            {([
              ['left', leftWheel],
              ['right', rightWheel],
            ] as const).map(([side, value]) => (
              <div className="wheel-control" key={side}>
                <label htmlFor={`${side}-wheel`}>{side[0].toUpperCase() + side.slice(1)}</label>
                <output>{value}%</output>
                <input
                  id={`${side}-wheel`}
                  type="range"
                  min="-100"
                  max="100"
                  value={value}
                  disabled={!manualDriveEnabled}
                  onChange={(event) => updateWheel(side, Number(event.target.value))}
                  onPointerUp={() => releaseWheel(side)}
                  onPointerCancel={() => releaseWheel(side)}
                  onKeyUp={() => releaseWheel(side)}
                  onBlur={() => releaseWheel(side)}
                />
              </div>
            ))}
          </section>

          <section className="panel" aria-labelledby="lights-title">
            <div className="panel__heading">
              <div>
                <p className="eyebrow">Eight LEDs</p>
                <h2 id="lights-title">Lights</h2>
              </div>
            </div>
            <fieldset className="led-groups" disabled={!manualControlsEnabled}>
              <legend className="sr-only">Choose LEDs</legend>
              {LED_GROUPS.map((group) => (
                <label key={group.mask}>
                  <input
                    type="checkbox"
                    checked={(ledMask & group.mask) === group.mask}
                    onChange={(event) => {
                      setLedMask(event.target.checked ? ledMask | group.mask : ledMask & ~group.mask)
                    }}
                  />
                  <span>{group.label}</span>
                </label>
              ))}
            </fieldset>
            <div className="color-controls">
              <label>
                Color
                <input
                  type="color"
                  value={ledColor}
                  disabled={!manualControlsEnabled}
                  onChange={(event) => setLedColor(event.target.value)}
                />
              </label>
              <label>
                Brightness <output>{brightness}%</output>
                <input
                  type="range"
                  min="0"
                  max="100"
                  value={brightness}
                  disabled={!manualControlsEnabled}
                  onChange={(event) => setBrightness(Number(event.target.value))}
                />
              </label>
            </div>
            <button
              className="button button--primary button--full"
              disabled={!manualControlsEnabled || ledMask === 0}
              onClick={() => run(() => controller.setLights(ledMask, ledColor, brightness))}
            >
              Apply lights
            </button>
          </section>

          <section className="panel" aria-labelledby="sound-title">
            <div className="panel__heading">
              <div>
                <p className="eyebrow">Tone generator</p>
                <h2 id="sound-title">Sound</h2>
              </div>
            </div>
            <label className="field">
              Tone
              <select
                value={tone}
                disabled={!manualControlsEnabled}
                onChange={(event) => setTone(Number(event.target.value))}
              >
                {TONES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
              </select>
            </label>
            <label className="field">
              Duration
              <select
                value={toneDuration}
                disabled={!manualControlsEnabled}
                onChange={(event) => setToneDuration(Number(event.target.value))}
              >
                <option value="200">Short · 0.2 s</option>
                <option value="500">Medium · 0.5 s</option>
                <option value="1000">Long · 1 s</option>
                <option value="3000">Extended · 3 s</option>
              </select>
            </label>
            <div className="button-row button-row--stretch">
              <button
                className="button button--primary"
                disabled={!manualControlsEnabled}
                onClick={() => run(() => controller.playTone(tone, toneDuration))}
              >
                Play tone
              </button>
              <button
                className="button button--quiet"
                disabled={!manualControlsEnabled}
                onClick={() => run(() => controller.stopSound())}
              >
                Stop sound
              </button>
            </div>
          </section>

          <TelemetryPanel
            telemetry={snapshot.telemetry}
            disabled={!manualControlsEnabled}
            onRefresh={() => run(() => controller.refreshTelemetry())}
          />
          <DiagnosticsPanel
            entries={snapshot.diagnostics}
            exportText={() => controller.exportDiagnostics()}
            onClear={() => controller.clearDiagnostics()}
          />
        </div>
      </main>

      <footer>
        <span>Bluetooth traffic stays between this browser and Evo.</span>
        <a href="https://github.com/pompomon/ozo-test" target="_blank" rel="noreferrer">Source</a>
      </footer>

      <button
        className="emergency-stop"
        disabled={!connected && snapshot.phase !== 'error'}
        onClick={() => run(() => behaviorRuntime.emergencyStop())}
        onKeyDown={(event: ReactKeyboardEvent<HTMLButtonElement>) => {
          if (event.key === ' ') event.preventDefault()
        }}
      >
        <span aria-hidden="true">■</span>
        Emergency stop
      </button>
    </div>
  )
}
