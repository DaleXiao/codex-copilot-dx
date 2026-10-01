# CCDX 0.9.7 verification report

Date: 2026-10-01. Baseline: `5ce8a2f` (0.9.6).

## Scope

- Show the saved GitHub Copilot username immediately left of the dashboard's
  Snapshot time, with numeric ID fallback and explicit missing/invalid/unknown
  or unavailable states. `SAVED` identifies local credentials, not online
  entitlement verification or the active inference identity.
- Reuse the local `ccdx auth status` reader. Identity metadata must match the
  saved token fingerprint; replacing the token hides stale identity metadata.
- A read-only dashboard endpoint projects only configured/valid flags, bounded
  identity fields and known reason codes. It shares existing loopback/Host/custom
  header gates, no-store responses and dashboard request-metric exclusions.
  Tokens, fingerprints, paths, raw metadata and exception text are not exposed.
- Load once per page and on top Refresh, independently of adapter status.
  No polling, upstream authentication, credential writes, client changes or
  inference-path authentication work are added. Optional image initialization,
  usage analytics and animation behavior remain unchanged.

## Verification

- Before edits, 37 targeted dashboard, observability and CLI auth tests passed.
- Added tests for CLI parity, missing/empty credentials, fingerprint mismatch,
  response field whitelist and identity bounds, credential-shaped identity
  suppression, generic errors, security/method gates before credential reads,
  request-metric exclusion, UI states, manual refresh, request deduplication and
  independent adapter success during slow/failed auth reads.
- Existing general runtime status still excludes usernames and credentials.

- Full `npm run verify`: 892 tests passed (5 more than 0.9.6), offline HTTP smoke,
  performance/resource gates and package dry-run passed.
- Review distinguished unreadable local credentials (`UNAVAILABLE`) from
  genuinely empty/invalid saved credentials (`INVALID`). Targeted tests cover
  this correction; review did not expand beyond the account display/API.
- An isolated adapter with a fixture account returned a 100-byte auth response.
  A 500-read local-file probe measured median 0.037ms and p95 0.046ms on this
  machine. This is a local warm-filesystem probe, not a universal I/O guarantee.
  Normal inference requests do not call the auth status reader, and opening the
  page adds one small same-origin request rather than upstream authentication.
- Browser checks confirm the account is on the same line to the left of Snapshot
  on desktop, both themes remain readable, and manual Refresh preserves adapter
  success. A 390px light-mode viewport had no page overflow; console inspection
  reported no errors or warnings. The real account, running adapter and
  credential files were untouched.
- After the unreadable-credential UI correction, 28 targeted API/UI/document
  tests passed. No further review/optimization loop was started.

Release gates found no detected regression in their covered paths; the
improvement is account visibility and explicit local-auth state, not a claim of
faster inference or freshly verified upstream access.

## Publication and cleanup

- Release commit/tag: `a9a1f1a` / `v0.9.7`.
- GitHub CI passed for the exact release commit:
  https://github.com/DaleXiao/codex-copilot-dx/actions/runs/36879328754.
- Public GitHub Release (not draft/prerelease):
  https://github.com/DaleXiao/codex-copilot-dx/releases/tag/v0.9.7.
- One npm publish workflow succeeded, including required prepublish checks:
  https://github.com/DaleXiao/codex-copilot-dx/actions/runs/36879650564.
  The official-registry receipt confirms `codex-copilot-dx@0.9.7`, tag
  `latest`, 100 files, 266.3 kB, SHA-1
  `81dcf01f8ea8b28e1c9e7ca98f4cecb1dda79d7b`, matching local preflight.
- The independent local registry lookup returned `ENOTCONN`; publication was
  not repeated. GitHub operations used the previously user-provided PAT.
- Removed the fixture browser tab, loopback test server, temporary preview
  script and fixture credential directory. Preserved real credentials/settings,
  the running adapter, dependencies and unrelated files. A header screenshot
  is retained outside the repository as a delivery artifact.
- A documentation-only evidence commit does not move the release tag or cause
  a second npm publication.
