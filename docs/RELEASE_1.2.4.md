# 1.2.4 navigation and update information

2026-10-19. Patch release from 1.2.3. This change preserves the existing green/Klein, light/dark, monospace and thin-border design.

## Changes

- Remove the duplicate sidebar Terminal appearance shortcut. Keep the complete controls under Settings and one separator above animation styles.
- List every discovered registered source in Overview, including disabled sources; keep the count consistent with that list. Remove client-to-source mapping arrows from the overview summary. Detailed account and application evidence stays separate.
- Add seven small, decorative inline SVG navigation icons that inherit the current theme. Keep Codex/Claude indentation and translated labels.
- Add Settings → Version & updates: running-service version, exact GitHub publication dates when available, newer stable releases, manual checks and copyable `ccdx update github` instructions.
- Add expandable macOS/Windows recovery commands for the existing version-pinned official Release installers. No Git, new runtime dependency, automatic installation, execution-policy bypass, registry change or permission exception is added.
- Load version discovery only through the protected dashboard route. Share concurrent checks, cache success for five minutes and failure for one minute, bound each metadata request to four seconds/128 KiB and retain explicitly labeled last-good data. Read npm network settings asynchronously to avoid blocking model streams. Page refresh reuses the existing visible-view 30-minute controller; the two-second status timer does not check releases. The separate startup web-redirect check is unchanged.

## Verification scope

Focused tests cover missing/older/newer metadata, concurrent/cache isolation, rate limiting, malformed/oversized data, stalled response deadlines, local-route protections, command injection refusal and shell syntax. Browser replay covers both languages, palettes and modes, navigation icons, complete source lists, a single animation rule, current/update/failure states and wrapped macOS/Windows commands. Existing settings, account selection, animation and client behavior remain in the same replay.

Local `npm run verify` passed: 1404 tests, 9 platform/optional skips, zero failures; offline HTTP smoke, SSE idle replay, performance/resource gates and package manifest passed. The initial README line-budget failure was corrected without dropping instructions. Browser replay passed all 32 Chromium/WebKit combinations: English/Chinese, green/Klein, dark/light and 420/1280px. It used synthetic local data and made zero real provider calls. Xterm passed all 24 color/palette/size cases, including 200 frames and resize.

One bounded review removed the shortcut's remaining event binding and used the existing captured `ADAPTER_VERSION` for update information. Reading package.json lazily after an installation could otherwise mistake a newly installed package for the still-running service. A real pre-publication metadata check confirmed that a local package can be newer than GitHub's latest Release; recovery commands therefore choose the newer known version and cannot recommend a downgrade. The command downloader also has finite connection/download limits. No open-ended optimization loop was added.

Release gates also include an isolated upgrade from the verified 1.2.3 tarball, current cross-platform CI and fresh Release-asset digest checks. CI and publication receipts are added after those gates complete. Synthetic/local checks do not prove every enterprise network, physical Windows device or live-model entitlement. Company mirror synchronization is independent of publication; configured registry/proxy/CA/npm policy and the user's running installation are preserved.
