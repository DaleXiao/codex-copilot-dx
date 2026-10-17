# 1.2.0 verification and release receipt

Published verification, 2026-10-17. This file records observed checks, not a universal
upstream-access, hardware-performance or native-client-UI guarantee.

## Scope and version

1.2.0 adds bounded source/protocol observations and a shared internal source
description contract while preserving commands and saved settings. The additive
surface warrants a minor version. Native Responses and Messages semantics,
explicit source selection, network policies and installation dependencies remain.

- Separate Claude client configuration/restore lifecycle from source auth/catalog.
- Drive dashboard source choices from bounded internal metadata; no plugin loader.
- Separate cancellation, unknown abort, timeout and access-denial facts.
- Add source/model/outcome aggregates and source-specific process usage.
- Correct all-buffer cleanup wording and confirmation; preserve transcripts. Busy cleanup is refused and must be retried after active requests finish.
- Keep CLI English and WebUI bilingual, with stable message IDs and concise copy.
- Preserve the atom logo, refresh motion, terminal themes and reduced motion.
- Wrap terminal summaries, show stale reads and retain 40×16 compact usage tables.
- Read a coherent settings snapshot once, without a new stale cache.
- Pin existing checkout/setup-node v4 Actions to verified official commit SHAs.

The [copy inventory](UX_COPY.md) includes the before/after tables. M365/GitHub,
images and optional prediction retain their independent credentials and controls.

## Local measured bounds

Against tag v1.1.1, same host and synthetic native Responses traffic:

| Measure | 1.1.1 | Candidate |
| --- | ---: | ---: |
| Throughput, median of four interleaved runs | 3219.711 request/s | 3323.480 request/s |
| P50 request latency | 2.013 ms | 1.966 ms |
| P95 request latency | 3.308 ms | 3.248 ms |
| Post-GC heap | 19.625 MiB | 19.690 MiB |
| Post-GC RSS | 141.844 MiB | 141.672 MiB |
| 128 held streams: status P95 | 0.727 ms | 0.812 ms |
| 128 held streams: RSS (client and server in one process) | 110.984 MiB | 111.609 MiB |

The small timing differences are not an upstream speed claim. New bounded source
observations retain additional metadata. All 16/64/128 held-stream cases kept
management responsive and returned to zero active requests after cancellation and
completion. Byte admission is not an active-stream cap; existing defaults were
retained because this workload did not justify lowering accepted concurrency.
This does not establish an unlimited or universal safe concurrency bound.

1,000 isolated settings snapshots opened the settings file 4,000 times in 1.1.1
and 1,000 times in the candidate. The sample took 27.24 ms versus 10.51 ms; it is a
local file-read measurement, not a whole-application performance claim. Strict
validation and immediate external-file-change visibility remain.

## Verification boundaries

- Differential replay: 13 scenarios against 1.1.1, matching synthetic requests and
  wire results; no live provider call.
- Real Chrome replay: 8 language/theme/width combinations, including settings,
  source switching, preserved unsaved choices, atom motion and reduced motion.
- xterm replay: 40/80/120 columns × 16/24 rows × color/no-color, 200 frames per
  case, with resize, compact tables, notices and activity on separate rows.
- One independent review found three source-control/terminal regressions; all
  were repaired and covered before release. No repeated open-ended review cycle.
- Local release gate: 1,369 passed, 9 platform/optional skips, 0 failures; offline protocol/idle replay, benchmark thresholds and package manifest passed.
- Isolated startup replay: all 10 modes completed; no real provider request.
- Cross-platform CI/publication receipts are recorded below.

Synthetic CI does not establish all real Microsoft tenant entitlements, OS policy
combinations, visible prediction candidates or a live Claude/Codex conversation.
No running user service, global install or client profile is replaced by these
isolated checks. The company npm registry, PAC/WPAD, certificate and npm policy
settings are preserved; public npm publication uses the GitHub-hosted workflow.

## Design references

Mechanisms were reviewed from these pinned source snapshots; no third-party
implementation or runtime dependency was copied:

- [Magpie](https://github.com/yetone/magpie/tree/dccfefdf722ea25f5cf2be1798d5686e43b89fbd): source metadata, identity-aware cache invalidation, bounded concurrency evidence.
- [Floway](https://github.com/Menci/Floway/tree/a6478e7d88e00f5133c396d353f01198bb731a98): protocol-specific source contracts and source-aware telemetry.
- [cc-switch](https://github.com/farion1231/cc-switch/tree/7344cc37865da59308bca1a90c95ab2ee05c957c): isolated adapters and error classification.

Automatic source failover, new databases/services, a provider plugin runtime and
account-side OIDC migration are outside this release. Existing publish secrets
are retained; no registry, credential or persistent npm policy is changed.

## Publication

- [npm 1.2.0](https://www.npmjs.com/package/codex-copilot-dx/v/1.2.0)
- [GitHub v1.2.0](https://github.com/DaleXiao/codex-copilot-dx/releases/tag/v1.2.0)
- [Code CI: 14/14 successful](https://github.com/DaleXiao/codex-copilot-dx/actions/runs/39005070473), source `4508457887145c6dd713090268ae7c5fd600bf77`.
- [npm publication succeeded](https://github.com/DaleXiao/codex-copilot-dx/actions/runs/39005602889), release source/tag `68b977ff4de5de4b53b0e02ee78a8bd2cbcc9c2d`.

The final follow-up changes only README, this receipt and the reference: busy
cleanup refuses and requires retry rather than waiting automatically. Runtime,
dependency, workflow and test Git trees match the 14/14 CI commit exactly. Eight
final documentation/cache checks passed, and the publication workflow ran the
complete release gate against the final tag. No second optimization round was added.

The final tarball has **179 files / 470,883 bytes**, 11,983 bytes more than 1.1.1.
It adds no runtime dependency or install hook. Local temporary-prefix 1.1.1 →
1.2.0 installation/upgrade used the company registry and loaded installed sharp
and the supported native broker on macOS arm64. CI also passed actual strict npm
12 registry/CDN/install/upgrade paths on Linux, Windows and macOS.

- SHA-256: `c3bf1166aacd5d2eff9b3779b0cb534e4dcb0f0c40b7acbeb7a1f4cad50caff4`
- npm SHA-1: `7e1f7de1b4af352afdd414b381b5c46b3ceecfb6`
- Integrity: `sha512-N4x4bEIW0Y0lf+4Y3AlC9iKTr0xpG2fuYTvz1X/S0JI2ixYt12CQSaearV3mCO4I9XWUpAi+yzOKJwbCfte1ug==`

The npm publication log, GitHub asset service digest and a fresh GitHub download
match the local release artifact. `SHA256SUMS` uses a portable basename.

The existing company mirror returned E404 for 1.2.0 on two bounded checks, last
at 2026-10-17 05:19 UTC; synchronization is not yet verified. No public-registry
retry or registry/policy change was made. While waiting for mirror synchronization,
`ccdx update github` uses the released GitHub version and retains the configured
registry for dependencies. Restart the running CCDX service after installation.
The user's global installation and running service were not replaced by validation.
