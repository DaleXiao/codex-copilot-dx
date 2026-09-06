# CCDX 0.7.6 verification report

Date: 2026-09-06. Baseline: `ab89663` (0.7.5).

## Configuration doctor

`ccdx doctor config` checks only the local Codex configuration. It uses the same
inspection function as the ordinary doctor, while bypassing credential checks,
network/adapter probes, file logging, startup, and GUI launch. Nested help is
available through both CLI entrypoints. The TOML parser is pinned to
`smol-toml@1.8.0`; integer parsing preserves integer/float distinctions.

The checker handles syntax and UTF-8 failures, correctly scoped managed keys,
positive integer context limits, explicit feature opt-out, optional shell
environment tables, and structured configuration with an explicit support
boundary. It previews the existing startup writer in memory. Invalid preview
TOML or semantic changes outside managed keys are errors, not applied edits.
Source snippets, configured URL values, and key values are not printed.

The check is not a complete installed-Codex schema validator or a resolver for
project/profile/environment overrides. Missing/defaultable settings are
warnings; explicit `context_management=false` is valid. Existing inline/dotted
configuration continues to follow the startup writer's existing preservation
rules. No request-processing or automatic configuration-writing policy changes
are included.

## Documentation audit

The README, CLI help, release reports, and benchmark-fixture provenance were
reviewed against source. Corrections cover:

- The offline config-only command versus the ordinary doctor's adapter probe
  and optional file logging, including exit codes and incompatible flags.
- The actual configuration path, startup-only writes, fixed missing-value
  defaults, existing-value preservation, optional shell environment section,
  and startup-preview limitations.
- Cache-backed startup, background refresh, full version/capability checks for
  adapter reuse, and the need to restart after a package update.
- Live/cached model metadata, built-in routing fallbacks, model-picker rules,
  versioned catalog failure behavior, and preservation of bundled capabilities.
- Discovery before Device Flow, image optimization fallback/decode limits,
  distinct image-pressure and hard-limit behavior, encrypted-history recovery,
  allowlisted upstream headers, and diagnostic-log content boundaries.
- Historical release scope and the distinction between 64 KiB processing
  slices and potentially larger complete SSE writes.

Documentation-contract tests compare public environment controls and runtime
defaults to code, validate documented CLI examples, and check local links and
historical report labels. These checks supplement the source review; they do
not establish current live-provider behavior.

## Verification

- Full `npm run verify` passed locally on Node 26.3.0: **651 tests, 0 failures**,
  offline HTTP smoke, performance/resource checks, and a 74-entry npm package
  dry run.
- CLI subprocess tests force interactive stderr, disable network/spawn/write
  primitives, and supply invalid unrelated timeout settings plus a log path.
  Both entrypoints complete config-only checks without side effects. The old
  alias bypasses its warning timestamp for this command.
- Tests cover missing/read-failing/invalid-UTF-8 files, malformed and duplicate
  TOML keys, quoted/dotted/inline keys, multiline example text, table scope,
  valid custom limits, invalid types, feature opt-out, redaction, and exact
  startup-writer previews. A multiline fixture confirms that unowned settings
  changes in the preview are reported rather than concealed.
- Read-only inspection of the actual local configuration reports no required
  startup changes. No live Copilot inference or desktop visual test was run;
  request-processing behavior is unchanged and covered by the existing suite.
- Publishing is gated on the existing GitHub CI matrix for Node 22.15.0 and
  24.x, followed by the existing npm publishing workflow.
