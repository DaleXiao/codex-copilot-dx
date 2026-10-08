# CCDX 0.9.18 verification report

Date: 2026-10-08. Baseline: `dd6c91f` (0.9.17).

## Delivered scope

Four approved architecture batches, with no new user features or configuration.

| Batch | Change | Preserved boundary |
| --- | --- | --- |
| 1 | Partition the 5,170-line adapter test into transport, request preparation, history, bridge, compatibility and HTTP integration suites | All 155 original test names and assertion bodies match the baseline; shared HTTP fixtures live outside test discovery. |
| 2 | Move loopback checks to `security.mjs`, errors to `http-errors.mjs` | Original predicates, LAN/Host/Origin boundaries, error objects and compatibility exports remain unchanged. |
| 3 | Share `auth-status.mjs`, `live-models.mjs` and `usage-store.mjs` between CLI and dashboard | Same identity sources, model filters/sorting, timeouts, responses, terminal output, usage queues, rotation and bounded summary cache. |
| 4 | Extract weighted queues and reservations into `request-admission.mjs` | Same budget, fairness, decompression, cancellation, resize, release and diagnostics algorithm. |

Terminal text sanitation was moved unchanged to `terminal-text.mjs`, because
usage warnings and failure diagnostics need it without loading CLI table layout.
`cli-table.mjs` retains the exact original export. No new dependencies/frameworks.

Production source grows by 35 lines / 1,722 bytes across six extracted modules,
not duplicated implementations. `http-transport.mjs` shrinks from 842 to 498
lines; `usage.mjs` from 493 to 142; CLI auth from 287 to 109; CLI models from
223 to 93; adapter tests from 5,170 to 374. Some responsibility moves to the
named modules; lower file counts/line counts are not the sole acceptance goal.

Authentication workflow, WebUI assets, model routing/catalog, encrypted
continuation, Fast/Auto Review semantics, image provider/skill behavior, cache
algorithms and the Responses streaming state machine were not rewritten.

## Verification

- Clean baseline `npm run verify`: all 968 tests, HTTP smoke, SSE idle replay,
  performance/resource checks and package preflight passed.
- Each batch passed its targeted checks: the 155 relocated tests, 101 foundation
  tests, 100 data/presentation tests and 65 admission/lifecycle tests.
- Final `npm run verify`: 971 tests, no failures/cancellations/skips, plus all
  existing smoke, stream and performance/resource/package gates.
- The three added architecture checks cover identical old/new function bindings
  (including the one shared usage queue/cache), dependency direction and absence
  of static source-import cycles. The pre-existing dynamic compatibility shim
  remains supported, not removed to improve graph statistics.
- Independent baseline/candidate comparison of 12 existing modules confirms all
  95 pre-existing export values and public function bodies are unchanged.
- Isolated config/startup replay passed cold start/reuse, disabled image,
  markerless registration, image config/write/skill conflicts, invalid provider,
  pending/failed image requests and invalid shared configuration. Main Responses
  stayed available where designed; disabled-image cases made zero image calls.
- Existing tests retain generation/edit/delivery, opt-in registration, CLI
  formats, language/theme/animation, models, Fast, Auto Review, encrypted history,
  compaction, incomplete/failed states, cancellation and downstream backpressure.
- No live model/image-provider calls, real credential use for inference, user
  config writes or active-service restarts. `git diff --check` passed.

## Performance comparison

First collect three fixed runs per revision, then one bounded confirmation with
balanced baseline/candidate ordering (three per revision). Do not repeat until
a favorable result. All resource/operation-count gates passed in every run.

Balanced-order medians on this machine:

| Probe | 0.9.17 | 0.9.18 |
| --- | ---: | ---: |
| Adapter import | 39.0 ms | 38.1 ms |
| Adapter retained import heap | 7 MiB | 7 MiB |
| 5 MiB request, concurrency 4 | 95.8 ms | 94.0 ms |
| 30 MiB request, concurrency 1 | 142.5 ms | 147.3 ms |
| 30 MiB request, concurrency 2 | 250.8 ms | 247.8 ms |
| 5 MiB x4 peak RSS | 162.9 MiB | 162.4 MiB |
| 30 MiB x1 peak RSS | 221.3 MiB | 220.6 MiB |
| 30 MiB x2 peak RSS | 285.6 MiB | 277.7 MiB |

Native SSE parse/copy/write/drain counts, output hashes, cancellation and zero
reads while blocked are identical. Large tool output still parses once;
duplicate images still optimize once; repeated image work settles and remains
within the original retention budget. No normal inference calls or polling added.

Absolute timings vary: the 30 MiB single-request median is 3.4% slower in the
balanced run, with overlapping individual ranges (baseline 140.3-143.5 ms,
candidate 141.2-148.3 ms). Other cases are mixed. This is not evidence of a
throughput speedup, nor a proven sustained slowdown. No algorithm or resource
gate was weakened. The primary proven benefit is clearer module/test ownership.

Single full-verify observations were 10.51 versus 9.91 seconds and maximum
reported resident set 382,156,800 versus 367,542,272 bytes. These are not aggregate
concurrent-process memory measurements or stable end-user speedup claims.

## Bounded review and repairs

One scoped review retained legacy exports instead of adding wrappers or breaking
deep imports. Tests caught missing compression fixture imports and the removed
usage-warning sanitizer dependency; both were repaired without changing any
assertion, warning semantics or cache policy. Shared fixture placement was fixed
so Node does not count it as a standalone empty test. No unrelated refactor.

## Publication and cleanup

Package preflight: `codex-copilot-dx@0.9.18`, 111 files, 289,510 packed bytes,
SHA-1 `661f0882ec81f6e57559b8b04a90bb027019d410`.

GitHub identity and target were checked with the previously supplied DaleXiao
PAT, held only in process memory. Remote main matched the clean baseline.

- Application commit/tag: `694b5577ec9d87b7fb7ad67145fdb159e3f342ad` /
  `v0.9.18`. The annotated tag object is
  `8efacdf4172b87d2f1b2586aa326a3deecee31d4`; report-only updates do not move it.
- GitHub CI passed on Node 22.15 and 24, including full verification and
  isolated startup replay:
  https://github.com/DaleXiao/codex-copilot-dx/actions/runs/37748296928.
- Formal Release, neither draft nor prerelease:
  https://github.com/DaleXiao/codex-copilot-dx/releases/tag/v0.9.18.
- Exactly one npm publish workflow succeeded with prepublish gates:
  https://github.com/DaleXiao/codex-copilot-dx/actions/runs/37748534483.
  Official receipt confirms version 0.9.18, `latest`, 111 files and SHA-1
  `661f0882ec81f6e57559b8b04a90bb027019d410`, matching local preflight.
  npm used the repository's existing NPM_TOKEN, not a newly selected credential.
- One independent, unauthenticated official-registry read returned ENOTCONN
  on this machine. This does not replace the successful publication receipt;
  publication was not repeated and no mirror or alternate token was tried.

Cleanup is limited to owned measurement/release helpers, logs, the baseline
copy and temporary test directories. Preserve dependencies, actual user
settings/credentials, active services, the source and this report. Final handoff
requires clean git status, an empty cleanup preview and synchronized remote main.
