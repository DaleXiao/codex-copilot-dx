# CCDX 0.9.3 verification report

Date: 2026-09-30. Baseline: `fd104d9` (0.9.2).

## Scope

- Recognize the nested Codex CLI binary in current trusted macOS Codex and
  ChatGPT App bundles, while retaining all earlier trusted paths and exact
  client-version matching.
- Expose `gpt-6.1-sol` in the versioned Codex App catalog only when the exact
  Copilot entry is enabled, selectable, OpenAI-owned, and Responses-capable.
  Prefer a client-provided entry. For a client missing it, derive one from the
  installed GPT-6 Sol schema and the OpenAI Codex public model definition at
  commit `ab84d71f5767e4a565ce81c2c426287cb48c7918`.
- Keep existing model entries and request routing unchanged. The observed
  Copilot catalog has no `gpt-6.1-sol-fast`, so CCDX does not advertise an
  independent Fast variant for 6.1 Sol.

## Verification

- Baseline `npm run verify` passed: 866 tests, offline HTTP smoke, benchmark
  gates, and npm package dry-run.
- Before the fix, the versioned model request returned 503 on this Mac because
  the installed binary path was missing from CCDX's trusted path list. The
  installed bundled catalog also lacked `gpt-6.1-sol`.
- Focused tests reproduce both gaps and cover eligible/ineligible Copilot
  records, future client precedence, reasoning-effort intersection, and
  preservation of unrelated catalog entries.
- `npm run verify` passed: 870 tests, offline HTTP smoke, benchmark gates, and
  npm package dry-run. `git diff --check` passed.
- The installed Codex CLI updated to 0.159.0 during verification. With that
  binary and the current Copilot model snapshot, an isolated versioned HTTP
  request returned 200 with 11 catalog models, including visible 6.1 Sol at
  Low through Max and no Fast. Compared with 0.9.2's merge, all 10 pre-existing
  model entries were unchanged; the new entry was the only addition.
- One minimal live 6.1 Sol Responses request through the already-running
  adapter completed with HTTP 200 and a message output. Request routing was
  not changed in this release.
- The new complete client-compatible entry adds about 80.5 kB to the local
  model-list response. In a 40-iteration, in-process comparison on this Mac,
  median merge-and-serialize time was 1.31 ms before and 1.51 ms after. This
  is a local observation, not a cross-device performance guarantee.
- The user's running adapter and Codex App were not restarted for this test;
  the visible picker must refresh after installing and starting this release.

## Publication

- Release commit/tag: `e857ce2` / `v0.9.3`.
- GitHub CI passed on Node 22.15.0 and 24.x:
  https://github.com/DaleXiao/codex-copilot-dx/actions/runs/36654878488.
- GitHub Release: https://github.com/DaleXiao/codex-copilot-dx/releases/tag/v0.9.3.
- The one-shot npm workflow passed, including `prepublishOnly` verification:
  https://github.com/DaleXiao/codex-copilot-dx/actions/runs/36655168606.
  Its official-registry receipt reports `codex-copilot-dx@0.9.3` under
  `latest`, 99 files, 258.5 kB, and SHA-1
  `cef1fab93020f80fc19241990996d0d7c3cc5da5`, matching the local pack
  preflight. Publication was not repeated.
- This machine's independent official-registry lookup returned `ENOTCONN`;
  the successful workflow receipt is the available npm evidence.
