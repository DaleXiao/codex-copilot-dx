# CCDX 0.9.8 verification report

Date: 2026-10-01. Baseline: `d757986` (0.9.7).

## Scope and diagnosis

- Fix only the dashboard auth API's display filter: allow underscores in saved
  usernames so an available account name is not replaced by its numeric ID.
- Read-only diagnosis of the running 0.9.7 adapter confirmed local CLI metadata
  contained a username with an underscore while the dashboard API returned an
  empty login and the same numeric ID. Authentication itself was not changed.
- Preserve the 39-character limit, credential-shaped text suppression, token
  fingerprint binding, numeric ID fallback, local-only read semantics, endpoint
  security gates and text-only browser rendering. No new request, polling,
  identity lookup, credential write or inference-path work was added.

## Verification

- A new regression test first failed on 0.9.7: fingerprint-bound local metadata
  contained `dingxiao_microsoft`, but the API returned an empty login.
- Coverage checks the fixed underscore name, mixed-case/hyphen/underscore names,
  the 39-character boundary, rejection beyond that boundary, and suppression of
  GitHub PAT-shaped strings now matching the expanded character allowlist.
- Existing UI tests verify username priority over ID and retain saved/unknown/
  invalid/unavailable states and independent main-status refresh behavior.

- All 43 targeted auth/dashboard/observability tests passed after the fix.
- One complete local `npm run verify` passed: 893 tests, offline HTTP smoke,
  performance/resource gates and npm package dry-run.
- An isolated fixture adapter confirmed the CLI and dashboard API returned the
  same underscore-containing login. Browser verification showed
  `GitHub / @dingxiao_microsoft / SAVED`, retained it after Refresh, preserved its
  desktop placement left of Snapshot, and showed no page overflow at 390px.
  Both themes remained readable; the browser console had no errors/warnings.
- Review confirmed the only production change is one character in the display
  allowlist. No authentication, routing, streaming, image, analytics, polling or
  request-count behavior changed. Credential-shape suppression still executes
  after the expanded allowlist. No further optimization cycle was started.

The improvement is correct account-name visibility. Performance gates found no
detected regression in covered paths; this does not claim faster inference or
new upstream authorization. Real credentials and the active adapter were not
modified during verification.
