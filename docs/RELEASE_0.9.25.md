# CCDX 0.9.25

## Changes

1. Native prediction now accepts existing static HTTP CONNECT, HTTPS proxy and
   SOCKS5 routes, including Basic/username-password proxy authentication and
   supported host/domain bypass rules. It preserves the original route for
   unrelated hosts and upstream connections. Proxy rejection is not retried
   directly. Dynamic PAC/WPAD, CIDR bypass rules and custom Codex API routes
   produce a specific compatibility message and are not overwritten.
2. CLI status and WebUI separate saved prediction preference, bridge readiness,
   observed configuration traffic and unverified candidate visibility. Only
   bounded configuration/error metadata is retained; no conversation scanning or
   fabricated display confirmation was added.
3. A concrete client-integration composition module owns setup, optional startup,
   snapshots and shutdown. Inference, optional images and management retain their
   separate responsibilities. No generic plugin framework or mass relocation was
   introduced. The bundled architecture document describes these boundaries.
4. Startup, image setup, doctor, optional compression and legacy prediction cleanup
   resolve the same `CODEX_HOME/config.toml` (default `~/.codex/config.toml`). Codex
   config and shared CCDX settings writers use per-file cross-process locks. They
   do not steal live locks or claim transactions with unrelated applications.
5. Responses preparation no longer clones an already-owned input a second time
   or traverses shared current items twice. Immutable caller isolation, history
   snapshots, adaptation, cancellation and output semantics remain covered.
6. GitHub version discovery uses the official latest-release web redirect rather
   than anonymous REST quota. It validates the exact repository, HTTPS origin and
   stable tag, never follows a supplied redirect, and cancels the response body.
   Manual failures identify HTTP refusal, timeout, network failure or invalid
   redirects. Escaped bounded JSON errors provide decoded classification evidence
   without changing their original response bytes.

README, installed reference, help and architecture documentation were reconciled
with these behaviors. Native prediction remains opt-in and macOS-only; image
MCP/skill remains opt-in and the retired prediction MCP/Hook/panel stays retired.

## Bounded review

The review was limited to these six changes and their existing boundaries.
Findings corrected during verification included SOCKS URL parsing, unwanted
directory creation during image cleanup, a config-doctor variable shadow, the CLI
runtime response envelope, proxy TLS fixtures and stale documentation. Test
failures in the bilingual-description and README brevity checks were fixed in
the copy, not by weakening those checks. No unrelated feature expansion followed.

## Verification

- Unchanged 0.9.24 baseline: 1,064 tests passed, HTTP/SSE smoke, performance/resource
  and package gates passed; isolated startup replay passed.
- Final 0.9.25 local gate: 1,086 tests passed, zero failures. HTTP/SSE smoke,
  performance/resource checks and package checks passed.
- Nine isolated cold/reused startup scenarios passed, including conflicting image
  registrations, invalid/failed/pending optional image setup, disabled images,
  malformed retired settings and fatal core config. There were no real provider
  calls. Disabled image users received no skill or image MCP setup.
- Actual loopback HTTP CONNECT, HTTPS proxy and SOCKS5 handshakes passed with TLS
  verification. Tests cover authentication isolation, fragmented handshakes,
  connection reuse, rejected CONNECT, untrusted proxy/target certificates,
  timeouts and pending-connection cancellation.
- Cross-process settings writers preserved both writers' values and unknown
  user keys. Nested writers could not steal a live lock. Module dependency checks
  remained acyclic.
- An isolated headless browser passed eight combinations: English/Chinese,
  dark/light, 1440/390-pixel widths. No page exceptions or document overflow were
  observed. Candidate visibility remained unknown.
- One real anonymous GitHub web lookup returned the existing stable `v0.9.24`;
  it did not invoke npm, install anything or use credentials.

### Request-preparation measurement

A synthetic 7,992,050-byte, 18,000-message request was prepared with the baseline
source and candidate, alternating order for nine rounds. Both prepared-body
SHA-256 hashes were
`3341783393c305b40fa9410c12e6a8b83201710070617d473284789f8480ce32`.

| Preparation mode | First comparison, median ms | Confirming comparison, median ms |
| --- | --- | --- |
| Immutable caller | 49.60 → 29.53 | 47.05 → 27.19 |
| Mutation permitted (runtime path) | 10.59 → 8.75 | 9.09 → 8.11 |

These are preparation-stage measurements on one machine, not improved hosted-model
latency or an SLA. The existing four-request visual-history pressure check passed:
elapsed 254.7 → 252.7 ms; peak RSS delta 88.3 → 89.7 MiB. That small memory variation
is not presented as a memory improvement. Existing resource bounds remained met.

## Compatibility limits

The App-only route still decrypts HTTPS for its two selected hosts; only known
prediction configuration is changed. No system trust, client-program edits,
credential persistence, automatic message sending or global proxy was added.
Static routing is captured at startup; restart CCDX and Codex after changing it.
Corporate PAC/WPAD evaluation, NTLM/Kerberos proxy negotiation and every future
client version are not claimed. This release did not repeat the prior live-user
prediction UI demonstration: observed config traffic is not proof of a visible
candidate. Original official enabled configuration remains preserved.

## Publication

GitHub CI and publication receipts will be recorded after their actual completion.
