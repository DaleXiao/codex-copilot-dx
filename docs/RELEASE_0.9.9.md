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

This release improves language accessibility, not inference speed or upstream
model access. No broader analytics or authentication work was undertaken.
