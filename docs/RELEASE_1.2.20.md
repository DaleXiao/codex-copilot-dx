# CCDX 1.2.20

Explicit defaults keep their identity when temporarily unavailable. API catalog
reads no longer block unrelated configuration saves. Application pages retain
separate Codex, Claude App and Claude Code drafts with predictable keyboard focus.

## Changes

- Distinguish an unspecified default from a missing explicit default. Preserve
  native client configuration instead of choosing the first remaining model.
  Other selected models remain readable and callable; a missing model produces
  a model error, not a sign-in challenge. Catalog recovery keeps the same route.
- Normalize builtin capabilities without treating raw vendor objects as manual
  overrides. Map explicit tool-call, structured-output and vision declarations;
  preserve false and unknown. No model-name capability database is introduced.
- Separate catalog network work from short configuration transactions. Join
  same-deployment reads, cancel obsolete work and check identity before commit.
  Preserve last-good data on failure; sync only affected clients. Existing
  timeout, pagination, cooldown, ownership and pinned-request rules remain.
- Keep per-client page-local drafts through navigation and reads. Save/Discard
  affect one client. Restore focus after model selection, focus Add API's first
  field and return to its entry on cancellation. Narrow model rows stack their
  metadata; desktop keeps a table. Account labels/values stay paired.
- Use one source selection for management, account and catalog. Keep disabled
  sources folded there. Consolidate app model controls and fold Claude connection
  and performance details. Settings keeps web appearance, terminal/motion,
  startup and version controls. Preserve all palettes, SVG icons and motion.
- Give save/read buttons local busy feedback, cancellation and polite read status.
  Keep failure messages through background reads. Request summaries show source
  names; improve dark-green secondary text contrast and concise bilingual copy.

The adopted principles reference Magpie's bounded asynchronous feedback and
anchor preservation (ce5b23c, f35c721), CC Switch's source-identity and native
configuration preservation (bada9a4, 3d7cf6a), and Floway's version-bound catalog
publication and refresh-state separation (3919a92). These are implementation
principles, not imported runtimes or dependencies.

## Limits

Page-local drafts do not survive browser reload. ID-only upstream catalogs still
cannot provide reasoning levels or context limits. No model substitution, dynamic
router, automatic cross-source retry, software update/restart mechanism or
universal protocol conversion is added. Capability declarations do not prove
inference entitlement. This release retains native sign-in and ownership
safeguards; it does not modify the installed live service during verification.

## Verification

Local `npm run verify` passed: 1,535 tests, 1,525 passed, ten optional/platform
skips, zero failures, plus HTTP/SSE smoke, performance budgets and pack checks.
The isolated 1.2.19 → 1.2.20 upgrade loaded sharp and the supported native broker
on Darwin arm64. Native Codex completed a synthetic turn while preserving an
existing synthetic ChatGPT sign-in and selected model catalog. Twelve connection
browser cases cover Chromium/WebKit, three palettes, light/dark and narrow
layouts, including independent drafts, focus, preview, selection and failed saves.
Sixteen additional dashboard cases cover both engines, English/Chinese,
light/dark, 420/1280 widths, settings, charts and existing activity/flow motion.
No real provider inference was performed in these checks.
Cross-platform CI gates tagging and publication. GitHub assets and npm package
bytes are checked after publication; company registry policy remains unchanged.
