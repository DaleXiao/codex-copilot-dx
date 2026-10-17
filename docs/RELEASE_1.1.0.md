# CCDX 1.1.0 — Shared entry and local control console

Date: 2026-10-17 (Asia/Shanghai). Baseline: 1.0.0 / `a955107`.
This report records the specific release verification environment, not a future
client/network guarantee or an upstream service SLA. Publication receipts follow
only after the immutable tag/package has been created.

## Resulting behavior

- Codex, Claude and WebUI share the main HTTP listener. Claude uses `/anthropic`;
  local socket/Host/Origin/key checks remain independent. Prediction retains its
  separate CONNECT/PAC transport and existing company fallback.
- Unmodified CCDX-owned 2027 client URLs migrate with their original restoration
  values intact. User-edited/managed routes are preserved. No permanent old-port
  listener or automatic cross-Provider fallback is introduced.
- The sidebar separates overview, client business, model services, shared usage
  and diagnostics, and operations/settings. Codex images, prediction and temporary
  conversation buffering are explicitly scoped to Codex.
- HTTP traffic, protocol-specific outcomes, Provider evidence and retained usage
  have distinct labels. Messages metrics are no longer labeled as all M365 traffic.
- Startup presents existing bounded checks and integration recovery; the default
  TTY then shows a fixed status/returned-usage region. Detailed output remains an
  explicit mode, independent of optional redacted file diagnostics.
- Interactive desktop startup opens WebUI once, with saved opt-out and
  `--no-browser`; headless/CI/SSH starts do not launch it. Failure is nonfatal.
- Settings apply animation live and pause configured image/prediction adaptation
  without deleting credentials, edit handles, trust or route. Actual output mode,
  environmental locks, first-time setup and client/service restart needs remain
  explicit. Existing CLI enable commands resume their paused gate.
- Provider disable refuses active M365 inference. Source changes affect later
  requests and keep existing request/history bindings. Buffer cleanup retains its
  active/pinned-data protection.
- Corrupt service preferences fail closed. Visible status polling reads bounded
  process-local metadata, while models and retained usage are view-scoped.
- No runtime dependency, install hook, browser framework or client binary patch
  is added. README, offline reference and architecture describe the new behavior.

## Verification

Local verification passed 1,357 tests with 9 platform-specific skips, including
quiet startup with independently retained file diagnostics, strict service settings,
and image pause/discovery/resume with retained editing handles. HTTP/idle-SSE smoke,
performance/resource gates and the 177-file pack manifest passed. Chromium/WebKit
passed all 16 bilingual/theme/viewport combinations, including persisted-source
readback and failed-directory recovery. The final output/environment-boundary
checks passed after the last small presentation correction.

The local configured registry lacked the test's default historical 0.9.41 baseline.
Using the verified published 1.0.0 tarball as the explicit baseline, actual isolated
installation/upgrade to 1.1.0 passed on darwin/arm64, including installed sharp and
Microsoft broker loads. Registry, download policy and user global installation
were preserved. The existing complete config/startup replay passed all ten modes.

Real Claude Code 2.1.299 completed Low/High synthetic calls through the actual
Provider runtime mounted on the main listener. The installed Codex CLI passed its
message-identity/continuation replay, including byte-exact local read/resume data.
CI/publication receipts are recorded after their checks complete. Local isolated real Claude Code and Codex replays use synthetic upstreams;
this does not establish real-tenant Windows M365 entitlement or native visible
prediction candidates. The user's running service/configuration is not silently
replaced during release validation.

## Cross-platform release gate

All **14/14** jobs passed in [CI 38993624345](https://github.com/DaleXiao/codex-copilot-dx/actions/runs/38993624345),
testing commit `73b99d737d5c219ec766ae0571609c88fd911eb8`. The gate includes
Node 22.15/24 on Linux/macOS/Windows, strict npm 12 installs/upgrades on all three
platforms, Windows launcher/native/network contracts, actual Chromium same-process
prediction/PAC recovery on all three platforms, native Codex/Claude CLI synthetic
replays, and Chromium/WebKit console behavior.

The first run (38993204099) passed 12 jobs; the new quiet-startup test incorrectly
expected a POSIX exit code after Windows terminateProcess. The isolated fixture
now triggers the same production shutdown handler cooperatively and has an
explicit timeout. Thirteen affected startup tests passed locally, followed by
the complete successful CI run. This test-only correction did not change the
177-file production package.

The package is **456,615 bytes**, SHA-256
`16e913f20f390e4d697a8d45899248c53e913db88f59df686054520f9623a4d3`.
There is no new runtime dependency or installation hook. The 1.0.0 artifact was
440,583 bytes; the additional console code/docs add 16,032 compressed bytes.
No lower model latency, universal corporate-mirror availability or real-tenant
Windows M365 access is claimed from synthetic tests. Claude App path-prefix
construction was checked read-only in installed 2.42304.0; the real CLI engine
was exercised, but this release validation did not change the user's App profile
or repeat the earlier real-App effort test. Native visible prediction candidates
remain unverified by these protocol/browser receipts.

## Publication

Published to npm `latest` by [workflow 38994103932](https://github.com/DaleXiao/codex-copilot-dx/actions/runs/38994103932).
Its published SHA-1 `a1d2a88bdca9b1350cf4eaf1d516b4360cfd4da9` matches the
verified 456,615-byte, 177-file artifact. The attached tarball has SHA-256
`16e913f20f390e4d697a8d45899248c53e913db88f59df686054520f9623a4d3`.

The configured local company mirror still reports 0.9.19. A direct npm-origin read
from this Mac failed with a disconnected socket; the successful official publishing
workflow and its matching artifact digest are the publication receipt. Neither
registry nor proxy/policy settings were changed. Use `ccdx update github` if the
configured mirror has not synchronized the version. Restart CCDX after upgrade;
Claude clients using the old 2027 address also need a normal relaunch to reload
the migrated configuration. Existing handwritten/managed routes stay preserved.

GitHub reports the matching SHA-256 for the uploaded asset. A fresh download
matched the same digest and exact 456,615-byte size. `main` records publication
receipts separately from the immutable `v1.1.0` tag at
`5ac0954aa14ce27c9d4420fef309efec0fddf3fc`.
