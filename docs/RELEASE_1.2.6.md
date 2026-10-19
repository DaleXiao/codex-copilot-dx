# 1.2.6 system proxy exceptions and precise network diagnostics

2026-10-19. Patch release from 1.2.5. This release fixes the confirmed macOS M365 startup failure caused by the system exception `169.254/16`; it does not change Windows Claude setup, the visual design, model routing, credentials or enterprise network policy.

## Changes

- Normalize unambiguous abbreviated IPv4 CIDRs only in system `ExceptionsList` input, including `169.254/16`, `10/8`, `172.16/12` and `192.168.1/24`. Missing octets become zero only when the supplied octets cover the prefix. Invalid octets, ambiguous leading zeros, underspecified prefixes and malformed entries remain errors. Strict user `NO_PROXY` syntax is unchanged.
- Keep the existing shared strict Node/PAC matcher and its IP-literal-only CIDR semantics. No DNS lookup, global proxy mutation, company-route bypass or probe is added. The system-input fix also covers the existing prediction environment path.
- Retain M365's existing outer proxy/network error categories and add a bounded fixed-code `network_diagnostic` with source, stage and cause. Distinguish failed system discovery, unsupported PAC/WPAD, invalid exceptions, invalid static settings and invalid/unsupported proxy addresses. Unknown causes remain generic.
- CLI and startup show the fixed English network explanation, without suggesting a new company sign-in for a known proxy-setup failure. Existing WebUI source status and model-check details show bilingual explanations; technical codes remain in details. Language switching re-translates those explanations without a new provider request. Raw errors, settings, proxy URLs and credentials are not projected.
- A catalog failure remains a failure, with last-good data retained. GitHub is not replaced when M365 is unavailable. Successful transport creation clears the old setup diagnostic; later unrelated refresh failures cannot retain a stale proxy explanation. No source failover, inference retry, new storage, dependency or polling loop is added.

## Design references

The authorized source review fixed these 2026-10-19 default-branch snapshots. These are reviewed mechanisms, not a claim that a third-party release or implementation was copied or validated on every environment:

- [Magpie system proxy input](https://github.com/yetone/magpie/blob/33dbdcc529622cf0dd053c99eb34f51c06fbba77/internal/netproxy/scutil.go): distinguish OS input and effective routing. CCDX retains its stricter shared CIDR matcher rather than copying Magpie's matcher or its no-proxy exception discard.
- [Floway per-source proxy failures](https://github.com/Menci/Floway/blob/516441b20ce3f26f14fa6ce34dce71c721bb9b4f/packages/gateway/src/dial/per-request.ts): keep malformed source routes isolated and do not silently replace them with direct routing. CCDX's existing isolation is verified with a real provider-runtime regression.
- [cc-switch cause chains without credential URLs](https://github.com/farion1231/cc-switch/blob/a94f997f1e2823fa7397c6773d80dc44b7ccd86b/src-tauri/src/proxy/error.rs): preserve the actionable cause while excluding secrets. CCDX uses fixed allowlisted codes rather than serializing raw nested exceptions.

Magpie's repeated-parse/catalog-cache optimizations and broader dynamic routing are deferred pending CCDX-specific measurements. Floway's latest successful empty-list behavior for unreachable upstreams is not adopted: CCDX continues to distinguish failed discovery from an empty successful catalog. Model-context policy, tool ordering, UI layout and Windows Claude detection are outside this patch.

## Verification

The failing case was reproduced before implementation with the user's exact abbreviated rule and no proxy-enable flags: `proxy_bypass_invalid` became `m365_proxy_settings_unsupported`. The complete four-octet form succeeded. Regression coverage now includes that dictionary, static-proxy input, multiple network prefixes and boundaries, ambiguous/invalid inputs, unchanged strict environment input, shared Node/PAC decisions without DNS, sanitized fixed causes, GitHub isolation, M365 recovery, API projection and CLI guidance.

One bounded review found an existing dashboard localization marker that replaced the structured last-good-list notice after a language change. The error state now clears that parent marker and lets the translated child notices survive; browser replay asserts the retained-list notice in both languages. The first full local suite also caught a timing race in the compression-startup test: it checked temporary probe cleanup while independent cold-start work was still finishing. The isolated test passed; its cleanup check now waits with the existing eight-second bound instead of assuming one process finishes before another. Production compression behavior is unchanged. The initial failure receipt is retained, followed by final verification.

Final local `npm run verify` passed: **1,416 tests, 9 platform/optional skips, zero failures**; offline HTTP smoke, SSE idle replay, performance/resource gates and package manifest checks passed. Chromium/WebKit passed all **32 cases**: English/Chinese, green/Klein, light/dark and 420/1280px. The cases cover readable network causes, technical details, language switching without losing last-good notices, catalog retention and recovery, plus existing chart/settings/account behavior. Xterm passed 24 terminal palette/color/size cases, including 200 frames and resize.

The isolated 1.2.5 → 1.2.6 upgrade retained the configured company registry and loaded installed sharp and the supported native broker on macOS arm64. Synthetic held-stream replay passed 16/64/128 concurrency with active work returning to zero; status P95 was 1.990 ms at 128 held streams. Timing varies by host/load and is not a universal upstream performance claim.

The release pack contains **186 files / 505904 bytes**, 2742 bytes more than 1.2.5, with unchanged runtime dependencies and no install hook. Tarball SHA-256: `bc2ee95c67cb16826afc56f097a4559d70add11d4b435fa038d12495d386cecc`.

Cross-platform CI and publication receipts are recorded after completion. No real model request is used for validation. A successful local parsing fix does not establish the affected account's model entitlement or verify the user's physical device; after upgrade/restart, one model-directory read on that machine remains the end-to-end confirmation.
