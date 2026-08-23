# Hardware validation checklist

**Current status:** not run. A physical Evo is required.

Record the browser, operating system, Evo firmware, and result for each row. Do not record or publish the robot’s Bluetooth address or 16-byte device identifier.

## Safe setup

- [ ] Put Evo on a stable stand with both wheels clear.
- [ ] Charge the battery and keep every other BLE controller closed.
- [ ] Keep the emergency-stop control visible.
- [ ] Confirm the test area is clear before floor tests.

## Discovery and compatibility

| Check | Android Chrome | Windows Chrome | Windows Edge |
| --- | --- | --- | --- |
| Device appears with the expected name/manufacturer data | Not run | Not run | Not run |
| GATT service and characteristic UUIDs match the detected profile | Not run | Not run | Not run |
| Firmware version is plausible | Not run | Not run | Not run |
| Twenty connect/disconnect cycles complete cleanly | Not run | Not run | Not run |
| Permission denial and picker cancellation recover cleanly | Not run | Not run | Not run |

## Commands

| Check | Android Chrome | Windows Chrome | Windows Edge |
| --- | --- | --- | --- |
| Stop-on-connect leaves the robot stationary | Not run | Not run | Not run |
| Forward, reverse, left, and right wheel directions are correct | Not run | Not run | Not run |
| Independent wheel values and 300 mm/s ceiling are correct | Not run | Not run | Not run |
| Every LED mask, RGB channel, and brightness works | Not run | Not run | Not run |
| Every tone preset and stop-sound works | Not run | Not run | Not run |

## Telemetry

- [ ] Battery percentage, voltage, and charging state are plausible.
- [ ] Four proximity values react to obstacles.
- [ ] Record whether a nearer obstacle raises or lowers each raw proximity value.
- [ ] Record clear/near values for front-left, front-right, rear-left, and rear-right at several distances.
- [ ] Choose detection and clear thresholds with enough hysteresis to avoid rapid state changes.
- [ ] Confirm focused proximity/pickup/button polling remains responsive while LEDs and tones run.
- [ ] Raw and processed RGB values react to surfaces.
- [ ] Line readings, surface type/color, and pickup state react correctly.
- [ ] Wheel encoders and relative position change with motion.
- [ ] Charger and button state update correctly.
- [ ] Malformed or unknown notifications are ignored without disconnecting.

## Loss-of-control safety

Measure stop latency and require it to remain below the 250 ms movement duration plus observed BLE scheduling tolerance.

| Trigger | Result | Measured latency |
| --- | --- | --- |
| Joystick/touch release | Not run | — |
| Pointer cancellation | Not run | — |
| Keyboard key release | Not run | — |
| Space/emergency-stop button | Not run | — |
| Window blur or app switch | Not run | — |
| Page hidden or phone locked | Not run | — |
| Bluetooth disabled while moving | Not run | — |
| Evo powered off while moving | Not run | — |
| Browser process terminated while moving | Not run | — |
| Reconnect after interruption | Not run | Must remain stopped |
| Personality disabled during an action | Not run | Must stop before manual controls enable |
| Pickup during each moving state | Not run | Must stop and remain stationary |
| Front obstacle during each moving state | Not run | Must stop before any escape action |
| Focused sensor samples become stale | Not run | Must disarm through the fail-safe path |

## Personality engine

- [ ] Verify `IDLE`, `CURIOUS`, `EXCITED`, `SCARED`, `ANGRY`, `BORED`, `SLEEPING`, and `DANCING` transitions.
- [ ] Confirm repeated obstacle events escalate from `SCARED` to `ANGRY`.
- [ ] Confirm only user/button interaction resets boredom and sleep timers.
- [ ] Confirm **Return to manual**, disarm, disconnect, Space, and emergency stop cancel every action sequence.
- [ ] Confirm manual drive, LED, sound, speed, and telemetry-refresh controls are disabled while personality mode owns Evo.
- [ ] Test timer throttling by switching apps and locking the screen; personality mode must not resume automatically.
- [ ] Enable `movementEnabled` only after all proximity calibration and loss-of-control rows pass.

## PWA

- [ ] Install prompt and standalone launch work on Android.
- [ ] App shell opens offline and clearly remains disconnected.
- [ ] No device, command, telemetry, or armed state survives reload.
- [ ] A waiting service-worker update cannot activate while armed.
- [ ] Portrait and landscape controls remain reachable without accidental page scrolling.

Do not mark hardware support as verified in the README or protocol matrix until every required row passes on the relevant platform.
