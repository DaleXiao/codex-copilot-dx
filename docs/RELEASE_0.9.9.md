# CCDX 0.9.9 verification report

Date: 2026-10-02. Baseline: `d7134bb` (0.9.8).

## Scope

- Add an English/Simplified Chinese button immediately right of the day/night
  button. Preserve English as the default and store the choice in the current
  browser only, independently of the existing appearance preference.
- Translate static copy, dynamic status, controls, chart tooltips and accessible
  labels. Retain usernames, model identifiers, numeric values, dates, animation
  names and upstream diagnostic text. Copied diagnostic fields stay unchanged.
- Translate existing nodes in place, preserving filters/date selection, chart
  node identity, expanded failure details, theme and unsaved animation choices.
  No reload, API refetch, polling, observer or timer is added for language changes.
- Serve one 12 kB local translation asset with the existing loopback/Host checks,
  CSP and metric exclusions. No dependency, remote service, authentication or
  inference-path work is added. An English UI remains usable if this asset cannot
  load. Narrow screens may wrap the additional control instead of overflowing.

## Verification

- Before changes, 22 targeted dashboard/theme/observability tests passed.
- New coverage checks default and persisted language, blocked storage, separate
  theme settings, theme/favicons, static translation coverage, dynamic and nested
  templates, literal markup/braces in data, and the button's requested position.
- Integration coverage confirms language switching makes no API calls, retains
  chart nodes and selected values, preserves open failure details and unsaved
  animation choices, does not replace the preview timer, and leaves copied
  diagnostic content in its original form. Asynchronous data and later refreshes
  use the current language.
- Review corrected template interpolation so unrecognized placeholders in raw
  diagnostic text are preserved instead of erased or read from object prototypes.

- One complete local `npm run verify` passed: 900 tests, offline HTTP smoke,
  performance/resource gates and package dry-run.
- Browser checks confirmed Chinese static/dynamic text, the language button's
  position, translated theme labels, account-name preservation, chart tooltips
  and raw diagnostic braces. Switching back/forth retained the selected model,
  date, open failure details and unsaved animation choice.
- Actual isolated-server counters were identical before and after two language
  changes: no extra API or asset requests occurred during switching.
- The bounded browser review found a total-row label overwritten by the selected
  model name during date drilldown. The row now retains TOTAL/合计; token/count
  values are unchanged. Added assertions cover this correction.
- After that correction, all 34 targeted language/UI/theme/observability/document
  tests passed. Browser reload retained Chinese, the corrected day/model total
  row displayed 合计, and All history restored the original aggregate table.
- Both English and Chinese had no page overflow at 320px and 390px. Dark/light
  modes, accessible theme labels and manual Refresh stayed functional; browser
  console inspection returned no errors or warnings.
- Initial CI passed Node 24 but the existing Node 22.15 compact timeout fixture
  failed: its 5ms deadline expired before the mocked upstream call, so the call
  count was 0 instead of 1. The compact test/production code were unchanged by
  this release. Its isolated local run passed, and the failed CI job passed on
  one bounded rerun of the unchanged release commit. No test was skipped, no
  assertion/deadline was relaxed, and the release tag was not moved. This
  scheduling-sensitive fixture remains a known test limitation.

This release improves language accessibility, not inference speed or upstream
model access. No broader analytics or authentication work was undertaken.

## Publication and cleanup

- Release commit/tag: `87fdf55` / `v0.9.9`.
- GitHub CI passed on Node 22.15 and 24 after the single failed-job rerun noted
  above: https://github.com/DaleXiao/codex-copilot-dx/actions/runs/37029038329.
- Public GitHub Release (not draft/prerelease):
  https://github.com/DaleXiao/codex-copilot-dx/releases/tag/v0.9.9.
- One npm publish workflow succeeded, including required prepublish checks:
  https://github.com/DaleXiao/codex-copilot-dx/actions/runs/37030282967.
  The official-registry receipt confirms `codex-copilot-dx@0.9.9`, tag
  `latest`, 101 files, 271.2 kB, SHA-1
  `db1db478e97fc3cc06752db1071ed90c573b6acb`, matching local preflight.
- The independent local registry lookup returned `ENOTCONN`; publication was
  not repeated. GitHub operations used the previously user-provided PAT.
- Removed the isolated browser tab, fixture server, temporary preview script
  and fixture settings directory; reset the viewport override. Preserved real
  credentials/settings, the active adapter, dependencies and unrelated files.
  A fixture screenshot remains outside the repository as a delivery artifact.
- A documentation-only evidence commit does not move the release tag or trigger
  another npm publication. Upgrade/restart CCDX and refresh the page to load
  the new local translation asset.
