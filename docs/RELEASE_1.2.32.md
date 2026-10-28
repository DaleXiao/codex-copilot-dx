# CCDX 1.2.32

## Changes

- Request-flow applications, counts and statuses share a right edge; source/model
  nodes keep their left edge. Mixed request counts use consistent wire anchors.
  Narrow screens retain the below-name counts, aligned to the application text.
- Chinese WebUI text has explicit sans-serif system fallbacks, including Microsoft
  YaHei on Windows. Latin monospace styling remains. Controls inherit the family;
  code and terminal samples use the same stack. No font downloads or dependencies.
- Settings adds the WebUI-only **Pure white** palette: pure white with black text
  and icons in light mode, inverted black in dark mode, with grayscale supporting
  tokens. Alerts keep their labels/icons. Existing persistence, cross-tab updates,
  automatic/manual save and pre-reset backup/restore include the new palette.
  The default green palette and independent terminal palettes remain.
- No changes to provider routing, model identity, credentials or client sync.
  Verification and publication leave the active local service untouched.

## Verification

- Candidate `70b42fa7d80dc4d0161135d9b542d461ff761a58` passed
  [CI 40659971009](https://github.com/DaleXiao/codex-copilot-dx/actions/runs/40659971009): **25/25 jobs**.
- Local `npm run verify`: 1,673 tests, 1,663 passed, 10 skipped, no failures;
  streaming smoke, performance/resource budgets and package-content checks passed.
- Actual Chromium/WebKit: 64 dashboard combinations, four Pure white connection
  flows and four disclosure cases passed. Theme save/reload, cross-tab behavior,
  reset/restore, contrast and mixed-count flow alignment remain covered.
- Native Windows Edge: 16 combinations passed; CDP confirmed Chinese glyphs use
  Microsoft YaHei. Test tooling loads Windows paths using portable file URLs.
- CI retains official native Codex sign-in, complete first catalog and old-session
  protections, Claude protocol/capability replay, strict npm 12 and eight native
  complete-package install/rollback gates. These are isolated synthetic-provider
  checks, not a claim that every real account or desktop App was exercised.
- Isolated verified 1.2.31 -> 1.2.32 installation, native sharp/broker loading and
  normal/plain/narrow/resize terminal replay passed. No real-provider inference.
- Standard archive: 686,036 bytes, SHA256
  `4b694e6da93d970aeac312875186162e688ce4eeebcbfe13703d1d3481e9e343`.

Publication and independent public npm/asset receipts are linked from the
[GitHub Release](https://github.com/DaleXiao/codex-copilot-dx/releases/tag/v1.2.32).
The release tag updates only this receipt relative to the tested runtime tree.
The active local service remains untouched; upgrade/restart after running tasks
finish. No provider, model or client configuration needs to be saved again.
