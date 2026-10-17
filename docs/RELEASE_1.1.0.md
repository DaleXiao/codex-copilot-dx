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
