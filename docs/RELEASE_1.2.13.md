# CCDX 1.2.13

This patch implements the approved manual API and many-to-many client access
design. The existing palettes, atom, native status icons, CLI language and single
main listener remain. GitHub is still the initial Codex source; existing M365
setup remains compatible until an explicit client connection change.

## Changes

- Settings adds API records with HTTPS addresses, private keys, per-model native
  API declarations, explicit catalog reads and optional environment-key references.
  One source may be allowed for several clients; each client has its own current
  source. Saving does not make inference calls or switch a client.
- Claude App and Claude Code use Messages at `/anthropic`; Codex uses Responses
  at `/v1`, all on the configured main port, normally 2026. No new listener,
  protocol translator, intent classifier, automatic fallback or retry framework
  is introduced. Chat-only records are catalog information, not Claude routes.
- API keys remain in system credential protection or an explicitly named
  environment variable. Client configuration receives private local credentials.
  Management is same-origin and loopback protected; client hints cannot grant
  access. Endpoint origins are pinned and redirects refused. API error bodies
  are replaced with bounded codes so echoed keys are not forwarded.
- Disabled entries leave normal navigation and source choices, with recovery in
  Settings's collapsed Disabled section. In-use source changes require explicit
  replacements or pauses. Existing API requests keep their source while draining;
  legacy M365 work is guarded. Re-enabling retains configuration and grants but
  does not choose a route. User-edited app settings are retained.
- A dedicated Codex provider and authenticated model catalog expose configured
  custom names in supported native selectors. Unknown models do not borrow
  another model's instructions or claim unverified capabilities. Auto-review
  remains source-scoped; a manual API does not get an unadvertised low override.
- Existing M365-specific Claude beta restrictions are not imposed on manual
  APIs. Owned restrictions can be restored without touching user overrides.
  Shared Messages observation includes every source while M365 statistics retain
  their own scope. Source-label bounds cover two built-ins plus 16 manual APIs.
- Current docs, bootstrap targets, package version and bilingual text match the
  implementation. Runtime npm dependencies and enterprise policy are unchanged.

## References

The reviewed [Magpie e96d577 snapshot](https://github.com/yetone/magpie/tree/e96d577f28ccb74a2b8927d2e78edfb1e4426860)
informs separate protocol addresses, caller-scoped source/model access and stable
conversation identity. Its routing groups, plugin runtime and automatic account
selection are not imported. CCDX retains its own bounded contracts and transport.

The official [Codex provider setup](https://learn.chatgpt.com/docs/config-file/config-advanced#custom-model-providers)
and [gateway catalogs](https://learn.chatgpt.com/docs/enterprise/roll-out-a-gateway#use-a-model-catalog-for-custom-names)
define the native bearer/provider/catalog configuration used by the isolated
client replay.

## Verification

Local `npm run verify` passed **1,496 tests: 1,486 passed, ten platform/optional
skips, zero failures**, plus HTTP/SSE smoke, performance/resource and pack checks.
The existing Chromium/WebKit replay passed 48 language/palette/mode/viewport cases;
12 connection cases covered actual save/grant/bind/disable/restore flows, narrow
layout, literal source names, key non-disclosure and zero implicit discovery.

The installed official Codex completed a synthetic native custom-model turn with
its authenticated model catalog visible in the native selector. Official Claude
Code and a Claude App protocol sender independently completed Messages calls on
the same listener; an incorrect display hint did not change authenticated client
identity. These checks made **zero live-provider calls**. App configuration and
protocol checks are not a restarted visible Claude App or a guarantee about an
unprovided API service's features/entitlement. macOS Keychain was separately
round-tripped with a random disposable value and cleaned; Windows CurrentUser
protection is exercised by its platform test.

An isolated **1.2.12 → 1.2.13** upgrade loaded sharp and the supported native
Microsoft broker on macOS arm64. The verified baseline tarball SHA-256 was
`36db307730edce6dac811bc99c5cafa9550777c5c68aa3b182679124dd0b5ab3`.
No-Git installation, missing-Node bootstrap, installed commands, corrupted-download
retention and configured CONNECT/private-CA downloads passed locally. TLS stayed
strict; configured company registry/proxy/certificate policy was not changed.

One paired same-host synthetic held-stream run covered 16/64/128 concurrency. At
128 streams, status P95 was **1.671 / 1.702 ms** and sampled RSS **113.86 / 115.75
MiB** for 1.2.12/candidate. Every run returned active work to zero. Existing
resource budgets pass; these bounded samples do not prove a universal speedup or
real-provider latency. Full-capacity configuration (16 APIs × 500 models) reloads,
while the live status remains under 20 KiB and does not construct API transports.

Final platform CI, package digest/byte comparison, npm publication and fresh
GitHub asset receipts are recorded with the release. Company mirror
synchronization is checked separately from public publication.
