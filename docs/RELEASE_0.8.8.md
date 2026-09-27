# CCDX 0.8.8 verification report

Date: 2026-09-27. Baseline: `2cf138e` (0.8.7).

## Scope

- Add a loopback-only terminal-style dashboard at the adapter root URL. It
  reuses the existing listener and does not auto-open a browser.
- Add the existing nine terminal animation themes to the dashboard. Selection
  uses the existing settings writer, preserves unrelated settings, and takes
  effect on the next adapter start. A disabled environment override remains
  authoritative. Only the selected preview animates while visible; reduced
  motion and hidden pages use static frames.
- Add a live upstream GPT model table using the existing `ccdx models` lookup
  semantics. It never shows last-known-good data as a successful live lookup.
- Add a bounded by-model Usage table from local usage metadata, without prompt,
  response-body, response-ID, credential, or log-path fields.

Dashboard requests are excluded from existing inference counters. The normal
Responses, compaction, model picker, image, retry, and history routes are
unchanged. Dashboard reads do not initialize the optional image handler.
Loopback and Host checks protect all dashboard routes; data endpoints reject
cross-site simple requests, and animation writes require a matching Origin.

## Verification

- `npm run verify` passed: 851 unit tests, offline HTTP smoke, performance/
  resource checks, and npm package dry-run.
- Dashboard tests cover loopback and Host checks, same-origin writes, rejection
  of cross-site simple GETs before live or log work, invalid animation choices,
  preservation of unrelated settings, environment-disabled animation, live
  lookup failures without cached success, bounded metadata-only usage rows,
  and unchanged inference counters.
- Nine isolated startup/reuse scenarios passed with zero real provider calls.
  Disabled image profiles issued zero image requests, and image failures did
  not block core Responses.
- A browser preview verified the terminal layout, live-model and Usage tables,
  and an animation selection/save round trip using an isolated settings home.
  A separate read-only live model-directory lookup succeeded without inference.
- The local package dry-run contains 97 files and has SHA-1
  `57948bd6482151ec6a90664d9581ccd650ce187f`.

These checks confirm the existing benchmark gates, not a claimed speed gain.
The dashboard adds no background polling or default-route provider calls.

## Publication

Pending successful CI, GitHub Release, and one-shot npm workflow.
