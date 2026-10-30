# CCDX 1.3.3

Baseline: 1.3.2. Existing accounts, selected models and client configuration require no repeat setup.

- WebUI activity uses one visible-page SSE connection. TUI subscribes directly to the same process-local activity channel. Request lifecycle changes coalesce within 50 ms; ordinary output chunks do not produce pushes.
- Summary and full status retain the same service-instance identity, so manual Overview refresh cannot reinstate the old six-second activity expiry.
- Reconnection sends current activity, cumulative totals and the existing bounded recent records. There is no event-replay store or guarantee of recovering arbitrary old records or state across a service restart. Disconnection means activity is unknown, not idle.
- Hidden/suspended pages and Auto refresh OFF close the stream. Heartbeats retain healthy long-lived state. Slow subscribers have one pending snapshot and are disconnected when blocked; streams neither count as work nor delay normal shutdown.
- Desktop WebUI spacing is tighter without changing fonts, themes, navigation or information hierarchy. Standard controls are 32 px high, inline source/model actions 30 px; coarse pointers retain 44 px targets. Existing narrow layouts, focus outlines and reduced-motion behavior remain.

Credential/configuration ownership, native sign-in and catalogs, source/client grants, routing, images, predictions, inference bytes and retry policies retain their existing boundaries. Masking, TokenEconomizer and Responses WebSocket are outside this release.

Release checks cover local verification, real-browser lifecycle/density cases, Windows/macOS CI, native client compatibility, strict platform installs, isolated 1.3.2 upgrade, and independent public package/download integrity. Receipts distinguish checks actually completed from pending external gates. Publication does not install or restart the current local service.
