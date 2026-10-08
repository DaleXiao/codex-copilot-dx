# CCDX 0.9.16 verification report

Date: 2026-10-08. Baseline: `1916e6f` (0.9.15).

## Scope

- Rewrite dashboard English and Simplified Chinese together in the existing
  local language asset. Retain all 180 previous message keys; provide 213 bilingual
  entries covering titles, controls, statistics, empty/loading/error states,
  tooltips, accessibility labels, diagnostic field names and animation names.
- Chinese functional names use 2–4 characters. Descriptions are split into short
  lines of at most 20 characters, excluding dynamic values and unchanged raw
  identifiers/units. English uses the same meanings, not Chinese length limits.
- Distinguish local history from reused model input, HTTP success from completed
  replies, missing records from zero requests and unconfirmed image setup from
  disabled image generation. Keep Token/MiB units, the 365-day range, incomplete
  record warnings and the account's saved-local/not-online-checked boundary.
- Translate animation captions without losing the default marker, numeric order,
  saved theme or pending choice. Keep theme IDs, model names, commands, literal
  errors, diagnostic clipboard keys/values, calculations and endpoints unchanged.
- Add line-break presentation for existing notes and update reference labels.
  No backend, inference, image provider, auth, configuration, dependency, security
  policy, refresh schedule, retry or cancellation changes.

## Baseline and verification

- Clean baseline `npm run verify`: all 951 tests, isolated HTTP smoke/SSE idle
  replay, performance/resource gates and package preflight passed before edits.
- Candidate full gates passed with 956 tests; five new regressions cover bilingual
  parameter preservation, Chinese lengths, translated animation/default-marker
  identity, literal diagnostic values/clipboard data and scoped HTTP error copy.
- The 29 targeted dashboard tests passed. Existing checks continue to cover no
  requests on language switches, unchanged chart/calendar nodes and selections,
  expanded failure details, unsaved animation choices, reduced motion, lazy frame
  loading, stop-on-collapse and no retry loops. Startup replay passed, including
  image-disabled and optional-image-conflict scenarios.
- Isolated browser acceptance used synthetic data and separate settings only.
  English/Chinese, light/dark, 320/390px and desktop checks passed with no whole
  page horizontal overflow or browser warning/error logs. Tables keep internal
  scrolling, native details/summary keyboard controls and shared `+` / `−` cues.
  Language switches preserved open sections, chosen animation, enabled Save,
  default marker and raw error `{input}` text. Units and 365-day range remained
  visible. Useful screenshot evidence is retained outside the repository.

## Performance and bounded review

- No new API requests, polling, timers, dependencies or inference-path work.
  The existing formatter does one local dictionary lookup. Nine small caption
  spans are created only when the existing animation frame list is opened; they
  keep the default marker separate during translation, without rebuilding charts.
- Baseline/candidate native stream parsing, copying, writes, drains, backpressure,
  content hashes and cancellation invariants were identical. Import heap stayed
  7 MiB, duplicate-image optimization one call and large tool-output parsing one.
  Both gates passed; timing noise is not a claimed inference speedup.
- Bilingual wording adds roughly 8 KiB of raw static assets (roughly 2.4 KiB gzip),
  loaded from loopback using the same requests. This is a small dashboard asset
  cost, not zero extra bytes or an upstream streaming/performance change.
- One scoped review corrected a new HTTP copy path that could consume literal
  `{status}` text, retained the 365-day cue/units, kept the default marker alive
  through translation, and removed a duplicate image-state explanation. Assertions
  were updated only for intentional copy changes; functional checks were retained
  and extended. Final gates follow these corrections; no unrelated optimization
  or repeated scope expansion was undertaken. `git diff --check` passed.

## Publication and cleanup

- Application commit/tag: `b8778dadab86755a19463280148350dc814c0e00` /
  `v0.9.16`. Report-only updates do not move the tag or change package bytes.
- GitHub CI passed on Node 22.15 and 24:
  https://github.com/DaleXiao/codex-copilot-dx/actions/runs/37733520983.
- Formal GitHub Release, neither draft nor prerelease:
  https://github.com/DaleXiao/codex-copilot-dx/releases/tag/v0.9.16.
- Exactly one npm publish workflow succeeded, including prepublish gates:
  https://github.com/DaleXiao/codex-copilot-dx/actions/runs/37733655891.
  The official receipt confirms `codex-copilot-dx@0.9.16`, `latest`, 105 files and
  SHA-1 `7e8ac03e7df2be52a591a07dd1a5b6d7ee2cc3df`, matching local preflight's
  287,020-byte package.
- GitHub used the previously supplied, verified DaleXiao PAT without printing
  or persisting its value; npm used the existing repository NPM_TOKEN. One
  independent official-registry query returned ENOTCONN. Publication was not
  repeated; the successful official publish receipt and matching hash are separate
  evidence from that read failure.

Cleanup is limited to owned fixture/settings, release helper, logs and npm query
cache. Preserve real credentials/settings, dependencies, running adapter and
report/screenshot evidence. Final handoff requires a clean synchronized checkout.
