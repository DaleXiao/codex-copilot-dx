# CCDX 0.9.20 verification report

Date: 2026-10-11. Baseline: `d45643d` (0.9.19).

## Approved scope

Six narrowly adapted lessons from Floway and Magpie; no copied platform,
multi-provider routing, persistent session index, account switching or Astra
subagent restriction. The latter remains explicitly deferred.

| Item | Delivered | Preserved boundary |
| --- | --- | --- |
| 1 | Separate gateway timing evidence for deltas, hidden reasoning/tool announcements, snapshots and runtime results | `isResponsesOutputEvent`/`sawOutput` and the compatibility-retry commitment are unchanged; empty envelopes/messages and external input/compaction are excluded. |
| 2 | Show TTFT/TPOT sample counts in status and dashboard, with gateway-estimate disclosure and bounded source counts | Existing timing fields remain; no claim of internal decode/prefill or pure model speed, no additional inference or polling. |
| 3 | Add latest official Codex CI regression with isolated configuration, adapted complete catalog and direct/proxied synthetic SSE | Client installation occurs only on the CI runner; no user config, credentials or actual inference. |
| 4 | Repair only an unsupported supplied multi-agent reasoning mapping to the last supported non-Ultra effort | Valid mappings, null/missing mappings, model identity, defaults, option order, instructions and multi-agent version stay intact. |
| 5 | Add two-entry / combined 2 MiB serialized analytics aggregate cache for settled logs | Full first scan, cloned results, same query single-flight, time-zone/date/file version keys, no disk index; warnings/future records/changes/oversize prevent retention. |
| 6 | Show locally advertised generation/editing availability in `image-status` | Same initialize/tools/list probe, no tools/call, provider request, credential output or implicit image setup. |

References inspected before adaptation:

- Floway timing boundary: `3978d4b586335cf96524c88d56a6c18833749c53`.
- Floway real-client installer checks: `1cd40e561f5a5339c36d0aa27af04fc7d4a9db77`.
- Floway Ultra mapping: `2045cd7ec4dc9104e5f2cfd5df53bdf1969d94e6`.
- Magpie speed sample counts: `3964ea656ca96a7d43223c5231a735a3aabac993`.
- Magpie long-history read reuse: `99fcddeeba2a`.
- Magpie MCP tool visibility: `6f4fb883eba5cfeac7a8cbd51de6e64c60a35e45`.

OpenAI streaming and subagent documentation were fetched. No general-purpose
unknown-event heuristic or forced highest-effort policy was imported.

## Tests and bounded review

- Baseline `npm run verify`: 985 tests, HTTP/SSE smoke, performance/resource and
  package gates passed before changes.
- Final `npm run verify`: 995 tests, no failures/cancellations/skips, all existing
  HTTP/SSE and performance/resource/package gates passed. Targeted tests and one
  scoped review preserved old retry semantics and added source-count, catalog,
  cache invalidation, image-tool and bilingual rendering assertions.
- The encrypted HTTP-200 failure regression now includes a hidden reasoning
  announcement before failure and still retries safely before visible output.
  Existing tests still prevent retry after actual output and preserve content,
  cancellation, backpressure, Fast/Auto Review and opaque history.
- Analytics covers concurrent identical reads, independent cloned results,
  append, same-size rewrite, replacement, rotation, truncation/removal, custom
  warnings, malformed/future records, oversized summaries, fresh files and
  read failures. Time zones, local-day rollover and the two-entry bound are
  exercised without enlarging the original plain-summary cache.
- Existing isolated startup replay passed image-disabled, optional config/skill
  conflicts, pending/failed image and invalid shared-configuration paths.
- Actual installed Codex `0.162.0-alpha.17.2` passed the isolated replay: CCDX's
  writer creates the temporary config, the real app-server reads its URL/model/
  provider, model/list accepts the adapted catalog, and both direct and proxied
  synthetic commentary/final messages retain the expected item identity.
- Browser check: Chromium already installed locally, eight English/Chinese,
  dark/light and 1280/420-wide cases; no page errors or document overflow.
  Visual inspection found crowded timing rows; the scoped repair stacks them
  vertically using the existing font and size. No browser download/user profile.
- Test-fixture DOM omissions were corrected without relaxing production checks.
  No live provider requests, user configuration edits or active-service restart.
  `git diff --check` passed. No new dependencies.

## Performance evidence

32 MiB synthetic usage log, 266,305 records, same 80,267-byte analysis result:

| Measurement | Baseline | Candidate |
| --- | ---: | ---: |
| First analysis | 595.40 ms | 599.11 ms |
| Second analysis | 588.07 ms | 0.44 ms |
| Third analysis | 571.08 ms | 0.40 ms |
| File streams opened across three reads | 6 | 2 |

After GC, candidate heap was 54,936 bytes above the baseline observation. These
are synthetic single-process observations, not real user-history promises. The
proven improvement is reuse of unchanged settled aggregates; actively written,
invalid or oversized histories deliberately remain uncached. No unlimited index.

Native stream parse/copy/write/drain counts, content hashes, cancellation and
zero reads while blocked match the baseline. Repeated image work settles;
large tool output and duplicate images still process once. Adapter import heap
remains 7 MiB, observed time 42.7 versus 42.3 ms and RSS 58.3 MiB in both.
Absolute timings remain machine-dependent, not an inference-throughput claim.

## Publication and cleanup

Initial final preflight: 112 package files, 293,779 packed bytes, SHA-1
`384201331ff9f2a8465917a44fd1c81bbf86af70`. Later package preflight is checked
again after documentation/index finalization and matched to the publish receipt.

GitHub uses the previously supplied DaleXiao PAT, freshly identity-verified and
held only in memory; npm uses the repository's existing NPM_TOKEN. Publication
requires the Node matrix and new latest-client CI check before one npm dispatch.
No local npm-registry query or replacement credential is used.

Clean only owned benchmark/release/browser helpers, synthetic logs, snapshots
and temporary configurations. Preserve dependencies, user images/settings/
credentials, running adapter and this report; finish with a clean synchronized
checkout and unchanged release tag.
