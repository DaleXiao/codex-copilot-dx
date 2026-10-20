# CCDX 1.2.7

This report describes the 1.2.7 release and its bounded verification environment. It is historical evidence, not a guarantee of every upstream provider, corporate account or physical device.

## Changes

- Adds explicit GitHub login, reauth, connection check and CCDX-only logout tools, shared by CLI and WebUI. Candidates are verified before an atomic save; cancellation, account mismatch and concurrent changes preserve the prior credential. Explicit tools use an owned store with legacy compatibility; logout never deletes other apps' credentials. The running token cache retains its account binding.
- Groups source account tools and catalogs under the same browsing tabs, preserves independent Microsoft 365 account controls, and adds Checks & repairs with local diagnostics, revision-bound config preview/backup, network summaries and redacted reports. Model compatibility remains a clearly disclosed explicit CLI inference test.
- Adds management-only `ccdx web`, source-switch alias and non-destructive image/prediction pause/resume commands. Full setup/removal, company policy, routing and existing installation channels remain independent.
- Uses local circle-play, circle-check, circle-alert and circle-minus SVGs with localized status text. Existing green/Klein, dark/light, sidebar, logo, charts, animation and reduced-motion behavior remain in place. No runtime dependency or install hook was added.

## Verification

Validation uses isolated homes and synthetic services; no real inference request is used. Focused tests cover candidate failure/cancellation, same-account enforcement, concurrent changes, owned logout without legacy fallback, independent identity/access/catalog failures, protected APIs, configuration backup and stale-preview rejection, report redaction and management startup without app writes.

The first full local invocation could not open loopback listeners inside the restricted shell. It was rerun with local-listener permission. A later documentation pass caught a missing release-report link and the quick-start's line-budget limit; both were fixed without relaxing the checks. Browser assertions were updated for the new eighth navigation icon. Manual visual review corrected inherited heading colors; repair results now replace pre-repair warnings and refresh the exported local snapshot. Verification remains a finite release pass, not an open-ended optimization cycle.

Final local `npm run verify` passed: **1,443 tests, 1,434 passed, 9 platform/optional skips, zero failures**; offline HTTP smoke, SSE idle replay, performance/resource gates and package-manifest checks passed. Focused tests also verify management startup without app writes and distinguish an actual GitHub identity rejection from a Copilot permission denial.

Chromium and WebKit passed all **32 cases**: English/Chinese, green/Klein, light/dark and 420/1280px. Checks cover saved/invalid sign-in, denial without reauth guidance, device-flow display/cancellation, source-specific account controls, repair preview/result updates, existing charts, settings, retained catalogs and reduced motion. Xterm passed **24** palette/color/size cases, including 200 frames and resize. All provider interactions in these tests are synthetic; real model calls remain zero.

The isolated **1.2.6 → 1.2.7** package upgrade retained the configured company registry and loaded installed sharp and the supported native broker on macOS arm64. The proxy/CA replay retained strict TLS, offline mode and npm policy without automatic retries or registry credentials. Synthetic held-stream replay passed 16/64/128 concurrency with active work returning to zero; status P95 at 128 streams was **1.493 ms** on this host. Timing varies with host/load and is not an upstream SLA.

The dependency lock changes only the package version; runtime dependencies and install hooks are unchanged. The pack contains **193 files / 524616 bytes**, 18712 bytes more than 1.2.6. Tarball SHA-256: `3b0167d33132286a5067ae9a9d962abdaa5740be71242ec5b691eac3bbb32d68`.

## Published delivery

- [CI 39457869168](https://github.com/DaleXiao/codex-copilot-dx/actions/runs/39457869168) passed **17/17 jobs** at release source/tag `42215d0ab0171781122bd19eee8545ef1642bc74`: Windows/macOS/Linux, Node 22.15/24, strict npm 12 installs/upgrades, no-Git/no-Node bootstrap, Windows updater/prediction, official-client synthetic replays, Chromium/WebKit and terminal behavior.
- [npm 1.2.7](https://www.npmjs.com/package/codex-copilot-dx/v/1.2.7) was published through [workflow 39458934016](https://github.com/DaleXiao/codex-copilot-dx/actions/runs/39458934016). Its immutable-tag job reran the complete release gate. Published tarball SHA-1 `0bfbed9693f63eb450dfd9d22402765c31246174` matches the locally verified artifact; publication succeeded with the `latest` tag.
- [GitHub v1.2.7](https://github.com/DaleXiao/codex-copilot-dx/releases/tag/v1.2.7) was published at `2026-10-20T16:40:25Z`. All five assets were downloaded fresh and matched local bytes, GitHub API SHA-256 digests and SHA256SUMS.
- The configured company registry returned E404 for 1.2.7 after publication; mirror synchronization is unconfirmed. The GitHub Release channel is available; dependencies still use the configured registry.

The user's running installation and enterprise registry/proxy/certificate settings are preserved. This receipt follow-up changes only this report; the tag and published bytes remain unchanged. Temporary test tools, private browser engines and credential helper scripts are removed after delivery; artifacts and verification receipts remain outside the checkout. No physical enterprise account's entitlement or real model inference is claimed by these synthetic checks.
