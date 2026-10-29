# CCDX 1.3.0 candidate

Date: 2026-10-29. Base: 1.2.33 (`175e0b7`). This is a candidate report, not a publication receipt.

## Changes

- Classify each startup line independently. Ordinary source/client checks remain transient; warnings and device-code instructions remain visible.
- Show a clear Web UI address and one source/app summary. Display preserved configuration as `Unchanged`, without changing the stored state.
- Keep source-catalog columns stable when Model details opens. Place API-editor capability details beneath the selected model row.
- Keep the existing recorded-usage table/cache-hit display; label usage rows as Records and sanitize diagnostic labels.
- Use one public command grammar and the single `ccdx` executable. Remove old command roots/aliases; retain existing account, model, history and configuration formats.
- Support macOS and Windows only, x64/ARM64. Build four native packages and remove Linux jobs/positive platform cases and duplicate macOS verification jobs.
- Shorten README and reference material; update current command examples. Remove the unused old model-table formatter and obsolete command-shim tests.
- List further state work in `STATE_REFACTOR_PLAN.md`. No connection-state rewrite, image behavior change or prediction behavior change is included.

The minor version was explicitly selected by the maintainer. Removing command entrypoints and platform support is an intentional compatibility change. Existing scripts must use the current command tree.

## Local verification

- Full `npm run verify`: 1,666 tests, 1,656 passed, 10 skipped, no failures; streaming smoke, performance/resource budgets and package checks passed.
- Chromium source catalog: eight combinations of language, light/dark and narrow/desktop widths, including unchanged disclosure x coordinate and horizontal scroll position.
- API editor: Chromium and WebKit, narrow and desktop; inline details, capability save, source grants and recovery passed with synthetic data.
- xterm: 36 combinations, 200 frames per combination; cursor/resize, color/plain output and bounded live region passed.
- Isolated package upgrade from verified 1.2.33: installed CLI, sharp and supported native broker loaded. Mac ARM64 complete package passed empty-cache offline installation.

Native CI and final candidate artifacts are recorded separately after completion. No live model inference or current-client restart was used for these tests. The observed local service remained 1.2.33; the candidate was not installed globally.

## GitHub Release cleanup

Deleted exactly 24 Release records and their assets: the 22 existing releases below 1.2.0, plus 1.2.17 and 1.2.20. A fresh API listing matched the planned IDs, with no unexpected deletion. All other 1.2 releases, including 1.2.33, remained. Git tags, commits and npm versions were not deleted.

## Remaining boundaries

- Windows native behavior requires the Windows CI jobs; local macOS checks are not a substitute.
- Further state refactoring is a proposal and needs its own behavior-preservation checks.
- No version tag, npm publication, production merge or local service switch is part of candidate preparation.
