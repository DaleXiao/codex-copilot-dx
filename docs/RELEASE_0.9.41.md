# CCDX 0.9.41: output speed, HTTP evidence and module boundaries

Date: 2026-10-16. Baseline: 0.9.40 / `90d402f`.

## Changes and boundaries

1. WebUI and CLI show first output in ms and estimated output speed in token/s.
   Speed is summed output-token intervals divided by summed generation duration,
   not the inverse of average TPOT or concurrent system throughput. Missing usage
   stays unknown. Existing TTFT/TPOT API fields and sample definitions remain.
2. HTTP failures keep their original 20-record ring plus independent 20-record
   actionable and eight-record MCP method rings. Route/method noise cannot erase
   retained inference evidence. Counts still include those HTTP errors.
3. Diagnostic metadata adds safe type/parameter, method/allowlisted target,
   enum/numeric outgoing options and at most three attempt timings. Default HTTP
   diagnostics contain no arbitrary error prose. Explicit investigation mode can
   keep a redacted 500-character excerpt in bounded memory, not a request archive.
   Original status/body forwarding and existing retry policy remain unchanged.
4. Stream regression coverage checks completed/incomplete/failed terminal events,
   late duplicate/error events and transport resets; Chat DONE remains a hard
   boundary and a truncated reply remains incomplete. Existing semantic input
   validation is retained, not replaced with lossy text conversion.
5. Management routes and lazy optional WebUI/image routes are separate modules.
   The HTTP adapter composes callbacks rather than implementing those handlers.
   Codex prediction remains client integration; input-image optimization remains
   core inference. The existing GPT-6 tier rule moves into its provider policy
   module without changing behavior. No plugin host, extra process, dependency,
   install hook, global proxy mutation or prediction-route migration is added.
6. README/reference/architecture follow the code. An obsolete reference paragraph
   advising token deletion after Copilot 401/403 was removed; credential retention
   and independent identity verification remain the actual behavior.

## Luna investigation: proven limits

The baseline adapter retained 22 upstream HTTP 400 outcomes for gpt-5.6-luna and
two completed responses. Its cache advertised an enabled Responses model; saved
failure metadata included an image-free request. Original HTTP error bodies were
not retained, and later route/method errors replaced their rolling records.
Those facts cannot identify the exact rejected parameter or prove a regression.

Five bounded upstream probes used artificial text only, no saved conversations,
no automatic retries and no credential writes. Low-effort gpt-5.6-luna and
gpt-6-luna each completed; gpt-5.6-luna also completed with none effort, low effort
plus strict JSON Schema, and the same schema with streaming. Every probe returned
HTTP 200. No blanket model switch, effort downgrade, parameter deletion or new
400 retry was introduced. The historical failure remains un-reproduced; this
release improves its next-occurrence evidence, not a claim to have fixed its
unknown cause. Newly collected metadata resets at process exit.

## Review and verification

The pre-change local suite passed 1,284 tests, with nine Windows-only skips and
zero failures. Existing performance/resource gates also passed. Final local,
cross-platform, browser, installation and publication receipts are recorded below
only after their respective checks complete.

The implementation suite passed 1,294 tests, nine Windows-only skips, zero
failures; full verify included offline HTTP/SSE, memory/performance gates and
package contents. The nine-case isolated CLI startup/reuse replay passed,
including disabled and invalid optional configuration. Subsequent bounded review
added requested/served-model evidence (unknown purpose unless the explicit
Auto-review alias identifies it), with 66 focused tests passing. Browser fixtures
now assert actual ms/token-per-second display in both languages and themes.

Three fixed alternating baseline/candidate benchmark pairs used the same Node
22.20.0 arm64 machine and fixtures. Medians (baseline -> candidate):

| Probe | 0.9.40 | Candidate |
| --- | --- | --- |
| Adapter import | 40.6 ms | 41.3 ms |
| Import RSS / heap | 58.4 / 7.1 MiB | 58.6 / 7.1 MiB |
| Stable small-event stream | 25.986 ms | 26.618 ms |
| Drifted small-event stream | 34.524 ms | 34.775 ms |
| Stable 8 MiB-event stream | 49.383 ms | 49.215 ms |
| Drifted 8 MiB-event stream | 87.947 ms | 87.310 ms |
| Slow large-event client | 48.008 ms | 47.240 ms |
| Oversized-image adaptation | 358.7 ms | 360.9 ms |

All six benchmark runs passed resource/relative-performance gates. Stream bytes,
parse/copy ratios, backpressure and cancellation results matched. The measured
elapsed changes (-1.6% to +2.4% for these paths) are small mixed variations, not
evidence of a stable speedup. The roughly 0.2 MiB import-RSS difference is disclosed,
not hidden as a performance gain. This release improves diagnostic survival,
measurement correctness and isolation; it does not claim faster model inference.

The implementation follows selected ideas from source rather than copying their
frameworks: Magpie request/attempt correlation (`674b6ca`), CC Switch terminal
boundary/empty-error distinctions (`0a8d064`), and Floway provider-owned policies
and faithful input translation (`f117981`). Existing correct CCDX behaviors are
protected by regressions; full-body archives, multi-account routing, quota
polling and a generic plugin architecture are outside this release.

## Cross-platform acceptance and package

All fourteen jobs passed for runtime source commit
`c8b23a008fb0e060cead8878b2f693fece3e801a` in
[candidate CI](https://github.com/DaleXiao/codex-copilot-dx/actions/runs/38838969627).
This includes Node 22.15/24 on macOS/Linux, Windows native/profile/repair/stream
checks on both Node versions, strict npm 12 real installation/upgrade on all three
platforms, full Chromium repeated recovery in all three platforms, the official
Codex synthetic-provider replay and the bilingual Chromium/WebKit dashboard
matrix. No failed job was skipped or retried. Final changes after the frozen
runtime only clarify README/reference privacy wording and this audit receipt;
the six documentation-contract checks passed for those clarifications.

The final tarball has 155 files, 395,804 bytes, SHA-1
`fdeca052f07073c839f9d345c892e09027595ccd`, SHA-256
`7d65df1bbdc5300374f7c02a391de42e9fb5737ac633f56e458e472576ffd0ec`.
It adds approximately 5 KiB compressed over 0.9.40. Direct dependencies remain
sharp 0.35.3 and smol-toml 1.8.0; no install hook is added. Tests, experiments,
temporary release helpers, keys and credentials are excluded. This report is
not packed and does not change published package bytes. Publication receipts
follow only after GitHub and npm confirm success.

## Publication receipts

- GitHub stable [v0.9.41](https://github.com/DaleXiao/codex-copilot-dx/releases/tag/v0.9.41),
  release ID 414466313, draft false, prerelease false. Asset 645856391 reports the
  same 395,804-byte size and SHA-256 above.
- [npm publication workflow](https://github.com/DaleXiao/codex-copilot-dx/actions/runs/38839641469)
  succeeded for tag source `e0502eda3cce91d4148b8190ed583375cb982b11`.
  Its log confirms version 0.9.41, the matching SHA-1 above, publication to
  registry.npmjs.org with tag latest, and `+ codex-copilot-dx@0.9.41` at
  2026-10-16 02:17:44 UTC. No second publication or credential fallback was used.
- Publication used the same identity-verified owner PAT as the preceding
  release, held in process memory only; the existing npm workflow used its
  repository secret. No browser login or local credential/config change occurred.
- Temporary benchmark/baseline/package/publishing material is removed after
  verification. Pre-existing `experiments/` is retained. The live adapter and
  Codex App are not restarted or upgraded by this release procedure.
