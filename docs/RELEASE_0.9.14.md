# CCDX 0.9.14 verification report

Date: 2026-10-08. Baseline: `4cd3315` (0.9.13).

## Delivered scope

| Item | Change | Boundary |
| --- | --- | --- |
| 1 | Filter unsupported image declarations in top-level tools, additional_tools and tool_search_output; retain carrier positions/IDs and selector subsets | Native routing is required when supported; Chat-only targets fail explicitly. A forced removed tool becomes none rather than enabling unrelated tools. Ordinary same-named functions survive. |
| 2 | Read-only doctor App/version/process observations and last observed client/bundled-catalog match | Executable identities only, never process arguments. No process killing/client patch. Old adapters report unavailable diagnostics; process age does not prove a stale App cache. |
| 3 | Main/subagent/sealed-reply native continuation regression | Preserve opaque Unicode/ciphertext and same-route history; no new decryption, provider routing, agent execution or upstream calls. Existing encryption/affinity rules remain. |
| 4 | Bounded recent-request context metadata in status/dashboard | At most 20 scalar snapshots; reused wire bytes/image counts, reported input tokens, explicit upstream context window and compaction outcomes. Unknown is not zero; ratio is not exact live session occupancy. |
| 5 | Downstream SSE idle comments on native and existing Chat streaming paths | 15-second interval after valid stream headers; never release a held retry prelude, change upstream deadlines, count as model output or bypass backpressure. Stop on completion/abort. No JSON-as-SSE or retry-policy expansion. |
| 6 | Short quick-start README plus full command/configuration reference | Preserve detailed guidance and safety warnings; ship the full reference in npm for offline use. Update help and documentation-contract checks, not their assertions. |

The tool-carrier and sealed-reply examples were informed by pinned Floway
`659f185` and Magpie `1efa4c6`; App diagnosis by Magpie `2f74a96`. This is a
scoped implementation, not an import of their provider framework, custom TLS,
prompt capture, automatic model/schema downgrade or account failover systems.
The OpenAI tool-search guide was checked as public contract context:
https://developers.openai.com/api/docs/guides/tools.

## Baseline and verification

- Clean 0.9.13 baseline: all 933 tests, offline HTTP smoke, resource/performance
  gates and package preflight passed before edits.
- Final `npm run verify`: all 949 tests, HTTP smoke, the new isolated idle-stream
  replay, existing performance/resource gates and package dry-run passed.
- Per-item targeted checks covered carrier positions/IDs, selector restrictions,
  native/Chat boundaries, same-named functions, process grouping, unavailable
  diagnostics, catalog privacy, sealed main/subagent/reply flow, numeric metadata,
  snapshot isolation, missing/zero values, lazy rows and documentation defaults.
- Isolated startup replay passed image-disabled, optional-image-conflict and
  invalid shared-configuration scenarios. Auto-review model/effort selection,
  foreground Fast/Standard, image generation/editing/delivery, usage cache,
  cancellation and existing client contracts retain passing regression coverage.
- One real read-only doctor inspection detected the currently running adapter
  was 0.9.11, distinct from the checkout/CLI. Its missing catalog-diagnostic
  support is not evidence that no client request occurred. No running service,
  user credential, App or client configuration was changed.
- Browser acceptance used an isolated fixture and empty auth settings. The new
  section remained collapsed initially; opening rendered numeric/unknown values
  without another status call. English/Chinese, light/dark and 320/390px checks
  passed with no whole-page horizontal overflow or browser warning/error logs.
  Expansion survived language switching. A synthetic-data screenshot is retained
  outside the repository as delivery evidence; the fixture tab/server were closed
  and the viewport override reset.

## Idle-stream experiment and limitations

The committed `scripts/sse-idle-replay.mjs` uses a synthetic upstream, a real
loopback HTTP client with a 200 ms idle timeout, and a 600 ms model silence:

| Case | Result | Provider invocations |
| --- | --- | --- |
| Baseline-equivalent, no comments | Downstream idle disconnection; no completion | 1 |
| Test interval 40 ms | Same reply completed; comments did not count as TTFT | 1 |
| Comments plus upstream idle deadline 350 ms | Deadline still aborted; no fabricated completion | 1 |

Production interval remains 15 seconds; shortened test clocks avoid minute-long
fixtures. The experiment demonstrates the downstream-idle mechanism, not that
all production reconnects are repaired. It cannot cure upstream disconnection,
quota, invalid SSE/JSON, or a held pre-output retry prelude. Unit checks verify
no header commitment, no post-terminal writes, no comments under backpressure,
abort cleanup and no busy 1 ms polling when headers are not ready. No live
inference or image-provider call was needed for this release's verification.

## Performance and bounded review

- Baseline/candidate native SSE parsing/copying, writes, drains, no reads while
  blocked, content hashes and cancellation invariants were identical across
  small, drifting, 1/4/8 MiB and slow-client probes. Import heap remained 7 MiB;
  retained image array-buffer growth remained zero and tool-output parsing one.
- Existing absolute timings varied slightly; both gates passed. This is not a
  proven inference/throughput speedup. Benefits are compatibility, bounded
  diagnosis, controlled idle-disconnection recovery and simpler documentation.
- Context figures reuse existing serialization/image summaries and upstream
  usage; no prompt scan, database, background dashboard polling or extra upstream
  call. App process inspection is lazy and bounded, only in the explicit doctor.
- Scoped review corrected held/header-unready timer rescheduling, fixture timing
  and cancellation realism, new outcome translations, old-adapter unknown-state
  wording and offline reference packaging. Existing document assertions now read
  both quick start and reference; none were removed. Assertions expecting a
  removed forced selector to become auto were corrected to the safer none
  contract, with additional subset/same-name regressions. No unrelated refactor
  or repeated scope-expansion review was undertaken. `git diff --check` passed.

## Publication and cleanup

GitHub CI and single npm-publication evidence are added after completion. GitHub
uses the previously supplied, verified DaleXiao PAT without printing/persisting
its value; npm uses the repository's existing NPM_TOKEN. Cleanup is limited to
owned temporary scripts, logs, caches and test settings; preserve dependencies,
user settings/credentials, the active adapter and useful report/screenshot evidence.
