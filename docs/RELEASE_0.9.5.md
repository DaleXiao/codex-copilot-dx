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

## Publication

- Release commit/tag: `6ba5873` / `v0.9.5`.
- GitHub CI passed on Node 22.15.0 and 24.x:
  https://github.com/DaleXiao/codex-copilot-dx/actions/runs/36675651675.
- GitHub Release: https://github.com/DaleXiao/codex-copilot-dx/releases/tag/v0.9.5.
- The one-shot npm workflow passed, including its required `prepublishOnly`
  verification:
  https://github.com/DaleXiao/codex-copilot-dx/actions/runs/36675776633.
  The official-registry receipt reports `codex-copilot-dx@0.9.5` with tag
  `latest`, 99 files, 259.4 kB, and SHA-1
  `2d5e39969f95db5ad79d970066ee8d362874ca55`, matching the local pack preflight.
- This machine's independent official-registry query returned `ENOTCONN`;
  the successful workflow receipt is the available publication evidence.
  Publication was not repeated.
