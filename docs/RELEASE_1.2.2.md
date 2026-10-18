# 1.2.2 verification record

2026-10-18. Patch release from 1.2.1, following the requested patch-version policy. This report distinguishes synthetic/local verification from live provider access.

## Changes

- Add independent webpage and terminal color choices in Settings: Classic green (unchanged default) and Klein blue. Existing webpage dark/light selection and all nine terminal animation styles remain independent.
- Apply browser palette and atom favicon before CSS. Browser choices stay local; unavailable storage is labeled as tab-only. Same-origin tabs receive palette/mode updates.
- Save terminal color through the existing strict, locked atomic settings writer. A successful save updates the supported live table/animation; the startup logo uses the choice next launch. Read/save failure protects existing configuration and restores confirmed controls. Theme controls stay disabled during settings reads/saves.
- Add terminal colors only after width calculation and clipping. Truecolor, 256-color and ANSI blue are supported; NO_COLOR, dumb and redirected output retain plain behavior. Green retains the original logo and table colors. No extra settings read is added to animation frames.
- Model-list failures identify the selected source, preserve the prior successful list and timestamp, and offer bounded public check details. Retry timing appears only when an actual delay is supplied. Requests also identify their source; changing language retains nested translated status text.
- Preserve native routing/protocol semantics, source selection, capabilities, credentials, installation policy and dependencies. CLI stays English and WebUI bilingual. README, the offline reference, architecture notes and copy inventory describe the implemented behavior.

## Verification

Final code candidate: `e416c168742987fe6927be85d9f822c825ae7aee`.

| Check | Observed result |
| --- | --- |
| Final cross-platform CI | [17/17 passed](https://github.com/DaleXiao/codex-copilot-dx/actions/runs/39095335708): Windows/macOS/Linux, Node 22.15/24, strict npm 12, bootstrap/install/update, real clients, PAC/prediction and Chromium/WebKit |
| Local full verify | 1382 passed, 9 platform/optional skips, 0 failures; offline smoke, idle replay, performance gates and package checks passed |
| Local browser | 32 Chromium/WebKit cases: both palettes, dark/light, English/Chinese, 420/1280px; independent settings, failed-save rollback, language changes, retained user state, logo and reduced motion |
| Local terminal | 24 xterm cases: both palettes, color/no-color, 40/80/120 columns and 16/24 rows, 200 frames plus resize; no region scrolling or metric loss |
| Protocol comparison | 13 same-input scenarios matched 1.2.1: JSON, SSE, images, review, priority, Chat fallback, custom tools, errors, compaction and replay |
| Held streams | 16/64/128 held synthetic streams; status P95 at 128 was 1.459ms; active requests returned to zero |
| Local installation | Isolated 1.2.1 tarball → 1.2.2 installation with the configured company registry; installed sharp and supported native broker loaded on macOS arm64 |

The company registry did not contain the test script's historical 0.9.41 baseline. The local installation check used the previously verified 1.2.1 Release artifact instead; no public-registry fallback or registry change was made.

One bounded review repaired settings-read interaction timing and nested bilingual failure summaries. One CI browser execution stalled and was cancelled; the same 16 WebKit combinations passed locally. The replay now reports each case and has a Node-clock 120-second case watchdog plus a 10-minute CI job boundary; no product code was changed for that harness correction. The affected checks were rerun and the final code received the complete release gate; no open-ended optimization loop was added.

## Same-host synthetic performance

Four interleaved pairs after browser checks ended:

| Measure | 1.2.1 | 1.2.2 |
| --- | ---: | ---: |
| Requests/s | 3378.136 | 3328.401 |
| p50 ms | 1.930 | 1.954 |
| p95 ms | 3.197 | 3.092 |
| Heap MiB | 19.736 | 19.744 |
| RSS MiB | 140.375 | 139.820 |

An earlier run overlapping browser/installation work measured -4.53% throughput; it is retained in local evidence. The subsequent quieter paired run measured -1.47%, with lower P95 and mixed small changes. These results do not establish a universal speedup or zero timing variation; the existing performance gates passed and inference processing was unchanged.

## Design references

Reviewed mechanisms at pinned snapshots; no third-party implementation, UI framework or runtime dependency was copied:

- [Magpie theme initialization and semantic palettes](https://github.com/yetone/magpie/tree/d783df46cbac9021e26a6bd71ca0b55544552eb2/internal/gui/assets): apply appearance before paint and separate color roles.
- [cc-switch settings protection](https://github.com/farion1231/cc-switch/blob/73cdfbb742cecc31ec59e68bb55f9266e2c54cd1/src-tauri/src/settings.rs) and [effective-state notices](https://github.com/farion1231/cc-switch/blob/73cdfbb742cecc31ec59e68bb55f9266e2c54cd1/src/utils/routeSwitchNotification.ts): protect unreadable settings and state when a change takes effect.
- [Floway source-aware diagnostics](https://github.com/Menci/Floway/commit/7af7035f473dad43363db54333d76b434b7f939c): identify the affected source and present recovery evidence separately.

## Delivery limits

The package contains 181 files / 486800 bytes, 6162 bytes more than 1.2.1. Dependencies and install hooks are unchanged. The Release includes the same npm tarball, both platform bootstrap scripts, the standalone helper and SHA256SUMS.

Package SHA-256: `480c7eea0c140b4c65f4ddf1c77f43709288ea27adecdfdfc4384e4324ff4b93`.

Actual upstream entitlement, physical device/terminal palettes and visible native-client prediction remain outside synthetic test claims. The company registry, PATH, PAC/WPAD, certificates, npm policy, global CCDX installation and running user service were not replaced by local validation. Existing installation/platform limits in the reference remain.
