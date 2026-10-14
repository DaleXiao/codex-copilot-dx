# CCDX 0.9.36: native prediction repair validation

Date: 2026-10-14. Base: released CCDX 0.9.35. Target: 0.9.36.
Publication and cross-platform receipts are recorded below after their checks pass.

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

The current running 0.9.35 adapter lacks the new repair capability. A guarded
read-only check confirmed the new CLI rejects it before any repair POST. It
cannot hot-upgrade an already-running Node process. Deployment needs a later
release and one CCDX-service restart; this work did not restart the user's App
or service. The App's current missing route is not hot-attached by this feature.

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

## Release checks and publication

Pending the 0.9.36 release checks; no publication is claimed by this candidate.
