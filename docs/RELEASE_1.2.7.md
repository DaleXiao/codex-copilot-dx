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

The dependency lock changes only the package version; runtime dependencies and install hooks are unchanged. CI and publication receipts are added after remote delivery. The user's current running installation and enterprise registry/proxy/certificate settings remain untouched.
