# CCDX 0.9.39: command setup, bounded diagnostics and focused UI feedback

Date: 2026-10-15. Baseline: 0.9.38 / `0362d08`.

## Changes and boundaries

- Windows postinstall recognizes only the exact npm-generated CCDX PowerShell
  launchers, verifies package identity and matching batch targets, and removes
  those `.ps1` shims so bare commands resolve to `.cmd`. The updater and doctor
  reuse the same ownership-checked implementation. Custom/symlinked/unreadable
  launchers are preserved; optional setup errors cannot fail an otherwise
  verified installation. No aliases, profiles, execution policy, PATH, npm shim,
  registry or persistent download-policy changes. Disabled install scripts
  require `ccdx.cmd doctor --fix`. Existing aliases/earlier PATH entries still win.
- The terminal atom is six rows instead of ten. Alignment and plain-title
  fallbacks remain. Ordinary prediction status no longer discusses the retired
  MCP/Hook/panel. Exact owned legacy cleanup remains silent; image MCP remains.
- Dashboard atom rotates once for 450 ms on initial load/manual refresh, using
  transform only and respecting reduced motion. No new HTTP requests, dependency,
  timer, animation loop or changed polling interval. Composite data loading cannot
  finish early because status returned first; account reads remain independent.
  Prior data/errors survive retries until a successful replacement.
- Missing-token discovery adds explicit legacy OpenCode Copilot OAuth and an
  installed GitHub CLI source. It retains explicit-source priority, account
  binding and ambiguity refusal; no saved-token startup work is added. Readers
  are bounded, GitHub CLI is noninteractive/optional, and candidates must pass
  GitHub identity plus Copilot validation. Incomplete scans/network failures do
  not cause a second login. Other providers' API keys and enterprise OAuth are
  not reinterpreted. No new credential database, keychain scraping or dependency.
- `doctor --fix` repairs owned launchers/startup-managed config, recovers an
  existing credential only when none is saved, and delegates enabled prediction
  repair to the existing API. One attempt and affected verification, no loop.
  Existing changed config has a transactional latest-repair backup. Invalid or
  unrelated config, disabled optional features, company routes and TLS policy
  are preserved. Required App/service relaunches remain partial results, exit 1.
  `--json` separates redacted before checks from final repair results.
- Compatibility probes require semantic model completion, reject incomplete or
  contradictory terminal events and HTTP-200 error envelopes, and bound probe
  bodies to 4 MiB. Default doctor remains read-only/no inference. Explicit missing-
  token repair may contact GitHub without `--online`; it never opens login.
- Doctor composition, inference probes, repairs, external credential readers and
  Windows command ownership have separate modules. Existing exports remain, and
  import-cycle/dependency boundary tests cover the additions. No inference stream,
  model/tier mapping, compaction recovery or image delivery code is changed.

## Review and verification

Baseline: 1,248 passed, 9 Windows-only skips, zero failures. Performance/resource
gates pass. Local candidate verification includes the full suite, offline HTTP/
SSE smoke, isolated startup/reuse replay, performance/resource gates, package
manifest, and eight real Chromium bilingual/theme/viewport cases using a fresh
headless profile and synthetic provider. No live inference or image generation,
real account changes, Codex restart, system trust/proxy changes or browser login.

Focused review caught and corrected slow-account-read blocking of dashboard
refresh, optional launcher repair errors misreporting successful installs as
failures, and the need to exclude before-repair checks superseded by verified
repairs. Regression tests cover exact launcher ownership/idempotence, account
audience/deadlines, disabled features, config preservation/backup, JSON redaction,
business failure semantics, motion/no-motion and Chat `[DONE]` as a hard boundary.

The local configured npm mirror returned ETARGET for the old 0.9.31 package before
the lifecycle upgrade began. No mirror/policy override or fallback was applied.
Cross-platform CI must pass actual old-to-new package installation, native sharp,
and Windows restricted PowerShell command resolution before publication. Fresh
install and upgrade both verify bare commands in available PowerShell 5.1/7.

Upstream source ideas were applied selectively, without copying frameworks:
[CC Switch ordered discovery](https://github.com/farion1231/cc-switch/commit/76f99d41a66e24a5ed2e8982bc494399f306bfe6),
[Magpie source-specific credential import](https://github.com/yetone/magpie/blob/37fec124095cc3ff91960d3f4e6fa2d010b4044b/internal/provider/import_opencode.go),
[Magpie HTTP-200 business errors](https://github.com/yetone/magpie/blob/37fec124095cc3ff91960d3f4e6fa2d010b4044b/internal/provider/zhipu_envelope.go),
[Floway refresh state](https://github.com/Menci/Floway/blob/f117981cb8a186b8c1e685d44276fff27f2dc580/apps/web/src/components/ui/use-refresh.ts).
Legacy OpenCode's GitHub-token audience was additionally checked against its
[Copilot OAuth implementation](https://github.com/anomalyco/opencode/blob/4397ee44d038a5f17bf6ac161431673d93e563b5/packages/core/src/plugin/provider/github-copilot.ts).

## Publication

Pending cross-platform CI. No published-success claim is made here yet.
