# CCDX 1.2.25

This patch fixes paused Codex access being mistaken for a missing client key,
makes installation locks diagnosable, clarifies native memory-model defaults,
and improves cancellation and request-flow rendering.

## Changes

- A single Codex access-mode calculation distinguishes disabled, paused, native
  GitHub and gateway selections. Empty deployments return
  `503 ccdx_client_source_disabled` before credential checks on models,
  Responses and compaction. Selecting a GitHub model restores native access;
  mixed/API deployments still require the private client key. No model is
  silently selected, and native login files are preserved.
- Install locks record PID, creation time and backup location. Existing-lock
  errors name the file; permission and other I/O failures retain their actual
  cause. Old empty locks remain owner-unknown recovery barriers. Age alone
  never deletes a lock or an unfinished restoration backup.
- Memory generation enabled with no reliable model-ID evidence shows Chosen by
  Codex / Default model ID not available. Explicitly disabled generation shows
  Memory generation is off; unknown generation remains Not detected. Explicit
  native models and observed evidence retain their original labels. Checking a
  model does not establish its memory role or prove a successful memory write.
- Manual API credential waits use the existing abort-aware singleflight. One
  cancelled caller returns independently, other callers retain their wait, and
  a late credential result never dispatches the cancelled request. OS secret
  reads retain their existing bound and credential isolation.
- Messages/count requests replace the completed body-upload timer with a
  preparation budget. Preparation failures return 504 with
  `messages_prepare_timeout`, rather than misreporting a body-upload failure.
  Slow uploads retain their separate budget. Existing upstream/count/stream
  deadlines and no-inference-retry rules remain.
- Moving flow paths use a separate composited SVG layer; background paths and
  model nodes retain their identity. Empty activity layers are hidden. Waiting,
  idle, stale, hidden-page and reduced-motion states keep their existing meaning.
  Palettes, layout, model alignment, line geometry and summaries remain.
- Account regressions cover identity 401 versus 403/429, entitlement denial and
  catalog 401/403/503. Checks keep saved credentials and never start Device Flow;
  an optional endpoint failure or local credential failure is not ChatGPT logout.

## Upstream references and limits

The activity-layer principle follows [Magpie 77f8601](https://github.com/yetone/magpie/commit/77f860105ca2b0ea4a967f45bbba3072c1ef589c).
An isolated Chromium short trace compared one baseline and one trial per
3/12/48-model case, with three moving model routes. Combined Paint/RasterTask
time fell approximately 26%, 34% and 45% in that run. These are two-second
headless trace samples, not production latency, frame-rate or native Windows
GPU guarantees. The trial met its predeclared gate before implementation.

[Magpie 5a94eec](https://github.com/yetone/magpie/commit/5a94eec3aead887bdecdbf3794f814763068d805)
informs preparation/wait boundaries without copying its timeout values.
[CC Switch 0820ff7](https://github.com/farion1231/cc-switch/commit/0820ff73f74d222ba12ca55ad76e093b949971b4)
informs transient-error regression coverage, without importing OAuth refresh
ownership or treating every 401 as an invalid native login. Floway remains at
the previously reviewed `3919a92`; its catalog revision/backoff practices were
already represented in CCDX. No new upstream runtime, tokenizer, protocol IR,
masking subsystem, cross-source routing or update channel is introduced.

## Verification

Local `npm run verify` passed 1,618 tests: 1,608 passed, ten optional/platform
skips and zero failures, followed by offline HTTP/SSE smoke, performance budgets
and package-manifest checks. The 48 Chromium/WebKit dashboard cases and twelve
connection-editor cases passed across existing palettes, languages and sizes.
Native Codex passed five isolated startup/cache states with seven first-read
models, ChatGPT auth and old-session resume. Real CLI handoff/outage/rollback
retained config/auth and old response IDs. Isolated npm 1.2.24 → 1.2.25 upgraded
commands and loaded sharp and the supported broker on Darwin arm64. All replay
providers and identities were synthetic; no paid inference was performed.

Exact-commit cross-platform CI gates publication. Release assets and the public
npm package are independently verified after publication. The existing user
service and company registry/proxy/CA policy are preserved during release.
