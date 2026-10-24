# CCDX 1.2.19

Model capabilities now load automatically from the configured upstream catalog.
Anthropic structured declarations are interpreted for Messages, including token
limits, thinking modes, effort levels, image input, structured output and search.
Other gateway APIs retain their own evidence; names never supply model limits.

## Changes

- Refresh enabled API catalogs on save, startup and the existing refresh cycle.
  Reads are serial and cached for 30 minutes; explicit reads and failures share
  a one-minute minimum interval. Pagination is bounded by 20 seconds, 8 MiB,
  500 models and 25 pages. No inference, new timer or sign-in is introduced.
- Preserve saved models, grants, defaults, credentials and last-good metadata
  on catalog failure. New entries remain candidates until explicitly selected.
  Existing model selections receive matching refreshed capabilities automatically.
- Show capability values by API before collapsed manual overrides. Distinguish
  missing capability data from an unrecognized upstream format. Keep all themes,
  navigation and English/Chinese text; no new runtime UI dependency.
- Separate Codex catalog and Claude alias projections from the API provider.
  Shared plans still enforce source-qualified models, native protocols, local
  credentials, conversation boundaries and pinned running requests. Environment
  keys are captured per provider generation to preserve active request identity.
- Keep the 1.2.18 native sign-in and selected-catalog fixes. Configuration writes
  retain their existing ownership journals and preserve user edits. Application
  update/restart mechanisms are outside this release.

## Limits

An ID-only catalog cannot supply reasoning levels or context limits. Unsupported
formats remain unknown rather than using a vendor-name database. Capability
declarations do not prove inference entitlement or full application compatibility.
Claude host version/window/effort limitations remain explicit. Existing aliases
continue to route to the same authorized deployment when effort evidence changes;
newly available App effort controls can require its compatible alias and a normal
client reopen. Software is not restarted automatically.

## Verification

Local verification covers 1,530 tests (1,520 passed, ten optional/platform
skips), HTTP/SSE smoke, performance budgets and pack contents. Twelve
Chromium/WebKit cases cover three palettes, light/dark appearance and narrow
layouts; two additional cases verify protocol-specific capability display.
An installed native Codex replay retains an existing synthetic ChatGPT sign-in,
selected model catalog and completed synthetic turn. The 1.2.18 → 1.2.19 isolated
upgrade loads sharp and the supported native broker on Darwin arm64 using the
unchanged company registry. Cross-platform CI gates publication.

One catalog-only read of the locally configured gateway returned just `id` and
`object` for its four selected models, with no capability metadata. No inference
or retry was performed. This release reports that limitation; it cannot invent
context windows or effort levels missing from the actual upstream.
