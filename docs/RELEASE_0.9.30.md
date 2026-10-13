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
It made zero real provider requests and did not configure the real user profile.

An upgrade from random-port macOS versions can require one full App quit to
attach the newly saved address. Persistence prevents subsequent port-change
failures; it does not replay interrupted requests, erase App caches, remove
official eligibility rules or promise instant visible predictions after every
restart. The main service must still restart after a package update. App
identity changes and network-policy changes retain their existing checks.
Windows/macOS GUI gray suggestions after this exact package update are not
claimed as newly user-verified by isolated transport tests.
