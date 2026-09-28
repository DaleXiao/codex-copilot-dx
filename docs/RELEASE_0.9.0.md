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

Publication results will be recorded after GitHub and npm checks finish.
