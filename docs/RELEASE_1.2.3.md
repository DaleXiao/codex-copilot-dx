# 1.2.3 company-account selection verification

2026-10-19. Patch release from 1.2.2. This report separates local/synthetic checks from real enterprise authorization and inference.

## Changes

- Keep existing M365 bindings, including legacy bindings. With no binding, prefer a unique exact Windows system UPN match among discovered company accounts, then a single company account; otherwise require selection. Device enrollment identity, environment usernames, email suffixes and account order never select an account.
- Add local-only `ccdx m365 accounts`, explicit `ccdx m365 account [--id ID]`, and bilingual company-account controls under Model sources → Microsoft 365. Keep the existing colors, sidebar and control sizing. CLI remains English.
- Discover/deduplicate stable account/tenant records without token requests. Selection authorizes only the chosen account and reads its catalog before committing. Active work, stale IDs, invalid types, authorization/catalog failure and failed binding writes preserve the previous connection. Saved model choices and the selected Codex source are not silently replaced.
- Persist bounded hashed conversation ownership and refuse history transfer between company accounts. Known foreign conversations and unknown old history after an account change require a new conversation. Native session IDs are preferred; clients without them can collide on identical first user items. The ownership limit is 1024 records; evicted/unrecognized old history fails closed after a switch.
- Preserve existing silent authentication, proxy/CA/PAC policy, GitHub credentials, native prediction, image setup, no-Git Release installation and dependency versions. Tokens remain memory-only. The account helper opens no interactive Microsoft login UI.
- Reconcile README, reference, architecture and copy inventories. The pre-existing banner test now explicitly selects green instead of depending on the developer's saved theme; product theme behavior is unchanged.

## Local verification

- Final full release gate: 1396 passed, 9 platform/optional skips, 0 failures; offline smoke, idle replay, resource/performance gates and package manifest passed.
- Focused coverage includes exact Windows principal matching, local-login/Office discovery conditions, duplicate/conflicting identities, separate tenants, absent bindings, local-only listing, stale/invalid choices, failed authorization without account cycling, busy admission, save rollback, candidate cleanup and cross-account history rejection after restart.
- Isolated package lifecycle: verified 1.2.2 tarball → 1.2.3, using the existing company registry; installed sharp and supported broker loaded on macOS arm64. The user's global package and running service were not replaced by this check.
- Same-input protocol comparison: 13 scenarios matched 1.2.2 (native JSON/SSE, review, priority, images, custom tools, errors, compaction and replay), with no live model requests.
- Synthetic held streams: 16/64/128 concurrency; status P95 at 128 was 0.786 ms; active work returned to zero.
- Xterm: 24 palette/color/size combinations, 200 frames plus resize; existing terminal table and animation passed.
- One native macOS account discovery found one account and matched the existing binding; zero token requests and zero model requests. This does not verify Windows Entra/Office behavior.
- Browser verification and cross-platform CI receipts are recorded before publication below.

The original baseline test run was constrained by the local sandbox. An isolated baseline rerun passed 1381 tests, with one pre-existing banner-test failure caused by this machine's saved blue theme and 9 skips. The candidate fixes that test's isolation; baseline product source remained 1.2.2 for comparison. The initial candidate gate found a documented placeholder rejected by the strict account parser and a README exceeding the existing line budget; the example and copy were corrected without weakening either check.

One bounded review fixed account-control timing while settings are read, strict account-ID types, atomic binding rollback and CLI selection deadlines. No open-ended optimization loop was added.

## Same-host synthetic comparison

Four interleaved pairs, after browser and install load ended:

| Measure | 1.2.2 | 1.2.3 |
| --- | ---: | ---: |
| Requests/s | 3633.909 | 3774.083 |
| P50 ms | 1.770 | 1.744 |
| P95 ms | 2.879 | 2.767 |
| Heap MiB | 19.747 | 19.772 |
| RSS MiB | 142.703 | 141.305 |

Throughput was +3.86% in this synthetic loopback comparison. These measurements do not establish universal upstream latency improvement or zero timing variation. The existing performance gates passed; new account ownership records add a bounded local write on first conversation association.

## Delivery boundaries

The package has 183 files / 494474 bytes, 7674 bytes more than 1.2.2, with no new dependency or install hook. Tarball SHA-256: `4e217b81e0a321652c165f92c156cce422616650a7c9192c95bb6057a5b6d614`.

The Windows native component does not expose an explicit current-OS-account flag. `whoami.exe /upn` is a bounded lookup of the process's Windows user principal, not a SID/object-ID mapping, an enrollment/compliance assertion or a guarantee of model entitlement. Local/hybrid/Entra environments where a reliable unique UPN is unavailable require a choice. Office sign-in must be visible to the broker. Real company policy, MFA, entitlement and physical enterprise device behavior are not established by synthetic CI.

Company registry/proxy/certificate/npm policy, system sign-in, GitHub credentials and the user's running installation remain unchanged. Browser tools and temporary credentials/helpers are removed after delivery; evidence and release artifacts are retained separately.
