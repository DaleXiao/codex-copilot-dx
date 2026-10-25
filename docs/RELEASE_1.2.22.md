# CCDX 1.2.22

This patch fixes two reproduced cold-start races, contains optional Web view
failures, adds the approved request-flow ring, and introduces explicitly opted-in
nightly software updates. Normal starts retain the existing process model.

## Changes

- Join simultaneous reads of one API credential. Invalidation prevents late
  reads from replacing a newly written key or repopulating a cleared cache.
- Separate each transport-setup waiter's cancellation from the shared operation;
  cancel setup when no waiter remains or its provider closes.
- Contain optional status/usage/animation failures with local retry. Update
  request detail rows in place; retain existing shell, focus and draft ownership.
- Rotate a thin theme-colored circle around the flow atom only with fresh active
  requests. The atom stays still. Idle/hidden/stale/reduced-motion behavior and
  existing summaries remain explicit.
- Snapshot/version static assets and support content ETags/304 without caching
  account/API data. Version mismatches require reload rather than mixed assets.
- Put an off-by-default overnight-update switch and risk text inside Version &
  updates. It takes effect after a normal restart; no OS service is installed.
- Stage pinned, checksum-verified Release packages in an independent npm prefix,
  using the current registry/proxy/CA and permission policy. Verify native modules
  and preserve standard/private command launchers. Correct relative symlink
  restoration and completed-rollback idempotence discovered by real npm replay.
- Keep active code on immutable package trees. Update only within the local
  00:00–04:00 window after ten observed idle minutes, selecting same-series stable
  patches at least 24 hours old. Sleep gaps reset observation; work defers a switch.
- Transfer bounded Responses state, source-scoped cached API keys and image-edit
  handles over private IPC,
  preserve native client files/sign-in and model/default contracts, then admit
  traffic. Warm candidates are checked before the old instance releases its
  listener; failed promotion resumes the retained old process and its caches.
  Ctrl+C stops the controller and worker. Conversation payloads, cached keys and image references are not
  checkpointed to disk; busy or >64 MiB handoff state defers the update.

## Boundaries

No request-content masking, framework migration, generic protocol IR, model-name
capability guessing, cross-source inference retry or automatic major/minor
upgrade is added. The update feature requires explicit opt-in, recognized writable
installation ownership, and configured dependency access. Switching can briefly
interrupt new requests; rollback is bounded and can require manual recovery.
Old failed native sign-in/model paths from 1.2.17 and 1.2.20 remain protected by
the native OpenAI-mode and first-catalog regression gates.

The implementation principles reference pinned Magpie request ownership and
request-local catalog reuse (4dfd882), CC Switch per-app switch isolation and
selected-provider regression (de0a235), and Floway request-body ownership and
version-bound catalog snapshots (3919a92). No upstream runtime is imported.

## Verification

Local `npm run verify` passed 1,571 tests: 1,561 passed, ten optional/platform
skips and zero failures, plus HTTP/SSE smoke, performance/resource budgets and
pack checks. The verified 1.2.21 → 1.2.22 isolated upgrade loaded sharp and the
supported native broker on Darwin arm64. Real npm replay verified staging,
standard/private launchers, package rollback and corrupt-download retention.

Real CLI workers preserved old response IDs, model lists, config and native auth
through successful handoff; candidate discovery outage retained the original
instance, and promotion failure restored that same process. The bundled native
Codex replay passed all five startup/cache cases with seven first-read models,
ChatGPT auth, native OpenAI identity after migration, and legacy-session resume.

Twelve Chromium/WebKit connection cases and 48 dashboard theme/language/width
cases passed. Four additional focused cases covered the ring, stable request
rows, default-off risk controls and injected optional-view failure/retry.
All provider responses in these replays were synthetic; no paid inference or
real account changes were performed. Exact-commit cross-platform CI gates
publication; every GitHub asset and public npm package is independently checked
after release. Company registry/proxy/certificate policy remains unchanged.
