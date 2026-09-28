# CCDX 0.8.9 verification report

Date: 2026-09-28. Baseline: `e70551a` (0.8.8).

## Scope

- Add a browser-local day/night switch to the existing terminal dashboard. Dark
  remains the default and shows a sun SVG; light shows a moon SVG.
- Apply a saved light preference before loading the stylesheet to avoid a dark
  flash. Storage failure leaves the page usable without changing server state.
- Keep the existing dashboard routes, inference paths, model tables, usage,
  animation settings, and no-background-polling behavior unchanged.

## Verification

- Baseline: 851 unit tests passed. Initial HTTP smoke attempt was denied by
  the local sandbox's loopback bind policy; the same smoke passed with local
  bind permission.
- Theme and dashboard route tests verify icon mapping, persistence, storage
  failure, loopback-only asset serving, and unchanged inference counters.
- Browser preview verified both themes and persistence after reload. The
  terminal-style layout and dashboard data sections remained visible.
- `npm run verify` passed: 854 unit tests, offline HTTP smoke, benchmark gates,
  and npm package dry-run. The package has 98 files and SHA-1
  `78734bd2f99e67370dc5107af0319fc25307bfcb`.

The benchmark gates verify no detected performance regression in the existing
probes; they do not claim a speed improvement. The extra script runs only when
the dashboard is opened, with no new background work or inference-path code.

## Publication

- Release commit/tag: `165a864` / `v0.8.9`.
- GitHub CI passed on Node 22.15.0 and 24.x, including configuration startup
  replay: https://github.com/DaleXiao/codex-copilot-dx/actions/runs/36379076228.
- GitHub Release: https://github.com/DaleXiao/codex-copilot-dx/releases/tag/v0.8.9.
- The one-shot npm workflow passed, including `prepublishOnly` verification:
  https://github.com/DaleXiao/codex-copilot-dx/actions/runs/36379183542.
- npm accepted `codex-copilot-dx@0.8.9` under `latest`. The publish receipt's
  SHA-1 `78734bd2f99e67370dc5107af0319fc25307bfcb`, 98 files, and 256.0 kB
  package match the local dry-run. Publication was not repeated.
- Post-publish reads from the configured Microsoft npm mirror still returned
  404 during its synchronization window; a direct local read from the official
  npm registry failed with `ENOTCONN`. The successful publish receipt is the
  available publication evidence, not an independent download check.
