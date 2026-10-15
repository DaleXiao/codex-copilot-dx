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
- Final local suite: 1,284 passed, nine Windows-only skips, zero failures.
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
- Windows then exposed a test-only dynamic-import path error: an absolute drive
  path must be converted with `pathToFileURL`. The replay now uses that portable
  Node API, without a Windows skip or a production dependency. Review also added
  a mixed-source credential regression: one denied source cannot hide another
  fully validated, unambiguous usable credential.
- The Windows browser reached the closed-proxy control, then exceeded the replay's
  2.5-second per-fetch abort while trying the two failed local endpoints. The
  synthetic fetch bound is now eight seconds and initial-fallback latency is
  recorded separately. The 15-second healthy-listener recovery deadline, two
  rounds, actual PAC-load assertion and route outcomes remain unchanged. This
  changes no production timeout and does not count a timeout as a pass.
- Cross-platform CI adds the real Chromium failure/recovery replay on Linux,
  Windows and macOS, separate from the existing installation, native worker,
  restricted-shell, protocol and dashboard matrix.

All fourteen jobs passed for source commit
`ae2dc8b043f802aca756f6dbfa3b3bfde2108238` in
[candidate CI](https://github.com/DaleXiao/codex-copilot-dx/actions/runs/38752585407).
This includes real full-Chromium repeated recovery with both fallback modes on
Windows/macOS/Linux, Node 22.15/24 protocol/native-platform checks, strict npm 12
real installation and upgrade on all three platforms, installed sharp, official
Codex synthetic-provider compatibility and the existing dashboard browser matrix.
The final source change after this CI is this unpacked audit report only.

## Native acceptance boundary

The installed App can cache failed prediction configuration for 300,000 ms.
Returning bridge traffic alone is not proof of visible native gray text. After
one-time migration, the user must verify fallback/recovery without quitting the
same App, then native suggestion display, adoption/sending, normal replies and
disabled predictions. No replacement UI or inference probe counts as this result.
The user requested GitHub/npm publication to perform this complete native test,
rather than installing the local candidate. CI must still pass before publishing.
See `PREDICTION_RECOVERY_FINDINGS.md` for the bounded initial experiments.

The initial local candidate had 153 files, 390,771 bytes, SHA-1
`265f106827f04e6bf4ac9807512dc51b024a5cbd`. It was not published.

The final package has 153 files, 390,799 bytes. Every packed file was compared
byte-for-byte against the source, and no experiment, test, private key, credential
material or dependency installation was bundled. SHA-1:
`85f47b5756bccdf9d20fab2ec24c63cd0e889657`. SHA-256:
`c3f78fa3771749e7eebf3f82445d1080a51f2d6109646c7dabd8b255f29647b3`.
This audit file is not packed, so publication receipts do not alter package bytes.
No publication success or full native acceptance is claimed before the receipts.

## Publication receipts and measured limits

- Tag `v0.9.40` points to `308b4a3e2100d12635602c613ff65c3e9de6f4b2`.
  Only the unpacked acceptance report differs from the all-green CI source.
- [npm publication](https://github.com/DaleXiao/codex-copilot-dx/actions/runs/38753787301)
  succeeded once, publishing `codex-copilot-dx@0.9.40` with tag `latest`. Its
  reported tarball SHA-1 exactly matches `85f47b5756bccdf9d20fab2ec24c63cd0e889657`.
- [GitHub stable release](https://github.com/DaleXiao/codex-copilot-dx/releases/tag/v0.9.40)
  is neither draft nor prerelease. Its 390,799-byte asset reports SHA-256
  `c3f78fa3771749e7eebf3f82445d1080a51f2d6109646c7dabd8b255f29647b3`,
  exactly matching the verified local artifact. GitHub and npm carry the same pack.
- GitHub used the exact, identity-verified historical PAT used for 0.9.39, only
  in memory. npm used the existing repository publishing secret. No browser
  authorization, substitute credential, persistent npm policy or registry change.

Successful Windows full-Chromium 151.0.7922.34 measurements:

| Mode | Initial fallback, round 1 / 2 | Healthy-listener recovery, round 1 / 2 |
| --- | --- | --- |
| Legacy control | 2,089 ms / not run | Remained on fallback during 2,113 ms observation |
| Revised direct fallback | 4,741 / 2,115 ms | 4,354 / 7,732 ms |
| Revised company fallback | 4,468 / 2,067 ms | 4,792 / 7,929 ms |

The extra cold-failure attempt costs about 2.4-2.7 seconds in this Windows
fixture; it is not a claim that every latency metric improved. The normal primary
is unchanged, but a real-account/native-UI performance or recovery guarantee
cannot be inferred from browser routing tests. The five-minute App config-cache
and next-eligible-turn caveats remain. The user requested this release for full
native acceptance with those evidence boundaries stated explicitly.

Cleanup is limited to this run's temporary packages/cache/logs/helpers and its
merged candidate branch. Existing `experiments/`, real credentials, configuration,
active services and installed dependencies are preserved. No post-publication
runtime/source change or tag movement is part of this receipt.
