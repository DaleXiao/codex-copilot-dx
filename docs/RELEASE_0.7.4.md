# CCDX 0.7.4 verification report

Date: 2026-09-06. Baseline: `debddf1` (0.7.3).

Historical verification for 0.7.4. See [current guidance](../README.md) for current behavior and configuration.

## Scope

- Reuse the exact serialized request after an image fallback reaches its byte
  budget; skip serialization for a fallback that made no changes. Compression
  profiles, source-image selection, output bytes, and history policies retain
  their existing behavior.
- Add bounded preparation histograms and adapter-entry-to-first-output timing
  to the existing runtime status. Preserve upstream TTFT/TPOT definitions.
- Extend offline performance checks to the native Responses transformer and
  repeated image preparations. Include a public-domain photograph and a
  generated desktop-sized screenshot in the npm package for offline use.

No model-routing, message-identity, encrypted-state, compaction, image-quality,
concurrency-limit, authentication, or persistence policy changes are included.

## Verification

- Full `npm run verify` passed locally on Node 26.3.0: **632 tests, 0 failures**,
  offline HTTP smoke, performance/resource checks, and package dry run with
  73 entries.
- Four negative controls run against 0.7.3 detected the redundant full-body
  serialization. The same tests pass on 0.7.4: successful fallback serializes
  twice instead of three times; no-op fallback serializes once instead of twice.
  Both ordinary image content and stringified tool output preserve exact bytes.
- Timing tests cover unchanged upstream TTFT/TPOT, concurrent request isolation,
  retry samples, unchanged synchronous/asynchronous errors, and native, Chat
  fallback, and compact handler integration. Offline HTTP status verifies that
  the new fields are exposed by the running adapter.
- Native SSE checks cover 5000 small stable/drifting deltas, fragmented
  1/4/8 MiB events, and slow clients retaining write buffers until drain.
  All output hashes matched; each event was parsed once; instrumented buffer
  copies were 1.524–2.506 times input size; no reads occurred while blocked.
- Six rounds of four concurrent image preparations produced identical outputs,
  warm-cache hits, and no remaining queued/in-flight image work. The full gate
  observed 50,024 bytes of retained-heap growth after warm-up and GC, with zero
  retained ArrayBuffer growth. The retention allowance scales with two input
  batches, with an 8 MiB minimum; RSS remains report-only.
- The release process requires the existing GitHub CI matrix (Node 22.15.0 and
  24.x) to pass before dispatching the existing npm publishing workflow.

## Performance comparison

Same synthetic harness on the baseline and candidate. Three isolated runs per
version found unchanged output, parsing counts, and copy ratios. Image cold
preparation medians were 136.121 / 137.325 ms; warm preparation medians were
28.908 / 29.072 ms (0.7.3 / 0.7.4).

Some short cold SSE timings varied, so one bounded follow-up used a warm-up
run followed by five measured runs per version:

| Native SSE workload | 0.7.3 median ms | 0.7.4 median ms |
| --- | ---: | ---: |
| 5000 stable small deltas | 10.013 | 9.956 |
| 5000 drifting small deltas | 14.507 | 14.868 |
| Stable 1 MiB events | 4.486 | 4.537 |
| Stable 8 MiB events | 38.254 | 39.295 |
| Drifting 8 MiB events | 54.551 | 54.187 |

The native transformation implementation is unchanged. These measurements
support preserving its operation counts and behavior, not a production speedup
claim. Timings include harness work and vary with JIT, GC, and machine load.

## Evidence limits

Preparation samples measure selected operations, not every millisecond of local
work. Image intervals include scheduling and cache lookup, and repeated stages
can produce multiple samples per request. First-output timing observes a delta
inside the adapter; it does not measure client display or completed socket drain.

The image fixture exercises actual encoding and bounded retained memory, but
does not measure model vision accuracy. This release did not issue live Copilot
inference requests or perform a desktop visual test. Existing protocol,
history, encrypted-replay, timeout, cancellation, and identity tests passed.
