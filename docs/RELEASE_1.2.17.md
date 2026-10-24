# CCDX 1.2.17

This patch adds deployment-specific model capabilities and explicit multi-source
model sets for Codex, Claude App and Claude Code on the existing port 2026.

## Changes

- Model sources owns API credentials, native interface declarations and model
  details. Application pages own visible model sets, defaults and synchronization.
  Claude App/Code have separate segments; Settings retains common preferences.
- Strict neutral metadata separates context/input/output limits, reasoning,
  tools/input types and protocol-specific native search. Explicit manual values,
  including false and empty arrays, win. Structured API catalog fields retain
  deployment/time evidence; missing fields stay unknown. Refresh failures keep
  saved data; endpoint/key changes invalidate prior catalog evidence.
- Stable source-qualified routes distinguish same-named models from different
  APIs. Each admitted request pins its source, credential/history namespace and
  capability snapshot. No automatic model substitution, intent routing or
  cross-source retry is introduced. Old IDs resolve only when unambiguous.
- Version-two connections preserve legacy source visibility. The first write
  saves original v1 bytes in a private backup. Disabled sources remove selected
  bindings; restoration does not silently reopen model access. App restoration
  remains reachable on its own page.
- Claude shared host planning uses supported native controls, the largest safe
  shared window and per-model compact budgets, while preserving manual/managed
  fields. Unknown, 64K, above-1M and unverified consumers report limitations.
  Reasoning-compatible aliases are used only for expressible declared levels;
  prior aliases stay source-bound. Tool permissions and safety review are unchanged.
- Declared output limits constrain custom requests and are recorded with a
  bounded capability revision/constraint label. Reasoning conflicts fail locally;
  conversation history is not silently removed. Search remains native and
  protocol-specific; no external search service or universal protocol converter
  is added.
- The contracts and client projections were informed by pinned Magpie, Floway
  and CC-Switch source reviews. This is a selective implementation, not a claim
  that all features of those projects were imported. No runtime dependency or
  enterprise network-policy change is added.

## Verification

Local `npm run verify` passed: 1,518 tests, 1,508 passed, ten optional/platform
skips and zero failures, plus HTTP/SSE smoke, performance budgets and pack
checks. Sixty Chromium/WebKit cases passed (12 source/binding and 48 dashboard),
with no real provider calls. Focused metadata/migration/ownership tests, same-port
multi-source HTTP tests also cover source edits after route qualification,
empty selections, read-only preview and legacy CLI switching. An isolated
1.2.16 → 1.2.17 upgrade passed with sharp and the supported native broker on
Darwin arm64 using the unchanged company registry. The platform CI matrix is
a publication gate.

An installed Claude Code 2.1.308 was exercised against an isolated synthetic API:
128K and 1M deployments retained separate compact budgets; both high-effort
requests reached their selected real model with declared output caps of 16K and
64K. The native host reported a shared 1M window, not a separate display window
per model. This proves the observed request parameters and host metadata; it is
not a large-context compression test or a live-provider capability claim.

No sample capability values are assigned to the user's real API models. Unknown
client versions retain working catalogs with explicit advanced-host limitations.
Native App UI effort-menu adoption, every tool/search combination and actual
large-context limits are not inferred from the synthetic replay. Final local,
CI, package, GitHub asset and npm receipts accompany publication.
