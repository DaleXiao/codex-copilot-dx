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

Publication results will be recorded after GitHub and npm checks finish.
