# CCDX 0.9.5 verification report

Date: 2026-09-30. Baseline: `6e7a7a8` (0.9.4).

## Scope

- Fix the all-or-nothing cache hit rate display rule introduced in 0.9.4.
  Incomplete historical records no longer hide a computable ratio of
  recorded cached input tokens to recorded input tokens.
- Prefix partial-history rates with `~` in both `ccdx usage` and the dashboard,
  and explain the marker in the dashboard and README. Complete records still
  produce normal rates, including 0.0% for explicitly reported zero hits.
- Keep rates unavailable when usable totals are missing, input tokens are
  zero, or included token counts are invalid. Distinguish invalid counts from
  merely missing history instead of silently presenting bad data.
- Reuse the existing log pass and dashboard API. The fix does not rewrite
  usage logs or change model routing, streaming, images, caches, or limits.

## Verification

- Diagnosis confirmed the running adapter was 0.9.4. It returned null rates
  even though recorded input/cache totals could produce them. The local
  history contained 511 incomplete records and zero invalid records at the
  check; the overly strict completeness gate suppressed the totals.
- The fix was already reviewed and tested before this publication request.
  `npm run verify` passed: 875 tests, offline HTTP smoke, performance/resource
  gates, and npm package dry-run.
- Targeted coverage checks partial-history rates, malformed token counts,
  current/rotated logs, both CLI entrypoints, and dashboard percentages with
  `~`. Existing complete and zero-hit behavior is preserved.
- A temporary loopback service using the actual local usage summary returned
  HTTP 200 with computable partial rates. CLI rendering of the same real
  summary showed aggregate `~95.8%` and GPT-6.1 Sol `~98.3%`. The temporary
  service closed after verification; the active adapter was not restarted.
- Publication preparation reuses these completed checks, verifies version and
  documentation metadata, and lets the existing CI/npm workflows enforce
  their required release gates.

Partial rates describe recorded totals and cannot reconstruct omitted data.
The performance gates found no detected regression in their covered paths;
they do not establish a speed improvement or universal client behavior.
