# 1.2.1 verification record

2026-10-17. Patch release from 1.2.0. No live inference or user-profile modification was used for these checks.

## Changes

- GitHub updates download the exact stable Release tarball, verify SHA-256 and packed identity/version, then use the existing npm registry for dependencies. Git is unnecessary.
- Platform bootstrap scripts reuse compatible Node/npm or download pinned official Node 24.22.0 into a CCDX-owned prefix. No Git, compiler, Build Tools or system package manager is installed. Native components use prebuilt packages.
- A discovered installation's package and commands are backed up, verified after installation and restored on ordinary installation/runtime-check failure. Private runtime commands survive subsequent updates.
- The dashboard preserves its original stylesheet, palette, monospace type, borders, logo and motion. Codex/Claude navigation is indented; source/model and Auto Review settings live under Codex; M365 lifecycle stays under Model sources. Usage and Requests have separate views. Related controls align at 36px. Initial M365 setup saves initial review choices; subsequent conversation-model saves preserve the saved review settings.
- WebUI remains bilingual. CLI remains English. Copy is no longer mechanically limited by character count.
- sharp is pinned to 0.35.5 and smol-toml to 1.9.1. The native broker remains 0.20.6. smol-toml's null-prototype tables are retained, including exact legacy prediction ownership checks.

## Verification

Final code candidate: `03e63a84a02269db5694eb45d6b4d7dd0056823c`.
CI: [cross-platform run](https://github.com/DaleXiao/codex-copilot-dx/actions/runs/39013585620).

| Check | Result |
| --- | --- |
| Local full verify | 1376 passed, 9 platform skips, 0 failures; offline smoke, performance gates and package checks passed |
| Windows/macOS/Linux Node 22.15/24, npm 12, real client replays | 17/17 CI jobs passed |
| No-Git / no-Node bootstrap | Linux/macOS/Windows; Windows PowerShell 5.1 and 7, legacy code page, Unicode/space/ampersand/exclamation paths, native modules, corrupt-download retention |
| Company registry | Local installs kept the configured Microsoft mirror; public npm was not substituted locally |
| Strict download policy | 8 registry/CDN combinations per CI platform, one installer attempt; refusal/corrupt dependencies preserved prior package |
| Release network | Real CONNECT proxy/private-CA loopback replay; strict TLS and offline mode retained, no registry token forwarded, no automatic retries |
| Browser | Chromium/WebKit, English/Chinese, dark/light, 420/1280px; model selection retention, separate saves, logo/motion and lazy data reads |
| Terminal | xterm, 40/80/120 columns, 16/24 rows, color/no-color, 200 frames and resize |
| Protocol comparison | 13 same-input cases matched 1.2.0, including streaming, images, review, priority, custom tools, compact and replay |
| Package lifecycle | 1.2.0 to 1.2.1 in an isolated prefix; installed version, sharp and supported native broker verified |
| Dependency audit | 0 reported vulnerabilities after the two direct dependency updates, at verification time |

Same-host synthetic performance, four interleaved pairs with independently installed baseline dependencies:

| Measure | 1.2.0 | 1.2.1 candidate |
| --- | ---: | ---: |
| Requests/s, median | 3650.615 | 3607.129 |
| p50 ms | 1.791 | 1.838 |
| p95 ms | 2.896 | 2.879 |
| Heap MiB | 19.698 | 19.732 |
| RSS MiB | 140.992 | 141.258 |

The small mixed changes do not establish a universal speedup or slowdown. No inference path was redesigned. Held-stream replay reached 128 active requests; management p95 was 0.750ms and active requests returned to zero after cancellation. This is synthetic local evidence, not an upstream SLA.

## Delivery boundaries

The package is 480638 bytes and contains 180 files. SHA-256:
`b19d1a91cc70b8efbbf3e834e24a7fa31fef1411df6b537c7f36ff2545550265`.
It adds no production dependency or additional platform-native launcher. Platform scripts/helper and the package have a Release SHA256SUMS file. Checksums are obtained from the same HTTPS release, not a separate signature.

Downloads still require approved network access. Dependencies still need the configured npm registry/cache; this is not a fully offline bundle. Windows/macOS ARM/x64 and Linux ARM/x64 runtime archive selection is pinned; actual host execution is limited to the CI/local host architectures, not every physical device. Linux musl can reuse a compatible existing Node; the private bootstrap does not add libc.

Windows PowerShell expands `%` in batch filenames before launching CCDX. The bootstrap refuses a prefix containing `%` before modifying that prefix; use an explicitly chosen writable `npm_config_prefix` without `%`. This is tested as an expected failure, not reported as successful support. Normal Unicode, spaces, `&` and `!` are tested.

PATH, shell policy, company routing, certificates and persistent npm permissions are not changed. The installer prints the command path. A running service keeps its loaded code until restarted. Error rollback does not promise power-loss atomicity; a failed restore retains its backup and lock for recovery. Auth, entitlement, model listing and inference success remain separate facts.

Security references: [sharp libheif](https://github.com/advisories/GHSA-rgj7-g3m4-5g8c), [sharp librsvg](https://github.com/advisories/GHSA-wq5f-xc86-pv6w), [smol-toml parsing](https://github.com/advisories/GHSA-r4xh-jqrq-34v2).
