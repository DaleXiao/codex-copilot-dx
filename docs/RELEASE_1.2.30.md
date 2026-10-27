# CCDX 1.2.30

## Changes

- GitHub directory reads in Model sources publish into the running model registry
  used by Codex candidates, endpoint routing and caches. New upstream models do
  not need a name whitelist. The UI refreshes candidates without discarding drafts.
- Catalog browsing never writes client configuration or changes selected models,
  defaults, grants or native sign-in. Failed reads retain the last-good directory
  and remain errors; account changes during a read prevent stale publication.
- A confirmed npm `EALLOWREMOTE` during a GitHub update restores the first
  installation, then permits one verified same-version platform-complete package
  attempt with offline dependency resolution and scripts disabled. Integrity,
  permission and other failures are not retried. npm-source updates keep their
  selected source. No registry, CA, proxy or persistent permission is changed.
- Nightly updates use the same complete-package validation in the candidate
  preparation phase, retaining existing idle/handoff/rollback checks and opt-in.
- Complete assets cover macOS/Windows ARM64/x64 and Linux ARM64/x64 glibc/musl.
  The normal npm/GitHub source tarball remains lightweight. The current bootstrap
  prefers a manifest-listed complete asset; old source-only releases keep the
  registry path. An old updater does not acquire new fallback behavior until
  updated; a blocked old installation can use the current verified bootstrap.

## Verification

- Candidate CI [40525998618](https://github.com/DaleXiao/codex-copilot-dx/actions/runs/40525998618) and merged main CI [40529199731](https://github.com/DaleXiao/codex-copilot-dx/actions/runs/40529199731) passed all25 jobs each, including eight native complete-package offline installs under exact npm12.0.1 with supported Node24.
- Local `npm run verify`:1,664 tests,1,654 passed,10 skipped,0 failed; smoke, stream and performance budgets, and package manifest passed. Chromium/WebKit completed48 dashboard and12 source/client cases.
- Native Codex five-state auth/first-list/old-session replay, service handoff/outage/rollback replay, and isolated upgrade from the SHA-256-verified official1.2.29 tarball passed. Native image processing and supported Broker loading remained available.
- A real npm12 nightly prepare/apply/rollback replay recovered from a synthetic cross-origin registry refusal using the genuine complete package. Initial refusal never touched the old installed runtime, final installation made no registry requests, and saved policy/config bytes stayed unchanged. The local npm12 harness used Node22.20 below npm12's engine range; supported Node24 qualification comes from the platform CI above.
- Initial Windows CI exposed two incomplete new test fixtures: Unix-only argv expectations, then missing synthetic Windows command files. Both were corrected without weakening production checks; the failing runs remain recorded. A subsequent compatibility check preserved the source bootstrap path for platforms without a complete package.

The verification-report tag commit changes this document only. Runtime, dependency, workflow and test files match the main-CI-tested4fc42b7e6e430dcabb766706a49fb6f66daebba0 tree. The tagged publish workflow repeats verification and builds all eight complete targets before npm publication. Final public npm/GitHub artifact receipts are attached to the [Release](https://github.com/DaleXiao/codex-copilot-dx/releases/tag/v1.2.30).

## Complete platform package sizes

These are the main-CI-qualified assets. The standard npm/source package remains approximately662KiB. Exact published bytes and SHA-256 values are in `SHA256SUMS`.

| Target | Compressed MiB | Unpacked MiB |
|---|---:|---:|
| darwin-arm64 | 11.05 | 28.29 |
| darwin-x64 | 11.83 | 30.52 |
| linux-arm64-glibc | 17.45 | 39.65 |
| linux-arm64-musl | 17.45 | 39.65 |
| linux-x64-glibc | 22.68 | 57.45 |
| linux-x64-musl | 22.68 | 57.45 |
| win32-arm64 | 9.90 | 23.43 |
| win32-x64 | 10.61 | 25.78 |

Complete packages use prebuilt dependencies from the lock; no compiler or Git is installed. Developer release assembly collects all eight `complete-*` artifacts from the same verified CI run, places their `.tgz` files beside the source artifact and reruns `release:pack` to generate one checksum manifest. All complete assets and the standard installer helpers must accompany the GitHub Release.

## Boundaries

No real model inference, user sign-in replacement or current-service restart was part of these checks. M365 admission/model-count differences remain separate investigations; this release does not infer a cause or alter Microsoft authorization policy. An old1.2.29 updater cannot run new fallback code before it is updated; use the current verified bootstrap once when the old path is blocked. Other errors and unavailable complete packages stop safely.
