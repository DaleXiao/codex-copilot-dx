# CCDX 0.9.4 verification report

Date: 2026-09-30. Baseline: `ecc8c27` (0.9.3).

## Scope

- Add upstream token cache hit rate to `ccdx usage` and the dashboard Usage
  table for each model and the aggregate: cached input tokens divided by
  input tokens. Aggregate rates are weighted by tokens, not request rates.
- Retain explicitly reported zero cache tokens in new Responses usage logs.
  Missing or invalid paired counts, including incomplete historical logs,
  produce an unknown rate (`—`); zero hits with positive input produce 0.0%.
- Keep the existing CLI token columns when the extra rate column would not
  fit, and display rates below the table. Preserve empty-state behavior and
  the existing plain-text token totals.
- Reuse the existing streamed usage-log summary and dashboard request. No
  additional log pass, provider request, background polling, or endpoint is
  needed. Existing routing, models, images, cache control, and limits are
  unchanged.

## Verification

- The implementation was already reviewed and tested before the publication
  request. Its final `npm run verify` passed: 875 tests, offline HTTP smoke,
  performance/resource gates, and npm package dry-run.
- Coverage includes token-weighted totals, explicit zero versus missing cache
  data, invalid counts, current/rotated log aggregation, both CLI entrypoints,
  narrow terminals, dashboard API rates, and percentage rendering.
- A real isolated loopback dashboard rendered the test fixture with aggregate
  26.7%, model 80.0%, and model 0.0%, matching CLI output. The preview server
  and browser tab were closed after the check.
- Publication preparation reuses that completed verification and checks the
  version, documentation links, diff cleanliness, and package metadata. The
  existing CI and npm workflow also enforce their required release gates.

Older logs that omit zero cache counts cannot be reconstructed accurately;
this release does not rewrite them. The performance gates found no detected
regression in their covered paths, not a claimed speed improvement.
