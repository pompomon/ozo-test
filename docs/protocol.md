# Evo BLE protocol provenance

This document records the protocol facts used by Evo Control. It is not an official Ozobot specification, and no claim below has been physically verified by this project yet.

## Sources

| Source | Revision | License | Role |
| --- | --- | --- | --- |
| [`ozobot/python-libraries`](https://github.com/ozobot/python-libraries/tree/caead3f59c862e329cbb0a96abc0ce2c0e21999b) | `caead3f59c862e329cbb0a96abc0ce2c0e21999b` | MIT | Authoritative current service, generated packet schema, memory map, discovery data, and safety behavior |
| [`zayfod/pyozo`](https://github.com/zayfod/pyozo/tree/4b27f354d4af0e7fe6a151ac829c11b9b928f692) | `4b27f354d4af0e7fe6a151ac829c11b9b928f692` | MIT | Independent confirmation of the control UUIDs, packet IDs, memory map, and Evo firmware 3.x applicability |
| [`raphaelbink/raspberry-pi-ozobot-evo`](https://github.com/raphaelbink/raspberry-pi-ozobot-evo/tree/5de09556efa06565c7941bcec285840e76a391a1) | `5de09556efa06565c7941bcec285840e76a391a1` | No license found | Historical evidence for the 2019 legacy characteristics and command facts; no source code is copied |

Protocol facts are reimplemented from field descriptions and byte layouts. The legacy repository has no stated license, so it is used only as factual research evidence.

## Device discovery

The official BLE library parses manufacturer data for company identifier `0x03eb` with packet type `0`:

- Product byte at offset 22: `0` and `4` identify Evo-family products.
- Firmware bytes at offsets 23–26: major, minor, and little-endian patch.
- The high bit of the major version is metadata and is masked with `0x7f`.

Both official examples and the independent legacy source use device names beginning with `OzoEvo`. The browser picker therefore permits:

- The modern service UUID.
- Manufacturer data beginning with packet type `0`.
- Names beginning with `OzoEvo` or `Evo`.

The chosen device is rejected after connection unless a supported GATT service is found.

## Modern RPC profile

**Confidence:** high from the official generated protocol and independently matching `pyozo`; hardware validation pending.

- Service: `8903136c-5f13-4548-a885-c58779136801`
- Bidirectional write/notify characteristic: `8903136c-5f13-4548-a885-c58779136802`
- Maximum assumed GATT payload: 20 bytes
- Byte order: little-endian
- Packet prefix: unsigned 16-bit message ID
- Fractional motion fields: signed S8.24 fixed point
- BLE request IDs: source byte `0x02` in the most-significant byte

Implemented short RPCs:

| Operation | Request/response IDs | Layout |
| --- | --- | --- |
| Memory read | `1` / `2` | `u16 id, u32 address, u16 length`; response adds status, length, and up to 15 data bytes |
| Velocity | `104` / `105` | `u16 id, u32 request, S8.24 linear m/s, S8.24 angular rad/s, i32 duration ms` |
| Set LED | `110` / `111` | `u16 id, u16 mask, u8 red, green, blue, alpha` |
| Play tone | `118` / `119` | `u16 id, u32 request, u16 frequency, u16 duration, u8 volume` |
| Stop execution | `120` / `121` | `u16 id, u32 request`; request `0` stops all execution |

Ordinary short packets have no application-level checksum. BLE supplies link-layer integrity. The protocol defines CRC-32 only for long RPC transfers, which this app does not currently use.

### Virtual memory read by the app

| Region | Address | Bytes |
| --- | ---: | ---: |
| Firmware version | 65580 | 4 |
| Line sensors | 0 | 28 |
| Raw color sensor | 56 | 13 |
| Processed RGB | 69 | 11 |
| Surface proximity | 80 | 6 |
| Line color | 86 | 6 |
| Color code | 92 | 8 |
| Surface color/type/pickup | 100 / 108 / 113 | 8 / 5 / 5 |
| IR proximity | 118 | 8 |
| Four IR messages | 126 / 132 / 138 / 144 | 6 each |
| Wheel encoders | 150 | 12 |
| Relative position | 162 | 21 |
| Charger/battery/button | 183 / 188 / 196 | 5 / 8 / 5 |

Reads longer than 15 data bytes are split to stay within the conservative 20-byte notification payload.

### Reactive sensor reads

Personality mode uses the same memory-read RPC and parsers as full telemetry, but limits each
sample to the safety-relevant regions:

| Signal | Address | Bytes |
| --- | ---: | ---: |
| Pickup state | 113 | 5 |
| Four-direction IR proximity | 118 | 8 |
| Button state | 196 | 5 |

`EvoController.startReactiveSensorPolling()` stops the ordinary full-telemetry interval, establishes
a baseline, and then performs one non-overlapping focused sample at a configurable cadence. Ending
personality mode restores full telemetry polling. Memory operations remain serialized by
`ModernEvoClient`; behavior code does not access the protocol or transport layers directly.

The proximity fields are exposed as raw bytes. Their polarity, useful thresholds, and relationship
to physical distance remain hardware-validation items. The behavior configuration therefore keeps
autonomous movement disabled by default.

## Legacy profile

**Confidence:** medium for the two characteristics and commands, low for service discovery; firmware version unknown.

- Drive characteristic: `8903136c-5f13-4548-a885-c58779136702`
- Control characteristic: `8903136c-5f13-4548-a885-c58779136703`
- Initial StopFile fact: `50 02 01`
- Drive command ID: `0x40`
- LED command ID: `0x44`

The containing service UUID `8903136c-5f13-4548-a885-c58779136701` is inferred from the UUID family because the community source did not state it. A physical GATT dump must confirm it.

This profile has no independently verified sound, firmware, battery, or sensor commands. Because those features are requirements, Evo Control reports an update prerequisite and does not arm a legacy device. The legacy encoders remain isolated for future hardware investigation.

## Safety behavior

The official driver sends `StopExecution(0)` as soon as it opens the control channel. Its generated `Velocity` documentation describes bounded duration as a connection-loss safety feature. Evo Control mirrors both behaviors:

1. Subscribe to notifications.
2. Send and acknowledge `StopExecution(0)`.
3. Require explicit motor arming.
4. Send 250 ms velocity commands no faster than every 100 ms.
5. Clear pending movement and prioritize stop on release, focus loss, page hiding, disconnect, disarm, or emergency stop.
6. Never replay a command or restore arming after reconnecting.
7. Cancel the active personality action plan before returning control to the manual UI.
8. Treat stale focused sensor data as loss of autonomous control and follow the emergency-stop path.

Movement acknowledgments (`Velocity` response `105`) now use movement-specific timeout handling: one transient timeout is tolerated with an immediate retry, and two consecutive misses trigger an emergency stop path.

Browser suspension can prevent a final stop packet. Release therefore depends on the bounded command expiring on the robot; this remains a hardware release check.

## Compatibility matrix

| Profile | Evidence | Movement | LEDs | Sound | Battery/sensors | App behavior |
| --- | --- | --- | --- | --- | --- | --- |
| Evo control service, firmware 3.x | Official library + `pyozo` | Implemented | Implemented | Tone implemented | Implemented | Eligible to arm after detection |
| Legacy 2019 service | One community source | Encoding retained | Encoding retained | Unknown | Unknown | Connects only if inferred service matches; never arms |
| Other firmware/service | None | Unknown | Unknown | Unknown | Unknown | Rejected with an actionable error |

## Required physical follow-up

Capture the selected Evo’s advertisement, GATT service tree, firmware value, and responses without publishing its device ID or Bluetooth address. Compare every result with this document and update confidence only after completing [`hardware-validation.md`](hardware-validation.md).
