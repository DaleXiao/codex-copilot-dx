# CCDX 0.9.2 verification report

Date: 2026-09-28. Baseline: `8f450a8` (0.9.1).

## Scope

- Show the running adapter's raw and decoded per-request body limits in the
  Requests card. These are active caps, not a cumulative usage meter.
- Keep the existing in-memory Responses history usage meter and label its
  displayed limit as active. Configuration and cleanup remain CLI-only.
- Reuse the existing local status snapshot; no new endpoint, polling, or
  request/cache behavior was added.

## Verification

- Baseline dashboard/API tests passed (20 cases), and the baseline benchmark
  gates passed before editing.
- Focused dashboard/API tests passed (21 cases). A real loopback render at a
  two-column viewport exposed a wrapped unit; the copy was adjusted and the
  resulting layout was checked again.
- Full `npm run verify` passed: 866 tests, offline HTTP smoke, benchmark gates,
  and npm package dry-run (99 package entries). `git diff --check` passed.
- No server-side request, cache, or status code changed. The performance gates
  found no detected regression; they are not a claim of a speed improvement.

## Publication

- Release commit/tag: `01699f2` / `v0.9.2`.
- GitHub CI passed on Node 22.15.0 and 24.x:
  https://github.com/DaleXiao/codex-copilot-dx/actions/runs/36430186898.
- GitHub Release: https://github.com/DaleXiao/codex-copilot-dx/releases/tag/v0.9.2.
- The one-shot npm workflow passed, including its `prepublishOnly` verification:
  https://github.com/DaleXiao/codex-copilot-dx/actions/runs/36430404734.
  Its registry receipt reports `codex-copilot-dx@0.9.2` under `latest`, 99 files,
  a 258.2 kB package, and SHA-1 `6fa56609411c6da65c43c47cf0ef65def3b0de1d`.
- This machine's independent official-registry lookup returned `ENOTCONN`; the
  successful publish receipt is the available npm evidence. Publication was
  not repeated.
