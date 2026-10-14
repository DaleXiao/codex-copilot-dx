# CCDX 0.9.36: native prediction repair validation

Date: 2026-10-14. Base: released CCDX 0.9.35. Version: 0.9.36.

## Changes

- Bounded archive recognition checks named main/settings candidates rather than
  only the first chunk. Synthetic forwarding/real-chunk order cases pass, while
  malformed/oversized archives and missing protocol markers still fail closed.
  Platform signature verification is retained.
- `ccdx prediction fix` uses the compatible running adapter's loopback-only
  management endpoint. Startup, repair and shutdown share one serialized owner;
  concurrent repairs share one attempt, without creating another core service.
- Existing certificate/profile/port/company-route checks remain mandatory.
  Healthy bridges are kept. Explicit recreation gets a fresh supervised budget;
  supervisor health/route methods use the recovered current bridge.
- Missing routes, unreadable/ambiguous route inspection and bridge failures are
  distinct outcomes. Partial repair exits 1; no HTTP-success or bridge-readiness
  claim is treated as visible gray-text proof. Off remains off.

## Verification

- Final local suite: 1,214 passed, eight Windows-only skips, zero failures.
- Actual CLI/local HTTP replay verifies success, partial failure and disabled
  no-op; browser/remote/bad-body requests are rejected before repair dispatch.
- Offline HTTP/idle-SSE and all nine isolated CLI startup/reuse scenarios passed.
- Existing performance/resource gates, documentation/dependency contracts and
  package dry-run passed. Both new production modules are packaged; no runtime
  dependency, inference request, background watcher or client program patch added.
- The installed official App (26.1007.71326) passes the corrected read-only
  recognition and complete macOS signature check. No user profile or App file
  was changed for this check.

At initial diagnosis, the running 0.9.35 adapter lacked the new repair capability. A guarded
read-only check confirmed the new CLI rejects it before any repair POST. It
cannot hot-upgrade an already-running Node process. The first deployment of
0.9.36 therefore requires one CCDX-service restart; this work did not restart the
user's App or service. A missing App startup route is not hot-attached by fix.

Real logged-in gray-text recovery has not been tested in this release cycle.
Bridge readiness and inspected routes are not UI visibility evidence. The command
cannot attach a missing startup route to an already-running App without a normal
App relaunch, and does not attempt to do so.

## Bounded review

- Archive recognition is isolated from platform signature/profile verification;
  repair uses the existing optional-integration lifecycle and saved port.
- The management endpoint refuses browser/remote requests before reading their
  bodies. It has no inference handler, provider call or account-write responsibility.
- Review fixes include current-bridge health delegation, serialization of differing
  operations, shutdown-race cleanup, refreshed health PAC reporting and separate
  missing/unverified route outcomes. Tests cover each boundary.
- No new runtime dependencies, client program changes or global proxy/trust changes.
  Existing behavior outside optional prediction repair is covered by regression gates.
- Remote Windows CI found a test-only POSIX path literal in the new synthetic macOS
  signature fixture. The fixture now uses host path joining and retains both strict
  signature assertions. No production signature policy or failure was bypassed.

## Performance evidence

The existing performance/resource gate passes. This release does not claim an
inference speedup: compatibility scanning runs only when verification is needed,
and explicit repair adds no per-model-request probe, upstream call or watcher.
Adapter import RSS is 58.3 MiB with 7.1 MiB heap in this local sample (the 0.9.35
report recorded 58.6/7.1 MiB). SSE 1/2/4/8 MiB scan ratios remain 1.0; an 8 MiB
repeated tool output is parsed once, and eight duplicate images call the optimizer
once. These are gate results and individual samples, not statistical proof of
all-machine latency or a guarantee against future App protocol changes.

## Release checks and publication

Release commit `dd220c97c9b9ab2b16a87ad25494e9353cf70ba4` passed all eight
[candidate CI jobs](https://github.com/DaleXiao/codex-copilot-dx/actions/runs/38546826878):
Windows, macOS and Linux on Node 22.15/24, official Codex synthetic replays and
Chromium/WebKit bilingual/theme/viewport dashboard replays. The platform jobs
also validate isolated package installation/upgrade and native sharp execution.
CI is not a live corporate-network or gray-text visibility acceptance test.

GitHub release: [v0.9.36](https://github.com/DaleXiao/codex-copilot-dx/releases/tag/v0.9.36).
Its 146-file archive is 372,704 bytes; GitHub reports the matching SHA-256
`981368ebce371668b5c30f4fa6caa475365f1da8fbfa4cf166e525671e04c5e0`.
Local npm-pack SHA-1: `4cecf10aafab088d10921e80ebbc0d00da5c2255`.

[npm publication](https://github.com/DaleXiao/codex-copilot-dx/actions/runs/38547251451)
succeeded with `npm publish --tag latest`. The official registry acknowledged
`+ codex-copilot-dx@0.9.36`; the runner's 146-file package SHA-1 matches the local
archive above. This is registry publication evidence from the runner; an
independent local npm-registry read was not used as publication evidence.

The same release commit also passed all eight
[main-branch CI jobs](https://github.com/DaleXiao/codex-copilot-dx/actions/runs/38547232819).
The npm prepublication verification passed its regression, offline stream,
performance/resource and package checks before the registry accepted the release.
Publication used the user's previously provided GitHub PAT and the existing
repository npm publishing secret; neither credential is stored in this report.
