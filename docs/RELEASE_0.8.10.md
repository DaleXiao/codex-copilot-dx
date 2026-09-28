# CCDX 0.8.10 verification report

Date: 2026-09-28. Baseline: `c0f617f` (0.8.9).

## Scope

- Remove the theme toggle's resting border and background while retaining its
  keyboard focus indicator and hover feedback.
- Size the toggle to align with Refresh and replace the thin moon outline with
  a fuller filled crescent. No request, settings, or theme-selection logic
  changes.

## Verification

- Both dashboard themes were inspected in a browser. The resting toggle has no
  frame, and the light-mode moon is visibly filled.
- `npm run verify` passed: 854 tests, offline HTTP smoke, benchmark gates, and
  package dry-run. The package has 98 files, size 256,009 bytes, and SHA-1
  `23878363e5f7966216a78d94ff6495ac2629b2ae`.

## Publication

- Release commit/tag: `50c9ed7` / `v0.8.10`.
- GitHub CI passed on Node 22.15.0 and 24.x, including configuration startup
  replay: https://github.com/DaleXiao/codex-copilot-dx/actions/runs/36380707297.
- GitHub Release: https://github.com/DaleXiao/codex-copilot-dx/releases/tag/v0.8.10.
- The one-shot npm workflow passed, including `prepublishOnly` verification:
  https://github.com/DaleXiao/codex-copilot-dx/actions/runs/36380843033.
- npm accepted `codex-copilot-dx@0.8.10` under `latest`. The publish receipt's
  SHA-1 `23878363e5f7966216a78d94ff6495ac2629b2ae`, 98 files, and 256.0 kB
  package match the local dry-run. Publication was not repeated.
- The configured Microsoft npm mirror still returned 404 immediately after
  publication; the successful official-registry publish receipt is the
  available evidence, not an independent download check from this machine.
