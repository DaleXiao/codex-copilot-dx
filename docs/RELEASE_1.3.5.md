# CCDX 1.3.5

Baseline: 1.3.4. This patch reduces the impact of client packaging changes while retaining native sign-in, model selections, image setup and optional prediction settings.

Prediction startup verifies the installed application's system identity asynchronously. It no longer inspects `app.asar`, hashed chunks or renderer implementation strings. Existing identity records are reverified while retaining their certificate, port and profile. macOS retains platform signature checks; Windows retains the official Store registration and selected profile boundary. Live configuration requests remain the protocol boundary. Unrecognized payloads keep the existing forwarding behavior; no model request is added to test availability.

The optional prediction transport uses a finite 64 KiB header budget on requests, replies and upgrades. Larger headers remain rejected. Errors expose bounded stages and target categories without cookies, authorization headers or bodies. Observed configuration traffic counts as route evidence even when a command-line PAC flag is absent; visible suggestions remain an independent client-side observation.

Known local MCP discovery replies retain raw HTTP counters and a separate bounded probe history without animating model activity. Actual call failures, security denials and unknown paths remain inspectable. Source details and unavailable selections explain their current client access, interface, policy or selection restrictions in the existing UI.

Claude source-only setting removal and new owned configuration writes share the existing journal transaction and rollback. Failed client synchronization keeps the saved source and selected models and reports its configuration failure. This does not change the native OpenAI-mode routing contract or take ownership of ChatGPT sign-in.

Usage analytics retains bounded aggregate checkpoints. It applies only log appends witnessed inside this process's existing write lock; other-process writes, rotations, edits and unsafe checkpoints trigger a normal full read. Delta queues are capped and work runs on demand. No persistent index, database, polling timer or runtime dependency is introduced.

Verification covers focused protocol/configuration/usage regressions, the full verify command, native Codex sign-in and first-catalog replays, macOS/Windows CI, browser replay, isolated 1.3.4 upgrade, strict/offline platform installs and public package/asset integrity checks. The native CI keeps a verified 0.164.0 baseline alongside the latest CLI. Publication does not switch the active local service.
