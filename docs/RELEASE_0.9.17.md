# CCDX 0.9.17 verification report

Date: 2026-10-08. Baseline: `e02afea` (0.9.16).

## Delivered scope

| Item | Change | Preserved boundary |
| --- | --- | --- |
| 2 | Ignore confirmed repeated complete Chat tool names using declared names | Preserve overlaps, late names, ambiguous/undeclared fragments, arguments, IDs/indexes, cancellation and native Responses. Retain only name strings, not request schemas/images/history. |
| 5 | Wrap genuine usage CLI read errors in the normal error/exit-1 path | Missing logs still succeed with an empty summary; malformed records remain warnings, not fatal errors. |
| 1 | Apply IPv4 public/private rules to the embedded address of well-known NAT64 `64:ff9b::/96` | Public translations continue to work; no blanket /32 or /96 ban, extra DNS lookup or change to pinned DNS/deadlines/byte limits. |
| 3 | Validate generation/editing redirects before following | Preserve same-origin HTTPS, 301/302/303 POST-to-GET and 307/308 POST/body semantics, 20-hop cap and one cancellation/timeout signal. No automatic generation retry. |
| 4 | Validate Image MCP Host before reading body/credentials | Preserve loopback, equivalent IPv6/IPv4-mapped addresses, same-device LAN socket IPs, explicit bind hostname and missing-Host compatibility. Existing socket/Origin/JSON gates remain; other LAN APIs do not change. |

The previous review document was treated as evidence to verify, not instructions
to apply blindly. Its invalid nine-group IPv6 fixture, missing-file failure
expectation, substring-deduplication suggestion and cross-origin Authorization
leak claim were not adopted. Existing name-fragment coverage was retained.

## Baseline and tests

- Clean baseline `npm run verify`: all 956 tests, offline HTTP smoke, SSE idle
  replay, performance/resource gates and package preflight passed before edits.
- Candidate `npm run verify`: all 968 tests passed with no cancellations, plus
  existing HTTP/SSE smoke, performance/resource gates and package preflight.
- The 72 targeted tests passed. New coverage includes repeated complete names,
  interleaved tools, overlapping fragments, late names, undeclared ambiguity,
  argument preservation, cancelled downstreams, valid expanded NAT64 addresses,
  private/public/mixed DNS answers, redirect methods/body/signal identity,
  refused targets, body cancellation, 20-hop cap and deadline cancellation.
- Host coverage includes loopback, same-device LAN, compressed/expanded IPv6,
  IPv4-mapped equivalence, explicit hostname, missing Host, malformed authorities,
  spoofed names/IPs and remote LAN rejection before configuration reads.
- Usage child-process checks cover actual read failure, nonexistent logs without
  file creation, and invalid records without echoing their contents. The existing
  CLI output formats and usage cache/rotation semantics are unchanged.
- Isolated startup replay passed image-disabled, optional-image-conflict, reuse
  and invalid shared-configuration cases. Existing editing, image delivery,
  opt-in installation, Fast/Auto-review, encrypted continuation and client
  regressions remain passing. No real provider inference/image generation,
  provider credential use, user configuration write or active-service restart.

## Real network verification and security limits

- Real Node Fetch ran against owned loopback HTTP servers with synthetic keys,
  prompts and image bytes. The fixture adapts logical HTTPS URLs to test-only
  loopback HTTP; production TLS validation is never disabled or changed.
- Baseline Fetch removed Authorization on the cross-origin 307, but forwarded
  the synthetic POST body. Candidate manual validation sent zero requests to
  that unsafe target. The same-origin image operation completed with identical
  POST data and returned image bytes. This is not a claim of an actual leaked
  production key or a successful attack against an internal network.
- Refused redirects include changed origin/port, HTTPS downgrade, URL credentials
  and malformed targets. Redirect response bodies are cancelled, diagnostics do
  not include target URLs, prompts/images or keys, and abort prevents another hop.
  Providers depending on a cross-origin redirect must be configured at their
  final API endpoint; unsafe forwarding is intentionally no longer accepted.
- NAT64 checks cover the well-known /96, not arbitrary network-specific translator
  prefixes. They prove classification/dispatch behavior, not real gateway routing.
- Host validation is defense in depth, not proof that the previous Origin gate
  was bypassable by a browser. It adds no DNS resolution or local-client auth
  framework and does not change intentionally configured LAN inference access.

## Performance and bounded review

- Baseline/candidate native stream parse/copy/write/drain, content, cancellation
  and no-read-while-blocked invariants were identical. Import heap stayed 7 MiB;
  duplicate-image optimization and large tool-output parsing stayed one call.
- No new dependencies, polling or normal inference calls. Tool-name checks run
  only on name-bearing Chat deltas; standard argument-only deltas are unchanged.
  Declared-name retention is small scalar metadata, not the released request body.
  Image JSON is serialized once and reused across permitted redirects. Existing
  valid direct requests still make one provider call. Absolute timing variations
  are not a claimed inference-throughput speedup.
- One scoped review/test pass retained immutable POST header snapshots during
  method changes, cancelled redirect bodies, checked abort before the next hop,
  preserved explicit bind names/IPv4-mapped equivalence, and kept timeout fixtures
  alive without changing production deadlines. No unrelated refactor, blanket
  address ban, substring heuristic or repeated scope expansion was performed.
- Dashboard assets, schemas, request admission/history/encryption, model routing,
  settings and safety policy are unchanged. Reference/quick-start warnings match
  the new narrowly scoped behavior. `git diff --check` passed.

## Publication and cleanup

Remote publication evidence will be recorded after CI and release completion.
Cleanup is limited to owned release helpers, logs and npm query cache; tests own
and remove their temporary files/servers. Preserve real settings/credentials,
dependencies, active services and this report. Final handoff requires a clean
checkout synchronized with remote main and the immutable version tag.
