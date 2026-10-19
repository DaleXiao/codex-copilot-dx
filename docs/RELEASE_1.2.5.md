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

Cross-platform CI and publication receipts are recorded after completion. Local/synthetic/CI checks do not establish every physical enterprise device, network or live-model entitlement.
