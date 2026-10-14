# CCDX 0.9.37: bounded machine-environment adaptation

Date: 2026-10-14. Base: released 0.9.36. No new runtime dependency.

## Scope and ownership

1. `network-bypass.mjs` compiles and matches static host/domain/port/IP/CIDR rules.
   Node and PAC embed the exact same pure matcher. The four reported macOS
   exceptions are accepted; malformed rules fail with a specific, redacted cause.
   CIDRs match URL IP literals, not DNS results. This preserves Chromium's manual
   bypass semantics and remote proxy resolution, without DNS or system-policy I/O.
   Per-protocol source precedence and existing domain semantics are retained.
   Unused lower-priority static proxies cannot block selected explicit routes.
2. `prediction fix` rechecks system routing. Healthy unchanged bridges remain;
   changed valid snapshots recreate only the optional bridge on its saved port.
   Unknown policy preserves the previous bridge and exits nonzero. Startup-only
   Node trust changes request a service restart, not fake hot loading. A running
   App's cached PAC is treated separately: the relaunch warning remains until a
   closed App or different readable main PID is observed. Bounded automatic
   listener recovery also retains these warnings and trust boundaries.
3. `native-prediction-environment.mjs` owns read-only optional-feature discovery.
   Shared sanitized summaries serve startup, status, prediction commands and the
   running-adapter doctor. Public state contains source/type/counts, extra-CA
   diagnostic state and adaptation status, not proxy URLs, credentials, internal
   exception rules, CA paths or comparison hashes. Extra-CA inspection is bounded
   to 1 MiB, diagnostic only and never an import into system/App trust.
4. Existing App/profile discovery, signature checks, file ownership, saved-port
   checks, npm/PATH/prefix and terminal adaptation remain with their current owners.
   No global environment service, arbitrary configuration override, inferred
   account authorization, OS trust/proxy/ACL write or client program patch is added.
5. Regression fixtures cover environment source/priority, IPv4/IPv6 boundaries,
   prefix extremes, canonical IPs, wildcard/domain/port rules, malformed input,
   literal-only behavior, Windows static/automatic policy, explicit conflicts,
   read-only/redacted trust inspection, unchanged/changed/invalid repairs, actual
   supervisor recovery, persistent routes, App updates and disabled-feature probes.

The semantics follow [Chromium's proxy documentation](https://chromium.googlesource.com/chromium/src/+/HEAD/net/docs/proxy.md#Meaning-of-IP-address-range-bypass-rules).
Startup-only extra-CA behavior is documented in [Node's command-line reference](https://github.com/nodejs/node/blob/main/doc/api/cli.md#node_extra_ca_certsfile).

## Bounded review and local verification

- Baseline full run: 1,213 passed, one unchanged CLI doctor test hit its existing
  two-second child-process timeout, eight Windows-only skips. The exact test
  passed immediately in isolation (170 ms total), without changing its timeout or
  assertion. The concurrent baseline benchmark passed existing resource gates.
- Final local full suite: 1,223 passed, eight Windows-only skips, zero failures.
- Offline HTTP/idle-SSE, all nine isolated startup/reuse scenarios and the package
  dry-run passed. Both new production modules are included, with no temporary
  logs, release helpers, credentials or test-only modules in the package.
- Review specifically covered a running App retaining cached PAC, repeated fixes
  retaining relaunch warnings, automatic recovery after network/trust changes,
  no-probe disabled startup, current supervisor delegation, concurrent fix/shutdown,
  profile trust/port preservation, signature recognition and management security.
  No unrelated refactoring or repeated optimization loop was added.
- The reported exceptions are exercised through both environment/system sources
  and real isolated profile startup/persistence/App-update checks. No real user
  profile, proxy setting, certificate store or running App/service was changed.

## Performance evidence

Both baseline and candidate pass the existing performance/resource gate. Local
adapter-import RSS is 58.5 -> 58.6 MiB and heap 7.1 -> 7.1 MiB. SSE scan ratios
for 1/2/4/8 MiB remain 1.0; repeated 8 MiB tool output parses once and eight
duplicate images invoke the optimizer once. No model-path probe or DNS lookup
was introduced. Disabled prediction startup adds no environment/CA probe.

| Preparation case | Baseline | Candidate | Baseline / candidate peak RSS delta |
| --- | ---: | ---: | ---: |
| 5 MiB x4 | 110.3 ms | 99.7 ms | 104.9 / 104.1 MiB |
| 30 MiB x1 | 186.8 ms | 145.0 ms | 171.5 / 166.4 MiB |
| 30 MiB x2 | 290.9 ms | 256.7 ms | 227.6 / 219.7 MiB |

These are individual local samples, not statistical speedup claims or all-machine
latency guarantees. The functional improvement is verified acceptance and correct
matching of previously rejected environments, with truthful repair/restart status.

## Deliberate limits

macOS PAC/WPAD execution remains unsupported; its configuration is preserved.
Windows automatic policy remains with the native worker, and mixed explicit
environment/automatic policy conflicts remain explicit failures. PAC contents at
an unchanged URL are not newly watched. Environment variables belong to the
service process; a new shell cannot overwrite them through the repair endpoint.
CA inspection does not prove runtime loading, validity for a particular connection
or enterprise authorization. Network comparisons are process-local; an App route
or gray-text UI result is not proven by a ready bridge or an adapted snapshot.
Real affected-Mac and company-network acceptance remains a separate user test.

## Release receipts

Release commit `00e145f497e26a95095a8a0ae2bdb385c51ec51e` passed all eight
[candidate CI jobs](https://github.com/DaleXiao/codex-copilot-dx/actions/runs/38592409191):
Windows, macOS and Linux on Node 22.15/24, official Codex synthetic replays and
Chromium/WebKit bilingual/theme/viewport dashboard replays. The platform jobs also
verify isolated installation/upgrade and native sharp execution. No remote rerun
or weakened production timeout/assertion was needed for this candidate.

GitHub release: [v0.9.37](https://github.com/DaleXiao/codex-copilot-dx/releases/tag/v0.9.37).
The 148-file archive is 377,749 bytes. Its local SHA-256 matches GitHub's asset
digest: `ddd25d087e35dd539a63b3443e2d95f7a64270c8f144d016ae3b1737d9350f22`.
Local npm-pack SHA-1: `28d1d036ffb8d4f08f0a17a79fc135382707b5d2`.

[npm publication](https://github.com/DaleXiao/codex-copilot-dx/actions/runs/38592853205)
succeeded with `npm publish --tag latest`; the official registry acknowledged
`+ codex-copilot-dx@0.9.37`. The runner verified 1,223 passed / eight skipped /
zero failures and the existing performance/resource gate before publication.
Its 148-file package SHA-1 matches the local archive above. This is registry
publication evidence from the runner, not a claim of an independent local read.
GitHub used the user's previously supplied PAT, and npm used the existing
repository publishing secret. Neither credential is stored in the report.

The identical release commit also passed all eight
[main-branch CI jobs](https://github.com/DaleXiao/codex-copilot-dx/actions/runs/38592830243).
The last macOS/Node 24 job waited for a GitHub runner, then passed without code
changes or a job rerun. No CI failures remain in the candidate, main or npm run.
