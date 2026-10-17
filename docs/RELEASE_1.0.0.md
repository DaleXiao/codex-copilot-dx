# CCDX 1.0.0 — Provider dashboard and Claude effort adaptation

Date: 2026-10-17 (Asia/Shanghai). Baseline: 0.10.1 / `8609883`.

Status: local candidate. Not published. Remote CI and publication require a normal
GitHub login with repository write/workflow access. The existing Codex service was not replaced. Claude App used a temporary duplicated
Profile for verification, followed by restoration of its original Profile.

## Resulting behavior

- Source-neutral Provider descriptors drive authorization, client rows, model tabs
  and source filters. Model browsing is independent of Codex routing.
- Authorization evidence, service readiness and actual client observations are
  separate. Saved GitHub credentials are not presented as an online access check.
- The model table includes upstream metadata beyond eligible client models;
  unavailable entries never become routes. Unknown capabilities remain unknown.
- Per-tab last-good snapshots survive failed refreshes; obsolete responses cannot
  cross tabs. Account/profile generations invalidate page caches. The existing
  visible-page timer remains 30 minutes; no server poller is added.
- Canonical Claude version IDs share exact M365 mappings with configuration and
  discovery. Existing raw IDs remain accepted. Alias collisions fail explicitly.
- App effort ceilings use advertised known levels, while exact request validation
  rejects absent efforts without a silent downgrade. Missing metadata leaves the
  upstream authoritative. Thinking signatures and native stream bytes are kept.
- Successful catalogs reconcile only unchanged owned client fields outside the
  inference serialization path. Owned legacy defaults migrate to matching IDs;
  user edits, managed policy, model ordering and preferences are preserved.
- Current and historical source IDs remain filterable. Mixed-source model totals
  and daily analytics remain distinct. Legacy untagged logs remain GitHub logs.
- Runtime resources and optional image capabilities have separate disclosures.
  Codex overview counters retain their scope; Claude counters are labeled separately.
- No new runtime dependency, client binary patch, authentication exception,
  automatic failover or installation hook is added. Version metadata moves to 1.0.0.

## Verification evidence

Baseline `npm run verify`: 1,327 passed, nine platform skips, zero failures.
The sandbox initially refused loopback listeners; the unchanged baseline passed
when run with loopback listening permitted. This was an environment failure.

Final local `npm run verify`: **1,341 passed, nine platform skips, zero failures**
(1,350 total tests). HTTP/idle-SSE, performance/resource and pack inspection passed.
The package contains 173 files; runtime dependency versions are unchanged.

- 13 same-input protocol differential scenarios against 0.10.1: identical output
  and upstream requests, with no live provider calls.
- Four interleaved paired synthetic Responses benchmark rounds per version:

| Median metric | 0.10.1 | Candidate |
| --- | ---: | ---: |
| Requests/s | 3,002.011 | 3,009.248 |
| P50 ms | 2.087 | 2.100 |
| P95 ms | 4.044 | 3.760 |
| Heap MiB | 19.590 | 19.579 |
| RSS MiB | 141.703 | 143.313 |

These bounded same-host results show comparable performance; they are not live
model latency, a cross-platform benchmark or a guarantee of improved throughput.
Existing performance/resource gates remain required.

- Actual temporary-prefix 0.10.1 package → 1.0.0 upgrade on macOS/arm64 passed:
  installed CLI version, native sharp and optional Microsoft broker loaded.
  The configured package mirror did not contain the script's historical 0.9.41
  baseline; an archived local 0.10.1 package was used without changing npm policy.
- Chromium 140: eight English/Chinese, dark/light, 420/1280 px cases passed,
  including independent Provider tabs, unavailable source isolation, refresh,
  source filtering and unsaved-state preservation. WebKit passed the same eight
  combinations: 16 real-browser cases in total.
