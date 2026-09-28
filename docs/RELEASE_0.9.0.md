# CCDX 0.9.0 verification report

Date: 2026-09-28. Baseline: `f1552e4` (0.8.11).

## Scope

- Add `ccdx limits`, `ccdx limits --decoded <128–512|default>`, and the `-256`
  short form. The command shows configured versus running limits and saves a
  decoded request-body limit for the next adapter start.
- Preserve the 128 MiB default, the independent 64 MiB raw-body limit, and
  `CCDX_MAX_DECODED_BODY_BYTES` environment precedence. No automatic restart,
  live admission mutation, history clearing, or provider request is added.
- Runtime admission and loopback status read the same effective saved limit at
  startup. Invalid saved values fall back safely; writes fail without changing
  unrelated settings.

## Verification

- Baseline `npm run verify` passed: 854 tests, offline HTTP smoke, benchmark
  gates, and npm package dry-run.
- Focused tests cover CLI parsing, bounds, persistence, environment precedence,
  offline and running status, and a fresh-process admission boundary without
  allocating a large body.
- `npm run verify` passed: 862 tests, offline HTTP smoke, benchmark gates, and
  npm package dry-run. The package has 99 files, size 257,752 bytes, SHA-1
  `41591949e2ced734c77bed591dd6a1af34d7080f`.
- The isolated configuration startup replay passed all existing image/core
  scenarios with zero real provider calls.

The benchmark gates confirm no detected regression on existing probes, not a
claimed speed gain. The saved limit is read at process startup, not per request.

## Publication

- Release commit/tag: `bfad1e5` / `v0.9.0`.
- GitHub CI passed on Node 22.15.0 and 24.x, including configuration startup
  replay: https://github.com/DaleXiao/codex-copilot-dx/actions/runs/36400201303.
- GitHub Release: https://github.com/DaleXiao/codex-copilot-dx/releases/tag/v0.9.0.
- The one-shot npm workflow passed, including `prepublishOnly` verification:
  https://github.com/DaleXiao/codex-copilot-dx/actions/runs/36400387064.
- npm accepted `codex-copilot-dx@0.9.0` under `latest`. The publish receipt's
  SHA-1 `41591949e2ced734c77bed591dd6a1af34d7080f`, 99 files, and 257.8 kB
  package match the local dry-run. Publication was not repeated.
- The configured Microsoft npm mirror still returned 404 immediately after
  publication; the official-registry publish receipt is the available
  publication evidence, not an independent download check from this machine.
