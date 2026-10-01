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

## Publication and cleanup

- Release commit/tag: `c5926ed` / `v0.9.8`.
- GitHub CI passed for this exact commit:
  https://github.com/DaleXiao/codex-copilot-dx/actions/runs/36881988149.
- Public GitHub Release (not draft/prerelease):
  https://github.com/DaleXiao/codex-copilot-dx/releases/tag/v0.9.8.
- One npm publish workflow succeeded, including required prepublish checks:
  https://github.com/DaleXiao/codex-copilot-dx/actions/runs/36882269632.
  The official-registry receipt confirms `codex-copilot-dx@0.9.8`, tag
  `latest`, 100 files, 266.4 kB, SHA-1
  `5be87172c5e2f59f7312a588de1afaa8a1251b9d`, matching local preflight.
- The independent local registry lookup returned `ENOTCONN`; publication was
  not repeated. GitHub operations used the previously user-provided PAT.
- Removed the fixture browser tab, loopback test server, temporary preview
  script and fixture credential directory. Preserved real credentials/settings,
  the active adapter, dependencies and unrelated files. A fixture screenshot
  remains outside the repository as a delivery artifact.
- A documentation-only evidence commit does not move the release tag or cause
  a second npm publication. Upgrade/restart CCDX and refresh the page to use
  the new display filter; no re-login or token replacement is required.
