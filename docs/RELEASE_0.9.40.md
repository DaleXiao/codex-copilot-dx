# CCDX 0.9.40: prediction retry routing and credential preservation

Date: 2026-10-15. Baseline: 0.9.39 / `ab9e294`.

## Scope and boundaries

- Native prediction's stable `/proxy.pac?v=2` adds a changing `.localhost`
  secondary after the existing fixed-loopback primary. Both use the saved port.
  Healthy traffic retains the primary; original direct/static/company-PAC fallback
  follows the local entries unchanged. The same pure builder serves all three
  modes. There is no new runtime dependency, listener, daemon, Node DNS lookup,
  polling timer, client program change, system trust or global proxy mutation.
- The optional bridge begins concurrently with authentication/model setup, so
  a slow Windows PAC worker cannot delay core listener startup. Existing lifecycle
  ownership, serialized close/repair, same-port recovery budget and rollback remain.
- The versioned format URL is not tied to package versions. The user accepted
  one normal App quit for migration; later adapters retain it. Open profiles are
  not edited or forcibly restarted. Legacy bindings remain recognizable for
  diagnostics/ownership/rollback and are not mistaken for the revised binding.
- Default-store Copilot 403 preserves the saved GitHub credential without
  deletion/login guidance. A failed 401 recovery separately checks GitHub identity
  with a four-second bound. Only a GitHub identity 401 permits reauthorization
  guidance. A failed identity check does not establish token expiry. Discovery
  blocked by 403 does not open another Device Flow. Successful startup/token-cache
  paths gain no validation requests; denials cannot hide behind a cached token.
  Isolated/custom client recovery contracts remain unchanged.
- README, reference and architecture describe the actual migration, company
  policy preservation and cache limits. No model, Fast tier, Auto-review, history,
  image API/MCP/skill, dashboard, install policy or Windows command-entry change.

## Bounded verification and review

- Baseline: 1,272 passed, nine Windows-only skips, zero failures.
- Reviewed candidate: 1,283 passed, nine Windows-only skips, zero failures.
- Existing offline HTTP/SSE, performance/resource and package-content gates pass.
  Actual isolated CLI startup/reuse replay passes its nine scenarios, including
  disabled images, optional failures, config preservation and shutdown.
- Real Chrome 155.0.8059.40, same process during each pair of failures: direct
  fallback recovers in 7,722 / 10,009 ms; synthetic company-proxy fallback recovers
  in 9,275 / 10,002 ms. The legacy control remains on fallback during its 2,052 ms
  observation window. These are route measurements, not native UI success or a
  core-inference speedup. The replay uses loopback-only synthetic HTTP responses
  and fresh browser profiles, with no account or public provider traffic.
- Focused review retained custom isolated auth contracts, corrected invalid-port
  validation without throwing, preserved existing WebSocket routing, and moved
  early prediction startup to background work so company routing cannot serialize
  core setup. Regression checks cover the revised PAC allowlist, one-time closed-
  profile migration and original-route rollback, exact launch arguments, bounded
  credential checks and no login after policy denial.
- Initial browser CI used Playwright's standalone headless shell, which did not
  fetch the PAC at all (`pacReads: 0`). The replay now explicitly selects the full
  Chromium channel and asserts that a PAC was loaded before accepting even the
  legacy control. Recovery assertions are unchanged; this is not a production
  routing workaround or a waived test.
- Cross-platform CI adds the real Chromium failure/recovery replay on Linux,
  Windows and macOS, separate from the existing installation, native worker,
  restricted-shell, protocol and dashboard matrix. Results are pending below.

## Native acceptance boundary

The installed App can cache failed prediction configuration for 300,000 ms.
Returning bridge traffic alone is not proof of visible native gray text. After
one-time migration, the user must verify fallback/recovery without quitting the
same App, then native suggestion display, adoption/sending, normal replies and
disabled predictions. No replacement UI or inference probe counts as this result.
The user requested GitHub/npm publication to perform this complete native test,
rather than installing the local candidate. CI must still pass before publishing.
See `PREDICTION_RECOVERY_FINDINGS.md` for the bounded initial experiments.

Candidate package: 153 files, 390,771 bytes; SHA-1
`265f106827f04e6bf4ac9807512dc51b024a5cbd`. It is a local test artifact, not an npm
or GitHub release. No publication success or full native acceptance is claimed.
