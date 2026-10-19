# 1.2.5 usage charts and approximate cache hit rate

2026-10-19. Patch release from 1.2.4. Existing themes, layout, defaults, source routing and installation policy are preserved.

## Changes

- Usage keeps Bar chart as the default and adds a Line chart dropdown. Both views share retained data, input/output series, scale, 7/30/90-day ranges, source/model filters and accessible date buttons. Switching views makes no extra request or log scan and leaves the calendar intact.
- Visible bars rise from the baseline over 450 ms; curves draw left to right over 600 ms. Curves pass through known daily values without overshooting adjacent values, break at unavailable history and render a lone known day as a point. Hidden/collapsed pages and reduced-motion preferences stop active motion. Unsupported animation APIs retain static charts. Unchanged background refreshes and date selection do not replay the entrance.
- Overview shows the current process's approximate cache hit rate: recorded reused input tokens divided by input tokens, weighted by tokens. Explicit zero remains zero; unknown, invalid and zero-input data show `—`; mixed missing cache evidence prefixes the recorded aggregate rate with `~`. Missing output alone does not invalidate input/cache evidence. This is recorded input reuse, not a request success ratio or billing statistic.
- Chart geometry and animation remain in the existing dashboard usage module. Runtime counters reuse cache-evidence validation; no chart library, runtime dependency, persistence schema, polling loop or model call is added.

## Verification scope

Focused tests cover weighted/zero/unknown/partial/invalid cache evidence, formatting, view switching without reads, calendar retention, curve gaps, singleton points, viewport/reduced-motion cancellation and unchanged-refresh behavior. The feature implementation passed 71 focused tests and all 32 Chromium/WebKit replay combinations (English/Chinese, green/Klein, light/dark, 420/1280px), using synthetic data and zero real provider calls. A separate read-only preview showed both views using retained local usage; it did not change settings or call a model.

The final local `npm run verify` passed: 1,409 tests, 9 platform/optional skips, zero failures; offline HTTP smoke, SSE idle replay, performance/resource gates and package checks passed. The isolated 1.2.4 → 1.2.5 upgrade used the previously byte-verified tarball and existing company registry; sharp and the supported native broker loaded on macOS arm64. Synthetic held-stream replay passed 16/64/128 concurrency and returned active work to zero; status P95 was 1.382 ms with 128 held streams. This does not establish universal live-provider performance.

The release pack contains 185 files / 503162 bytes, 2940 bytes more than 1.2.4, with unchanged runtime dependencies and no install hook. Tarball SHA-256: `3e6fe0ebea5b00b0323b64bdf9a80ba0aa08587e806d6cbfef4fcd3e9f6deddd`.

## Published delivery

- [CI 39209429228](https://github.com/DaleXiao/codex-copilot-dx/actions/runs/39209429228) passed **17/17 jobs** at release source/tag `1c8fffb337973e38b67a9bf163289dd18f4a37f3`: Windows/macOS/Linux, Node 22.15/24, strict npm 12 install/upgrade, no-Git/no-Node bootstrap, Windows updater/prediction, official-client synthetic replays, Chromium/WebKit and terminal behavior.
- [npm 1.2.5](https://www.npmjs.com/package/codex-copilot-dx/v/1.2.5) was published through [workflow 39210024269](https://github.com/DaleXiao/codex-copilot-dx/actions/runs/39210024269). The immutable-tag workflow reran the complete release gate. Its tarball SHA-1 `58519895f95f0c34474f6e753424a3254cd70ac6` matches the locally verified artifact.
- [GitHub v1.2.5](https://github.com/DaleXiao/codex-copilot-dx/releases/tag/v1.2.5) was published at `2026-10-19T06:27:15Z`. All five assets were downloaded fresh and matched local bytes, GitHub API SHA-256 digests and SHA256SUMS.
- The configured company registry returned E404 for 1.2.5 after publication; mirror synchronization remains unconfirmed. The GitHub Release channel is available; dependencies still use the configured registry.

Local/synthetic/CI checks do not establish every physical enterprise device, network or live-model entitlement. Existing registry/proxy/CA/npm policy and the user's running installation are preserved. The temporary preview service and release credential helper are removed after delivery; verified release artifacts and receipts remain outside the checkout. This publication-record follow-up changes only this report; the tag and published bytes remain unchanged.
