# CCDX 1.2.24

This patch preserves upstream maker metadata, bounds cold token-count bursts,
explains native memory-model dependencies and improves request-flow activity.

## Changes

- Preserve publisher/vendor separately from ownership in a rebuildable,
  revision-scoped display cache. Show the maker in model lists/details; missing
  declarations remain Not provided. Existing connection v2 schema and native
  model names, routes, credentials and history identities remain unchanged.
- Coordinate the first real count for an unknown model/header scope. Distinct
  waiting inputs reuse a 404 observation, never another input's successful count.
  Known-supported counts keep normal concurrency, bounded sharing and independent
  cancellation. No tokenizer, fabricated counts or inference retry is added.
- Retain fixed network causes, requested/forwarded output budgets, returned
  usage and stop reasons. Show output-limit termination without silently raising
  budgets. Explicit access restrictions are notices; client disconnects remain
  separate from service failures. Raw HTTP counters/statuses are preserved.
- Show a configured or recently observed native memory-extraction model and
  warn before closing it or its source. Missing proof stays Not detected; no
  guessed default is written. User-closed models stay closed, and native memory
  settings, login and default model remain untouched. The optional read-only
  helper is bounded, isolated and makes no provider call.
- Align model/source nodes and wire entrances to a common left edge. Replace
  moving packets with thin animated dashes while retaining geometry/SVG reuse,
  the activity halo, reduced-motion/hidden/stale states and summary tables.

## Boundaries

Native memory defaults are not assumed to be one fixed model. Declaration-free
clients with no usable recent task evidence remain unknown. Repeated count 404s
remain clear capability failures, not fabricated success or a source-wide outage.
Network diagnosis does not establish a historical outage cause without evidence.
Manual API metadata is an upstream claim, not backend identity verification.

No new runtime dependency, global routing framework, model replacement,
automatic inference retry or native provider migration is introduced. The
1.2.17/1.2.20 auth and first-model-list protections remain release gates.

## Verification

Local verification passed 1,604 tests: 1,594 passed, ten optional/platform
skips and zero failures, plus HTTP/SSE smoke, performance budgets and pack
checks. Twelve connection-editor cases and 48 dashboard Chromium/WebKit
combinations covered theme/language/size behavior; four focused connection
cases rechecked explicit refresh and memory confirmation. Native Codex passed
all five isolated startup/cache states, seven first-read models, ChatGPT auth
and old-session resume. Real CLI version handoff/rollback and the isolated
1.2.23 → 1.2.24 npm upgrade preserved native config/auth and loaded sharp and
the supported broker on Darwin arm64.

A bounded same-scope replay with sixteen distinct inputs and an unavailable
count endpoint reduced upstream count calls from sixteen in 1.2.23 to one.
Supported inputs retain separate correct counts; cancellation and existing
count timeout budgets are covered. Synthetic failures verified forwarded
output budgets, normalized usage, stop reasons and fixed transport causes.
All replay models/credentials were synthetic and made no live provider call.
A separate read-only native metadata helper check made zero provider calls;
missing role evidence remains Not detected.

Exact-commit cross-platform CI gates publication. Published GitHub assets and
the public npm package are independently byte/digest verified after release.
The existing running service and company registry/proxy/CA policy are preserved.
