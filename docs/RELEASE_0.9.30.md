# CCDX 0.9.30: stable native prediction routes

This report is historical evidence for this release, not a guarantee for every
future Codex build, company network or composer state.

## Scope and cause

A real macOS upgrade left Codex using a previously allocated prediction PAC
port, while the restarted 0.9.29 bridge listened on a different port. The old
address refused connections and the new bridge observed no configuration
requests. The saved preference was still on. The macOS launcher had reported
successful `open` execution without checking the active App's arguments.

## Changes and preserved behavior

- Reuse the existing Windows first-start port persistence on macOS too. Commit
  only after listening, under the existing settings lock; concurrent preference
  changes close the uncommitted bridge. Later starts preserve settings bytes.
- Keep a busy saved port and its occupant unchanged. Report the conflict and
  skip only the optional prediction bridge, never steal the port or select
  another route silently.
- Inspect only exact macOS App main processes with bounded system `ps` calls.
  Complete arguments are never returned or logged. Matching running Apps are
  reused; old, missing, ambiguous or unreadable routes are not reported as
  connected. Newly opened Apps receive bounded route verification, not a watcher.
- Correct stale CLI help about Windows OpenSSL and automatic-proxy support;
  keep README, reference and architecture aligned with current implementation.
- No new dependency, system trust, client-file patch, forced App exit, permanent
  process watcher or change to inference, Fast, Auto-review, images, compaction,
  dashboard or proxy policy. Disabled predictions add no process inspection.

## Verification and limits

The 0.9.29 macOS baseline passed 1,144 tests, with four Windows-only skips,
plus offline HTTP/SSE, performance/resource and package gates.
Targeted tests cover three repeated bridge restarts, exact PAC reuse, unchanged
settings, off/on persistence, invalid saved ports, port conflict preservation,
concurrent preference changes and cleanup of uncommitted activation.
A loopback-only TLS replay reuses a cached client route and certificate across
bridge restart, then verifies disabled configuration pass-through and unrelated
routes. macOS launch tests cover matching/old/missing/unreadable/duplicate main
processes, delayed visibility, launch failure and no inspection when disabled.
Existing Windows profile, certificate, PAC/WPAD and launch tests remain required.

The new parser was checked read-only against the real installed macOS App;
it recognized the single main process and its current PAC route. No live user
configuration or App process was changed, and no real model call was made.
The initial full regression exposed a too-broad new help assertion and the
existing README length guard; both were corrected without weakening existing
tests. The release-report link now points to this file.

The candidate full gate passed 1,153 tests (zero failures, four Windows-only
skips), offline HTTP/SSE, resource/performance budgets and npm package checks.
All nine existing cold/reuse startup scenarios passed. After the single bounded
review, 68 affected tests passed (two Windows-only skips), including identity
changes, ambiguous PAC arguments and immediate rejection of an observed wrong
route. A separate isolated macOS composition replay occupied the saved port,
called the actual client-integration start and verified prediction unavailability,
unchanged settings/occupant, and HTTP 200 from core Responses and the dashboard.
The final composition replay made zero real provider requests and did not
configure the real user profile. The first temporary harness omitted endpoint
metadata, so its synthetic GPT-6.1 request selected the real Chat compatibility
fallback and returned HTTP 400. The harness was corrected to inject Responses
metadata and refuse every non-loopback Fetch; no private chat content was used
and this required no production behavior change.

All six release-candidate CI jobs passed at
`fc2c15bca7f9863cc249f04759bb793f4abaf2fc`:
[CI receipts](https://github.com/DaleXiao/codex-copilot-dx/actions/runs/38369583029).
They cover Linux Node 22.15/24 full gates, Windows Node 22.15/24 native platform
and launcher regressions, the latest official Codex synthetic replay and the
16 Chromium/WebKit dashboard combinations. Linux Node 22.15 and 24 each report
1,153 passing tests; Windows Node 22.15 and 24 each report 133, zero failures/skips.
Baseline/candidate local resource gates passed with import RSS 58.4/58.5 MiB,
heap 7/7 MiB and the same 162.3 MiB single-request admission RSS peak delta.
One-off timings vary; this release claims restart reliability, not faster model
inference or statistical speedups. Request processing modules are unchanged.

An upgrade from random-port macOS versions can require one full App quit to
attach the newly saved address. Persistence prevents subsequent port-change
failures; it does not replay interrupted requests, erase App caches, remove
official eligibility rules or promise instant visible predictions after every
restart. The main service must still restart after a package update. App
identity changes and network-policy changes retain their existing checks.
Windows/macOS GUI gray suggestions after this exact package update are not
claimed as newly user-verified by isolated transport tests.

## Publication receipts

- Formal source tag: `v0.9.30` at `4ad7433092a02c0677285dc37594cc1a30c78920`.
  Runtime/source bytes match the successful candidate CI above; the intervening
  commit only records verification in this report.
- [GitHub release](https://github.com/DaleXiao/codex-copilot-dx/releases/tag/v0.9.30)
  is stable, not a draft/prerelease, and is GitHub latest.
- [npm publication](https://github.com/DaleXiao/codex-copilot-dx/actions/runs/38370158040)
  succeeded with `codex-copilot-dx@0.9.30`, tag `latest`, 1,153 passing tests,
  all smoke/performance/package gates and zero failures.
- The GitHub archive and npm package have the same SHA-1
  `aff84bc536f0d4aaaa933199b12796a3e976a511`, 135 files, 352,316 bytes.
  GitHub's asset digest matches local SHA-256
  `1ecd17e5b8fe3bfa3981e24769c42acac8916ee5c0d44cb4d2bcc59f4c0d5c3e`.
  All 135 packed files were compared byte-for-byte with committed source.
- GitHub operations reused the user's previously supplied PAT in memory. npm
  used the existing repository publishing secret; no browser login or substitute
  credential was used. No local npm-registry probe was needed.
- The installed/running user service and real App were not upgraded or restarted
  by this task. Upgrade installation and the initial old-route migration remain
  explicit user actions, not silently applied to the current conversation.
