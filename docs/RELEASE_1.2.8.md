# CCDX 1.2.8

This report describes the 1.2.8 release and its bounded verification environment. It is historical evidence; synthetic checks do not establish every upstream account's entitlement or physical device's behavior.

## Changes

- Adds independent Soft pink choices for WebUI and terminal alongside unchanged Classic green defaults and Klein blue. Web colors include dark/light semantic roles, charts, controls, atom favicon and previews. Terminal logo, table and existing animations use capability-aware pink; explicit light COLORFGBG backgrounds receive a darker tone. The user's terminal background is not queried or changed.
- Adds an Overview activity row: six 4px theme-colored dots appear and retract while the latest status reports model work. Active dots have no glow; idle has one breathing halo. Missing, failed or six-second-old evidence shows unknown. Hidden views pause, reduced motion stays static, and the existing two-second status polling is reused. Very short requests between snapshots may not be shown.
- Adds Cache hit in the live terminal table's existing empty usage row. It reads the same unrounded process-local aggregate as Overview; partial cache evidence retains `~`, missing/invalid evidence retains `—`, and known zero remains `0.0%`. Table height, clipping and animation layout are preserved.
- Fixes Claude first-output timing: empty and signature-only content deltas no longer count as model output. Native SSE bytes, sparse/interleaved block order, tools and signed data remain unchanged.
- Adds focused lifecycle regressions for delayed catalogs after source closure, concurrent CLI/UI settings, rejected queued operations and listener release while a child remains alive. Existing generations, account isolation, serial actions and atomic writers remain in use.

No runtime dependency, installation hook, provider failover, model substitution or additional model/probing request is added.

## Upstream practices reviewed

- [Magpie active-request lifecycle](https://github.com/yetone/magpie/blob/5fadf6acebd844c4c5cecf78dd55e3c7bfbe4096/internal/gateway/active.go) and [visibility-aware rendering](https://github.com/yetone/magpie/blob/5fadf6acebd844c4c5cecf78dd55e3c7bfbe4096/internal/gui/assets/plugins/routing/client.js): adopt truthful activity and bounded presentation using CCDX's existing counters and refresh path. No trace store or long-poll subsystem is imported.
- [Floway version-bound model refresh](https://github.com/Menci/Floway/blob/3cccbef7433bd7143c327def39a3dc802cd9aded/packages/gateway/src/execution/models-refresh.ts) and [interleaved Messages handling](https://github.com/Menci/Floway/blob/3cccbef7433bd7143c327def39a3dc802cd9aded/packages/gateway/src/data-plane/chat/anthropic-messages/interceptors/web-search-shim.ts): strengthen closed-source publication and stream-order regressions without importing its translation framework.
- [cc-switch operation serialization](https://github.com/farion1231/cc-switch/blob/c7dceb8036847ea95e578d56f75cf6666245b705/src-tauri/src/proxy/switch_lock.rs) and [Windows listener inheritance regression](https://github.com/farion1231/cc-switch/blob/c7dceb8036847ea95e578d56f75cf6666245b705/src-tauri/src/proxy/server.rs#L478): protect existing setting transactions and test Node listener release rather than copying a Rust socket implementation.

## Verification

The verified 1.2.7 tarball (`3b0167d33132286a5067ae9a9d962abdaa5740be71242ec5b691eac3bbb32d68`) reproduced the empty/signature-only first-output bug. The regression passes with the fix. Native-stream replay covers 1/7/64-byte fragmentation and nonconsecutive, interleaved tool/text/thinking blocks with exact byte comparisons.

The first real-browser pass caught an omitted optional-route registration for the new activity asset. It was corrected, and a real-dispatcher local/foreign-Host regression was added. A synthetic timing fixture was also corrected to record the upstream start, matching the production provider boundary. The first CI pass exposed a new test fixture reading through the runner XDG_CONFIG_HOME instead of its isolated environment; an explicit-XDG replay reproduced it, and both reads now use the same isolated environment. Production path selection was unchanged.

Local `npm run verify` passed: **1,455 tests, 1,446 passed, 9 platform/optional skips, zero failures**; HTTP smoke, SSE idle, performance/resource gates and package checks passed. Chromium/WebKit completed **48** theme/mode/language/viewport cases; xterm completed **36** palette/color/size cases including 200 animation frames and resize. Additional reduced-motion and manual-snapshot-expiry assertions are included in the committed browser replay.

The isolated **1.2.7 → 1.2.8** real package upgrade retained the company registry and loaded installed sharp and the supported Microsoft broker on macOS arm64. No-Git/Node bootstrap and strict network-policy replay are checked separately. The release pack gate caught unsynchronized bootstrap versions; both platform scripts now pin 1.2.8.

Three bounded, alternating small-body held-stream runs per version passed 16/64/128 concurrency and returned active work to zero. At 128 streams, the status-P95 median was **0.931 ms** for 1.2.7 and **1.262 ms** for the candidate on this host; individual runs varied in both directions. These small synthetic samples are not proof of a universal speedup or a precise regression estimate. The existing performance/resource gates passed.

The pack has **194 files / 527664 bytes**, 3048 bytes more than 1.2.7; dependencies are unchanged. Tarball SHA-256: `5867eeb4f83d05bd516c2a958dcddf551183d37e036b29635b0dfedebd2a8648`.

## Published delivery

- [CI 39530938311](https://github.com/DaleXiao/codex-copilot-dx/actions/runs/39530938311) passed **17/17 jobs** at source/tag commit `a92b15f57e872eb67eedee15db91c7de39f1ced7`: Windows/macOS/Linux, Node 22.15/24, strict npm installs/upgrades, no-Git/no-Node bootstrap, native prediction, official-client synthetic replay, 48 Chromium/WebKit cases and terminal behavior. An initial browser run timed out in an existing catalog-recovery assertion; the final commit passed the complete matrix with that assertion intact.
- [npm 1.2.8](https://www.npmjs.com/package/codex-copilot-dx/v/1.2.8) was published through [workflow 39531725258](https://github.com/DaleXiao/codex-copilot-dx/actions/runs/39531725258). The immutable-tag job reran the full release gate. Published tarball SHA-1 `d2165ea08254ad005684acbd3bc878dafbf85e96` matches the verified local package; publication succeeded with the `latest` tag.
- [GitHub v1.2.8](https://github.com/DaleXiao/codex-copilot-dx/releases/tag/v1.2.8) was published at `2026-10-21T02:15:37Z`. All five assets were downloaded fresh and matched local bytes, GitHub API SHA-256 digests and SHA256SUMS. All 194 packed file contents also matched the final source checkout.
- The configured company registry returned E404 for 1.2.8 after publication. Synchronization is unconfirmed; `ccdx update github` uses the available GitHub Release channel. Dependencies still use the configured registry.

The user's running installation and enterprise registry/proxy/certificate settings are preserved. Temporary browser engines, extracted baseline and release tooling are removed after delivery; release artifacts and receipts remain outside the checkout. The tag and published bytes remain immutable. No physical enterprise account or real model inference is claimed by these synthetic checks.
