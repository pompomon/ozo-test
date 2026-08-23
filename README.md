# Evo Control

A touch-first, installable web controller for Ozobot Evo. It connects directly through Web Bluetooth; commands, telemetry, and device identifiers are not sent to a backend.

> [!WARNING]
> The protocol implementation is based on public source code but has not yet been validated with this project's physical Evo. Test movement with the wheels lifted and complete the [hardware checklist](docs/hardware-validation.md) before normal use.

## Browser support

| Platform | Browser | Status |
| --- | --- | --- |
| Android | Current Chrome | Primary target |
| Windows 10/11 | Current Chrome or Edge | Secondary target |
| iPhone/iPad | Safari, Chrome, Edge | Unsupported: iOS does not expose Web Bluetooth |
| Firefox/Safari desktop | Any | Unsupported |

The site must run on HTTPS or `localhost`. Selecting a device must follow a user action, so the browser picker cannot be bypassed.

## Features

- Touch joystick, independent dead-man wheel sliders, and WASD/arrow keyboard control
- Explicit motor arming, a persistent emergency stop, bounded 250 ms movement commands, and stop-on-focus-loss
- Eight-LED selection, RGB color, and brightness
- Tone playback and stop-sound control
- Battery, firmware, IR, color, line, surface, odometry, encoder, charger, and button telemetry
- Deterministic personality states with cancellable lights, tones, and bounded action sequences
- Focused obstacle, pickup, and button polling with stale-sensor fail-safe behavior
- Explicit manual/autonomous ownership; disconnect, disarm, and emergency stop always cancel autonomy
- Capability detection for the official Evo 3.x RPC service
- Detection and safe rejection of an incomplete legacy protocol
- Local, redacted diagnostics with copy/export
- Offline PWA app shell; connection and armed state are never cached or restored

## Use

1. Open the deployed HTTPS site in a supported browser.
2. Turn on Evo and keep it close to the device.
3. Select **Choose Evo** and choose a device named `OzoEvo…`.
4. Confirm the firmware and battery values look plausible.
5. Put Evo on a stand with its wheels clear.
6. Select **Arm motors**, then test at the default 120 mm/s limit.
7. Use **Emergency stop** or the Space key whenever control is uncertain.
8. Optionally select **Enable personality**. Select **Return to manual** before using direct controls.

If the app detects the legacy service, it keeps the motors locked because that profile lacks verified sound and telemetry commands. The application does not depend on the official Ozobot app or website.

Autonomous movement ships locked (`movementEnabled: false`) until the proximity direction and
thresholds in the hardware checklist are validated on a physical Evo. Personality states, focused
sensor monitoring, LEDs, and tones still operate. Developers can enable bounded movement through
`createBehaviorConfig` only after recording those hardware results.

## Development

Requires Node.js 22 or newer.

```sh
npm ci
npm run dev
```

Available checks:

```sh
npm run lint
npm test
npm run build
```

Desktop Chrome can use Web Bluetooth from the Vite `localhost` URL. A phone accessing a development machine by LAN IP needs an HTTPS development endpoint; a plain `http://192.168…` URL is not a secure context.

## Deploy

The workflow in `.github/workflows/pages.yml` verifies pull requests and deploys `main` to GitHub Pages. In repository settings, set **Pages → Build and deployment → Source** to **GitHub Actions**.

The Vite build uses relative asset paths, so it works at both a custom domain and a repository subpath. A service-worker update waits for explicit confirmation and cannot be applied while motors are armed.

## Safety and limitations

- Browsers cannot guarantee a final BLE write when a page is killed or a phone suspends it. Movement is refreshed as short, expiring commands so Evo should stop after at most 250 ms if the documented firmware watchdog works.
- Personality mode is foreground-only. Focus loss, a hidden page, stale reactive sensor data, or a BLE failure cancels its active plan and follows the emergency-stop path.
- One action plan owns the robot at a time. Transitions abort the previous plan, stop motion and sound, and ignore obsolete completions.
- Movement requests track `Velocity` acknowledgments (`105`) with bounded timeouts; one transient miss is retried and repeated misses trigger a fail-safe stop.
- The app sends `StopExecution(0)` immediately after connecting and never restores armed state.
- A Web Lock prevents two tabs from arming on supported browsers.
- The screen wake lock is best-effort and does not replace supervision.
- No firmware update mechanism is implemented.
- Named audio assets use a larger RPC format and are not enabled; the app uses the verified short `PlayTone` command.
- Proximity values are raw firmware bytes, not physical distance measurements. The default thresholds are provisional and autonomous movement remains disabled until calibrated.

See [protocol provenance](docs/protocol.md) for confidence levels and [hardware validation](docs/hardware-validation.md) for the required release checks.

## License

[MIT](LICENSE)
