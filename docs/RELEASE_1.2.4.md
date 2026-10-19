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

The final isolated 1.2.3 → 1.2.4 upgrade used the verified prior tarball and existing company registry; installed sharp and the supported native broker loaded on macOS arm64. Synthetic held-stream replay passed 16/64/128 concurrency and recovered active work to zero; status P95 was 1.043 ms at 128 held streams. This does not establish universal live-provider performance.

## Published delivery

- [CI 39195012131](https://github.com/DaleXiao/codex-copilot-dx/actions/runs/39195012131) passed **17/17 jobs** at tag/source `6ce5fa21684161fc755b17e6766f8eef11ec72ef`: Windows/macOS/Linux, Node 22.15/24, strict npm 12 installation/updates, no-Git/no-Node bootstrap, Windows updater/prediction, official-client synthetic replays, Chromium/WebKit and terminal behavior.
- [npm 1.2.4](https://www.npmjs.com/package/codex-copilot-dx/v/1.2.4) was published through [workflow 39195482952](https://github.com/DaleXiao/codex-copilot-dx/actions/runs/39195482952). The workflow reran the complete release gate at the immutable tag. Its tarball SHA-1 `80f277977f83f5e3c7ffa785d6ea124608f43c2f` matches the locally verified artifact.
- [GitHub v1.2.4](https://github.com/DaleXiao/codex-copilot-dx/releases/tag/v1.2.4) was published at `2026-10-19T03:36:21Z`. All five assets were downloaded fresh and matched local bytes, SHA256SUMS and GitHub API SHA-256 digests. The real version-information query then reported 1.2.4 and this exact publication timestamp for both current/latest.
- The npm tarball has **185 files / 500222 bytes**, 5748 bytes more than 1.2.3, with no new dependency or install hook. SHA-256: `d6fdd4a4bb693efbd7ac05007a0bba366c181552b1af0ea63459c5f14ada172b`.
- The configured company registry returned E404 for 1.2.4 at `2026-10-19T03:39:06Z`; mirror synchronization is not confirmed. The GitHub Release channel is available, with dependencies still using the configured registry.

Synthetic/local/CI checks do not prove every enterprise network, physical Windows device or live-model entitlement. Company mirror synchronization is independent of publication; configured registry/proxy/CA/npm policy and the user's running installation are preserved. Temporary test tools, private browser engines and credential helper are removed after delivery; release artifacts and bounded verification evidence are retained outside the checkout. This report is a documentation-only follow-up; the release tag and published bytes are unchanged.
