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

Publication results will be recorded after the GitHub and npm checks finish.
