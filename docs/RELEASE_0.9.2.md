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