- Official Claude Code 2.1.296, isolated HOME/config and synthetic upstream:
  low/high each produced one request with its exact effort and mapped M365 ID.
  No live provider call or tool execution occurred. Replay is added to CI.
- Managed macOS, live system SSO, isolated Profile and random loopback gateway:
  Opus 5.5 low/high each returned HTTP 200, the exact random marker and `end_turn`.
  Observed times were 2,376 ms and 1,275 ms; these are not a model-speed comparison.
  No existing service or client configuration was changed.

- Claude App 2.42304.0: duplicated the existing configuration, changed only the
  representative model to `claude-opus-5-5` / `maxEffort: max`, and used the normal
  App relaunch flow. The picker displayed Opus 5.5 with Low/Medium/High/Extra/Max.
  A temporary candidate gateway with an isolated Profile observed the App's actual
  `output_config.effort: high`; the App completed with `CCDX_APP_HIGH_OK`.
  No tool or workspace file operation was requested. The session was archived,
  both tested view preferences returned to Medium, and the original Profile was
  restored through normal App relaunch; the temporary Profile was removed. The
  restored old gateway initially returned `502 / read ENOTCONN` on its automatic
  health probe; one manual recheck cleared the banner. No network retry policy or
  existing service was changed. Client auxiliary/token-counting requests
  also occurred; the App test was not a single-call or latency benchmark.
- Full Chromium prediction replay read the PAC three times per mode and passed
  two same-process recovery rounds, including preservation of company fallback.
- Installed official Codex image replay passed generation, two edits, final-chat
  image Markdown, zero-call redisplay and saved-task resume with preserved handles.
  The image upstream was synthetic; no live image generation occurred.

## Bounded review

The review corrected background catalog/config synchronization, cache invalidity
flags in source-qualified usage totals, provider identity invalidation, legacy
owned defaults, in-flight first-read account changes, retained historical filter
options and explicit discovery failures on alias collisions. Regression
checks cover these paths. Documentation separates fresh evidence, cached metadata,
client configuration, upstream access and runtime outcomes.

## Remaining release gates and limitations

- Remote Linux/Windows/macOS CI has not run for this candidate. The existing matrix
  is retained; new Claude identity tests are added to Windows and native CLI replay
  to the Linux runtime job. This file must not be read as a remote CI receipt.
- Windows M365 enterprise-device authorization/App inference remains unverified
  for 1.0.0. Local macOS and synthetic cross-platform checks do not substitute for it.
- App model knowledge remains subject to the installed version and Anthropic's
  signed catalog availability/policy. `maxEffort` is a ceiling, not an arbitrary
  sparse allowlist. An offered option absent upstream fails explicitly. New
  protocol semantics can still require a client or adapter update.
- 0.10.x M365 limitations remain: eligible environment required, Standard only
  for Codex, five-minute prompt-cache retention, loopback-only Claude gateway and
  core-port priority. GitHub Fast, prediction and optional image behavior remain
  separately verified paths.

## Candidate package

- `codex-copilot-dx-1.0.0.tgz`: 173 files, 440,583 compressed bytes.
- SHA-256: `331b56cbe2404660de5b4b163a9338ce99fac158c815c941c4b8835823217f60`.
- The 0.10.1 receipt records 432,933 bytes: the candidate adds 7,650 bytes
  (about 1.8%). The existing optional broker download is unchanged. Native client
  replay/browser dependencies are test-only and are not in the published package.

## Upgrade and rollback

Once published, use `ccdx update github`, then restart CCDX separately. Existing
0.10.x commands, credentials and source selection remain compatible. Already-open
Claude clients may need a normal restart to read refreshed configuration.

Before rollback, stop the candidate and run its `ccdx m365 off` to restore only
unchanged owned client fields; inspect preserved-user-edit notices. Install the
verified 0.10.1 package/tag, restart separately, and explicitly re-enable M365 if
wanted. Account credentials, usage history and system SSO are not deleted.

No npm tag, GitHub release or public version has been changed by this candidate.
