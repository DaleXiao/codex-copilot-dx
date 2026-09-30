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

## Publication

- Release commit/tag: `8bf2817` / `v0.9.4`.
- GitHub CI passed on Node 22.15.0 and 24.x:
  https://github.com/DaleXiao/codex-copilot-dx/actions/runs/36667514578.
- GitHub Release: https://github.com/DaleXiao/codex-copilot-dx/releases/tag/v0.9.4.
- The one-shot npm publish workflow passed, including its required
  `prepublishOnly` verification:
  https://github.com/DaleXiao/codex-copilot-dx/actions/runs/36667621463.
  The official-registry receipt reports `codex-copilot-dx@0.9.4` with tag
  `latest`, 99 files, 259.2 kB, and SHA-1
  `32eea59847795e762f3df009400e9955b08302cb`, matching the local pack preflight.
- This machine's independent official-registry query returned `ENOTCONN`;
  the successful workflow receipt is the available npm publication evidence.
  Publication was not repeated.
