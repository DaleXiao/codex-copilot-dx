# CCDX 0.8.11 verification report

Date: 2026-09-28. Baseline: `eb2641e` (0.8.10).

## Scope

- Add the approved transparent, single-color, 11-bar double-peak SVG favicon
  to the local dashboard.
- Color it from the dashboard's actual saved dark/light choice. The SVG is an
  encoded data URL under the existing `img-src data:` policy, so it adds no
  HTTP request, server route, or change to inference paths.

## Verification

- Browser preview confirmed the favicon link's SVG color matches the initial
  dark theme and updates immediately with the manual light-theme toggle.
- Theme tests cover both colors, the approved path, transparent background,
  persistence, and unavailable storage.
- `npm run verify` passed: 854 tests, offline HTTP smoke, benchmark gates, and
  package dry-run. The package contains 98 files, size 256,344 bytes, SHA-1
  `00fb635f30ce1ea1b585cf99ec0cf8172df7957e`.

## Publication

- Release commit/tag: `d60284d` / `v0.8.11`.
- GitHub CI passed on Node 22.15.0 and 24.x, including configuration startup
  replay: https://github.com/DaleXiao/codex-copilot-dx/actions/runs/36385555094.
- GitHub Release: https://github.com/DaleXiao/codex-copilot-dx/releases/tag/v0.8.11.
- The one-shot npm workflow passed, including `prepublishOnly` verification:
  https://github.com/DaleXiao/codex-copilot-dx/actions/runs/36385708175.
- npm accepted `codex-copilot-dx@0.8.11` under `latest`. The publish receipt's
  SHA-1 `00fb635f30ce1ea1b585cf99ec0cf8172df7957e`, 98 files, and 256.3 kB
  package match the local dry-run. Publication was not repeated.
- The configured Microsoft npm mirror still returned 404 immediately after
  publication; the official-registry publish receipt is the available
  publication evidence, not an independent download check from this machine.
