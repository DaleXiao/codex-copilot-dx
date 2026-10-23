# CCDX 1.2.12

This patch corrects request-flow labels and geometry and aligns the approved
account shortcuts and toolbar controls. Existing palettes, light/dark modes,
language choices, atom logo, status icons and tables retain their roles. CLI stays
English. Runtime dependencies and provider, routing and account-selection policies
are unchanged.

## Changes

- A single app/source-model route stays straight, including several concurrent
  requests sharing that route. Only branches use rounded curves. Name anchors are
  measured from rendered buttons; source headings no longer offset model rows.
- Known singleton and idle-zero node counts are hidden. Concurrent counts read
  “2 requests” beside names and outside their selected area; narrow layouts place
  them below. Omitted details retain lower bounds, missing/stale counts retain
  dashes, and the exact active total appears once in the flow header. Source
  summaries, active details, finished requests and issues keep their existing scope.
- Application labels recognize the actual `Codex Desktop` originator spelling,
  known App/CLI aliases and bounded, versioned Codex User-Agent prefixes. Generic
  Codex hints identify only the family. Unknown clients read Unidentified app;
  unmarked Claude requests remain unspecified. These hints are presentation data,
  not trusted identity or routing input. Raw hint/header text is not retained.
- Checks & repairs has equal-height GitHub account / M365 account shortcuts.
  Both navigate to their source page without silently checking credentials or
  enumerating accounts. The M365 shortcut keeps link semantics and button styling.
- Auto refresh fits its localized content and reserves the longer on/off label's
  width. The language control cannot shrink or wrap 中文. Compact toolbars wrap
  controls when needed; module changes do not move the shared header.
- README, reference, architecture, copy inventory and bootstrap targets match
  1.2.12. No additional upstream code or routing framework is imported in this patch;
  the 1.2.11 request-flow controller is refined in place.

## Verification

Local `npm run verify` passed **1,471 tests: 1,462 passed, nine platform/optional
skips, zero failures**, plus HTTP smoke, SSE idle, performance/resource and pack
checks. Chromium/WebKit passed **48** combinations of language, palette, light/dark
mode and viewport. Four additional 360px/1280px toolbar/flow cases passed. These
checks make zero real provider calls and cover straight/shared/branched routes,
count scope, selection, stale reads, reduced motion, existing tables, account
navigation, one-line language labels and stable toolbar widths.

The installed official Codex **0.163.0-alpha.11.1** app-server emitted real HTTP
requests to an isolated synthetic adapter for `Codex Desktop`, `codex_cli_rs` and
`codex` client names. All nine turns and retained application labels passed, along
with existing reasoning-header and compaction comparisons. This verifies emitted
client headers and adapter metadata, not a restarted live desktop session.

An isolated **1.2.11 → 1.2.12** npm upgrade loaded sharp and the supported Microsoft
broker on macOS arm64. Baseline tarball SHA-256:
`422207f6cb1f7c0dcad1686573f691506b6d4f4f66531cc5d464db4960b59799`.
No-Git/missing-Node bootstrap, installed commands, corrupt-download retention,
isolated startup and configured CONNECT proxy/private-CA downloads passed locally.
TLS remained strict; company registry, proxy, certificates and shell policy were
preserved.

Three alternating held-stream runs per version covered 16/64/128 concurrency and
returned active work to zero. At 128 streams, status-P95 medians were **2.268 ms**
for 1.2.11 and **1.540 ms** for this candidate; maximum sampled RSS was
**114.11 / 114.34 MiB**. Existing performance/resource budgets pass. These bounded
synthetic observations do not prove a universal speedup or real-model latency.

The release tarball contains **200 files / 546,475 compressed bytes**. All packed
file contents matched the checkout. SHA-256:
`36db307730edce6dac811bc99c5cafa9550777c5c68aa3b182679124dd0b5ab3`.

Platform CI, package byte checks, npm publication and fresh GitHub asset receipts
are recorded on [GitHub v1.2.12](https://github.com/DaleXiao/codex-copilot-dx/releases/tag/v1.2.12).
Company mirror synchronization is checked separately from public publication.

Post-release verification on main exposed a pre-existing test fixture that also
gave the successful recovery request a 5ms handshake deadline. The fixture now
keeps 5ms for the deliberately stalled first request and allows 1,000ms for the
successful second request. Timeout, no-replay and reduced-image assertions remain.
This test-only correction is on main; the published tag and package are unchanged.
