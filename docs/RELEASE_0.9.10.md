# CCDX 0.9.10 verification report

Date: 2026-10-05. Baseline: `530f13c` (0.9.9).

## Scope

- Preserve native Responses `agent_message` items. On the existing Chat fallback
  only, frame agent messages as non-human input without user consent/approval,
  retaining escaped author/recipient, content-type distinctions, and supported
  images/screenshots. Reject unsupported file/audio/encrypted content explicitly.
  No extra model calls, retry policy, endpoint, dependency or client patch.
- Add contract fixtures and lossless opaque-state tests, including unpaired UTF-16
  surrogates, control characters, base64 variants, snapshot isolation and exact
  JSON byte accounting. Do not change encryption or history-affinity policies.
- Retain at most 20 scalar request timelines for Responses and compaction. Attach
  generated local IDs to failure events; correlate final outcomes in the existing
  dashboard failure details and include transport/incomplete/cancelled requests.
  Keep aggregate TTFT/TPOT definitions, HTTP/model outcome separation, text-only
  rendering, copy redaction boundaries, languages and manual refresh unchanged.
- No payload/header/token capture, background polling, disk history, custom TLS,
  multi-provider framework, tool loop, native ImageGen interception or new UI
  section. Optional image enablement and main startup remain independent.

## Verification

- Baseline: all 900 tests passed; existing performance/resource gates passed.
- Final local `npm run verify`: all 910 tests passed, offline HTTP smoke passed,
  performance/resource gates passed, package dry-run passed.
- Isolated startup replay passed with disabled images, enabled-image maintenance
  conflicts and invalid shared configuration. No real configuration or credential
  was modified and no real inference request was used.
- New coverage verifies non-human framing, escaped delimiter injection, typed
  text/refusal/reasoning, images/screenshots, explicit incompatible-content errors,
  unchanged native payloads, one-call behavior, Unicode replay and history memory
  release under repeated eviction in an isolated `--expose-gc` child process.
- Timeline tests cover preparation, compatibility attempts, JSON without invented
  TTFT, validation, HTTP 200 partial-stream failure, cancellation, bounded retention,
  snapshot isolation and generated HTTP request-ID correlation on all three routes.
- UI tests verify recovered-event correlation, transport failures, bounded/text-only
  copied metadata, language state, expanded details, raw braces and no extra requests.
- Review corrected the memory-test fixture: clearing history resets its configured
  limits, so the eviction probe explicitly reapplies its budget after warm-up.
- Review corrected the retry detail label when the correlated final outcome is known;
  uncorrelated historical events still explicitly state that the outcome is unknown.
- Browser acceptance against an isolated fixture server confirmed recovered events
  show `completed`, HTTP 200 transport failures show their stream phase and latest
  activity, raw diagnostic braces remain intact, expanded details survive English/
  Chinese switching, and light/dark appearance works. No overflow at 320/390px;
  browser warning/error logs were empty. The final source-only label correction
  clarifies that `origin` describes a terminal or error source, not always an error.
- Initial sandboxed full verification reached 909 passing tests, then its loopback
  smoke listener was denied with EPERM. The same checks passed with permission to
  run the isolated local listener; no application check was removed or weakened.

## Performance comparison

The same existing probes ran before and after the changes. Native SSE parse/copy
ratios, parse counts, writes, reader cancellation, content hashes and backpressure
were unchanged, including 1/4/8 MiB frames and slow downstreams. Stable-small was
25.851 -> 25.549 ms; drifting-small 34.582 -> 33.929 ms; stable-8MiB 49.760 ->
49.964 ms; slow-large-event 47.076 -> 47.114 ms. Adapter import heap remained
7.0 MiB; observed RSS was 58.3 -> 58.4 MiB. These single-run timings show small
variance, not a proven throughput improvement. The gain is compatibility coverage
and bounded diagnosis without additional upstream work or changed stream behavior.

A seven-round alternating microbenchmark of 20,000 synthetic requests per round
measured median metrics-only overhead of 0.514 -> 2.642 microseconds/request
(+2.128 microseconds). This is a small bounded diagnostic cost, not zero overhead
and not evidence of end-to-end speed improvement.

Timeline offsets describe adapter observation, not client display or a complete
latency decomposition. Stage durations can overlap; provider-call counts exclude
OAuth and low-level connection retries. Only the 20 latest finished requests are
retained, so older failure events may have no matching timeline. Data resets on
restart; this does not provide durable session recovery or decrypt opaque state.

## Publication

Publication and browser acceptance results are recorded after verification.
