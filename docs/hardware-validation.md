# Hardware validation checklist

**Current status:** not run. A physical Evo is required.

Record the browser, operating system, Evo firmware, and result for each row. Do not record or publish the robot’s Bluetooth address or 16-byte device identifier.

## Safe setup

- [ ] Put Evo on a stable stand with both wheels clear.
- [ ] Charge the battery and keep the official app closed.
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

## PWA

- [ ] Install prompt and standalone launch work on Android.
- [ ] App shell opens offline and clearly remains disconnected.
- [ ] No device, command, telemetry, or armed state survives reload.
- [ ] A waiting service-worker update cannot activate while armed.
- [ ] Portrait and landscape controls remain reachable without accidental page scrolling.

Do not mark hardware support as verified in the README or protocol matrix until every required row passes on the relevant platform.

