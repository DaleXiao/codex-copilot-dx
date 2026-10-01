# CCDX 0.9.6 verification report

Date: 2026-10-01. Baseline: `0c18875` (0.9.5).

## Scope

- Expand the last 10 existing upstream failure records, preserve open details
  on status refresh, and copy only existing redacted diagnostic fields.
  No session transcripts or inferred session mapping are collected.
- Fold animation settings into the footer with a header shortcut. Fetch frames
  only on opening, stop timers on folding/hidden page/reduced motion, and keep
  unsaved choices. Saving still applies on next CCDX start.
- Add opt-in daily input/output bars and a 365-day recorded-call/token calendar
  to Usage. Browser-local time zones, model filters, 7/30/90-day ranges and day
  drilldown use one bounded metadata snapshot, sharing the original log scan.
- Retain the original aggregate/model usage response and CLI behavior. No
  dependencies, polling, persistent analytics store, inference-path changes,
  message/tool/time analytics, or client transcript access were added.

## Verification

- Baseline `npm run verify`: 875 tests, offline smoke, performance/resource
  gates and package dry-run passed before implementation.
- Targeted tests cover rotated/current log parity, time zones and DST, invalid
  timestamps, partial counts, missing history versus zero usage, 365-day/100-model
  bounds, opt-in single-scan behavior, API security, collapsed timers, reduced
  motion, unsaved-state preservation, initial-load races, failure/no-retry-loop
  behavior, text-only diagnostic rendering, copy fields and day/model filtering.
- Real-browser verification on an isolated fixture adapter covers dark/light
  themes, 390px layout without page overflow, all-history restoration, model
  filtering and zero-use drilldown, animation save/fold/reopen, failure details
  and credential redaction. Browser console reported no errors or warnings.
  The active adapter and real user settings were not changed.
- Review corrected an inconsistent day/model drilldown and ensured previews
  never start a timer before frames exist. Date and month axes make charts
  interpretable without relying only on hover text; partial end-month labels
  are omitted rather than overlapping or spilling into a second label row.
- Animation startup metadata: 505 bytes versus 61,587 bytes for full frames,
  a 99.18% reduction for that request. Closed settings run zero preview timers.
- A 30,000-record aggregation microbenchmark (seven alternating-order runs)
  measured plain per-record aggregation at median 11.6ms and optional daily
  aggregation at median 40.6ms. Analytics therefore adds work only on explicit
  opening/refresh, not the default usage path or inference requests. This is
  an in-memory aggregation probe, not a disk-scan latency guarantee.

- Final `npm run verify`: 887 tests passed (12 more than baseline), offline
  HTTP smoke passed, performance/resource gates passed, and package dry-run
  passed. No detected regression in the covered paths; these checks do not
  prove universal client behavior or improved inference speed.
- After the final month-label layout correction, all 11 targeted UI/document
  tests passed, and the browser confirmed one label row with no page overflow.

## Limits

Only retained current/rotated usage logs are available. Pre-retention days are
unknown; even later zero counts mean zero recorded usage calls, not proof of
no user activity. The oldest retained day and missing token fields may be
partial. Cache tokens are a subset of input, not an additional bar segment.
Model filters are capped at 100 while all-model daily totals retain every
in-range valid-timestamp record. No session-shape analysis is included.

## Publication

- Release commit/tag: `8a4963d` / `v0.9.6`.
- GitHub CI passed for this exact commit:
  https://github.com/DaleXiao/codex-copilot-dx/actions/runs/36809337426.
- GitHub Release is public (not a draft or prerelease):
  https://github.com/DaleXiao/codex-copilot-dx/releases/tag/v0.9.6.
- The one-shot npm publish workflow succeeded, including its existing
  `prepublishOnly` verification:
  https://github.com/DaleXiao/codex-copilot-dx/actions/runs/36809448639.
  The official-registry receipt confirms `codex-copilot-dx@0.9.6`, tag
  `latest`, 100 files, 265.4 kB, and SHA-1
  `b47c4185d93bd8007eec174997cd63c4f22a554d`, matching local pack preflight.
- This machine's independent registry lookup returned `ENOTCONN`;
  publication was not repeated. GitHub operations used the previously
  user-provided PAT, not a different stored account or browser authentication.
- The isolated preview tab/server, temporary script and fixture settings were
  removed. Existing user settings, running adapter and dependencies were
  preserved. A screenshot was retained outside the repository as a delivery
  artifact. Version/tag were not moved by the documentation-only evidence
  commit; no second npm publication was made.
