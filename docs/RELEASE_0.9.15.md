# CCDX 0.9.15 verification report

Date: 2026-10-08. Baseline: `fec8a90` (0.9.14).

## Scope

- Use one typography rule for peer card/panel titles, including recent request
  context and usage analytics: the existing monospace family, 11px, weight 700,
  heading color and letter spacing. Keep metric, data and annotation hierarchy.
- Replace native disclosure triangles with a shared CSS `+` / `−` indicator in
  context, analytics, animation and dynamically rendered failure details.
  Keep native details/summary semantics, focus, keyboard toggling and lazy loading.
- Preserve existing terminal layout, spacing, themes, translations and responsive
  breakpoints. Animation status remains at the right edge; long failure labels
  wrap in their own column. No API, JavaScript, inference, image or auth changes.

## Verification

- Clean 0.9.14 baseline: all 949 tests, offline HTTP smoke, idle SSE replay,
  performance/resource gates and npm package preflight passed before edits.
- Final `npm run verify`: all 951 tests passed, including two new style contract
  checks. Existing HTTP smoke, SSE idle replay, performance/resource gates and
  package preflight passed. Isolated startup replay also passed, including
  image-disabled and optional-image-conflict paths.
- Browser acceptance used an isolated adapter with synthetic data, independent
  settings and no upstream calls. Computed styles confirmed all peer titles share
  11px / 700 / 0.88px letter spacing / 17.6px line height and theme heading color.
- Context, analytics, animation and failure disclosures correctly show `+` when
  closed and `−` when open. Enter/Space toggling and 2px keyboard focus passed.
  Language switching preserved open sections and long failure labels wrapped.
- English/Chinese, light/dark, 320/390px and desktop checks passed with no whole
  page horizontal overflow or browser warning/error logs. Tables retain their
  own overflow container. Animation status stays separate when its title wraps.
  The fixture tab/server were closed and temporary viewport overrides reset.
  A synthetic-data screenshot is retained outside the repository.

## Performance and bounded review

- Production changes are CSS only. No additional JavaScript, DOM nodes, timers,
  network requests, dependencies, inference work or configuration writes.
- Baseline/candidate native stream parse/copy/write/drain, cancellation, content
  and backpressure invariants were identical. Import heap remained 7 MiB;
  duplicate-image optimization and large tool-output parsing remained one call.
  Both performance gates passed; absolute timing noise is not a speedup claim.
- One scoped browser review found the animation header's existing flex selector
  could override the shared disclosure grid. An explicit grid rule corrected
  that conflict; targeted checks and one final complete gate passed afterward.
  No unrelated redesign or repeated review/optimization expansion was performed.
- Existing metric/data/annotation sizes remain intentional; consistent typography
  means equal roles share styles, not flattening every value to the same size.
  `git diff --check` passed.

## Publication

- Application commit/tag: `3f1d712db68698f784ae0766f4c5a26bfeec6c81` /
  `v0.9.15`. Report-only updates do not move the tag or change npm package bytes.
- GitHub CI passed on Node 22.15 and 24:
  https://github.com/DaleXiao/codex-copilot-dx/actions/runs/37729763243.
- Formal GitHub Release, neither draft nor prerelease:
  https://github.com/DaleXiao/codex-copilot-dx/releases/tag/v0.9.15.
- Exactly one npm publish workflow succeeded, including prepublish gates:
  https://github.com/DaleXiao/codex-copilot-dx/actions/runs/37729894202.
  Official receipt confirms `codex-copilot-dx@0.9.15`, `latest`, 105 files and
  SHA-1 `e2138685acf6def43083ccee9403f3960273b89d`, matching local preflight's
  284,362-byte package.
- GitHub used the previously supplied, verified DaleXiao PAT without printing
  or persisting its value; npm used the existing repository NPM_TOKEN. A single
  independent official-registry query returned ENOTCONN. The successful official
  publish receipt and matching hash are separate evidence; publishing was not
  repeated in response to that read failure.

## Cleanup

Cleanup is limited to owned temporary fixture/settings, release helper, logs and
npm query cache. Preserve dependencies, real settings/credentials, the active
adapter and useful report/screenshot evidence. Final handoff checks require a
clean checkout, no untracked workspace garbage and synchronization with remote main.
