# CCDX 1.2.26

This patch updates the Microsoft 365 service origin, adds settings-page automatic
saving and a bounded restore backup, and reduces dashboard status/rendering work.
Other WebUI modules retain their existing layout, controls and interaction rules.

## Changes

- M365 uses `https://loki.delve.office.com/api/v1/llmapi` with the existing company
  account/resource and native protocols. Node and Windows target policies name
  the same fixed host. There is no 403-triggered environment/source fallback.
  Catalog caches and replay namespaces are account-and-origin bound. Legacy and
  old-environment cache files stay on disk but do not publish as the new live
  directory; successful discovery replaces the cache. Paused sources, grants,
  selected models, native sign-in and client configuration remain unchanged.
- Settings adds Save & restore immediately after Version & updates. Automatic
  saving defaults on for this page's preferences. Manual mode keeps drafts until
  Save/Discard; enabling automatic saving with a draft asks first. Failed writes
  retain input, old reads cannot overwrite a completed write, and conflicts offer
  a route to discard/reload. Ordinary preference changes do not refresh accounts
  or model catalogs. Browser appearance stays browser-local.
- Restore defaults confirms its scope, backs up only the six allowlisted service
  preferences, then commits the reset under the existing lock/file-pair boundary.
  A failed commit restores prior settings and prior backup. A repeated operation
  ID cannot replace the original pre-reset snapshot after a lost response.
  Restore backup returns to that latest snapshot. Browser-local appearance backup
  is tied to the same ID; partial browser-storage failure is reported truthfully.
  Accounts/keys, model/source selections, app routing, review/memory choices,
  image/prediction access, history/usage and enterprise network policy are not reset.
- `/_ccdx/status` keeps its full default contract. Overview and Settings opt into
  `?scope=summary`, containing service identity, uptime, activity and current-run
  usage. The browser holds full and summary data in separate resources; a summary
  cannot erase request details or imply zero values. Hidden regions defer DOM
  work. The existing flow geometry, animation layers, palettes and accessibility
  behavior remain unchanged; no new runtime dependency or polling loop is added.
- Regression coverage includes an explicit memory model during an in-flight
  source switch, revision conflicts, backup rollback, browser save/retry/manual
  flows, pre-reset backup recovery, blocked browser storage and stale reads.

## Upstream references and boundaries

[Magpie 8bc72bf](https://github.com/yetone/magpie/commit/8bc72bf10a6b284d69e62da52d268bd05fa71d48)
informs reducing unchanged payload/render work. CCDX does not import its row-delta
protocol or Go memory-release mechanism.
[Magpie b7d5a97](https://github.com/yetone/magpie/commit/b7d5a97feceb194ec1a4453e91d7cac1299a0e5e)
informs the memory/source-switch regression, without adopting implicit model substitution.
[CC Switch 42ef634](https://github.com/farion1231/cc-switch/commit/42ef63471f0ed879913f8de0d0c7e3e580293193)
informs layout checks;
[5cc6c47](https://github.com/farion1231/cc-switch/commit/5cc6c47fc1d92069d6b37fa01e62dfecd1cf9544)
and its current backup implementation inform targeted invalidation and recovery.
Floway remains at the previously reviewed `3919a92`; its configuration-bound
refresh principle extends to the M365 origin boundary. No masking subsystem,
intent router, client-account migration or frontend framework is introduced.

## Verification

Local full verification passed 1,629 tests: 1,619 passed, ten platform/optional
skips and zero failures, followed by HTTP/SSE smoke, performance budgets and pack
checks. Native Codex passed the five isolated startup/cache states, complete
first-read catalogs, ChatGPT auth and old-session resume against synthetic providers.
Service handoff/outage/rollback preserved config/auth, complete first lists and old
response IDs. The 48 Chromium/WebKit dashboard cases, twelve connection-editor
cases and two additional blocked-storage/stale-read cases passed. The current
candidate also read the production M365 catalog once (HTTP 200, fifteen models),
without persistence or inference. These checks do not log in or restart the user's actual App.

The preceding bounded origin investigation returned fifteen models. Real CCDX
relay probes completed one Claude Messages stream and one GPT Responses stream;
these were separate minimal calls and do not establish every model/capability or
native enterprise Windows account access. Release regression runs use synthetic
providers and make no paid inference calls. Exact-commit CI, browser, installation
and publication receipts are recorded with the release. Company registry, proxy,
certificates and the existing user service are preserved.
