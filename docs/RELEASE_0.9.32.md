# CCDX 0.9.32: six bounded reliability and architecture improvements

## Scope

1. Explicit update/full-doctor diagnostics compare Node, npm, package location
   and npm's global target. Mismatch warns; PATH, prefix, company registry/proxy
   and the user's installation choice are not replaced. Windows retains the
   tested fixed `cmd.exe` launcher; POSIX retains direct npm argv.
2. Small local settings/credential/catalog reads have byte boundaries on one
   file descriptor. Oversized files stay untouched. Full doctor inspects POSIX
   mode bits or Windows allow entries without reading secrets or modifying ACLs.
   This is review evidence, not a complete Windows effective-access calculation.
3. Concurrent identical live model lookups share one active operation, with
   independent waiter cancellation and credential-generation isolation. Settled
   results are not served as live cache hits; returned objects are independent.
4. A separate bounded HTTP error ring reports status, source, safe technical
   codes and request IDs. Original HTTP bodies still reach Codex unchanged and
   are not retained in that ring. Existing model terminal counters are unchanged.
5. Authentication storage/discovery and device polling were extracted behind
   the existing public facade. Dashboard status and usage rendering have separate
   page-local owners. Core SSE/history state machines were not split or changed.
6. CI adds native macOS Node 22.15/24 and real isolated package lifecycle smoke
   on Linux/macOS/Windows. Direct sharp is pinned to the already-tested 0.35.3;
   no new runtime dependency was added.

README, reference and architecture documentation describe these exact limits
and ownership boundaries. Fast tier, auto-review, images, optional predictions,
LAN opt-in and existing default-off behavior retain their current policies.

## Bounded verification and review

Local baseline: 1,157 passing tests, zero failures, seven Windows-only skips.
Final candidate: 1,168 passing tests, zero failures, eight Windows-only skips.
Offline HTTP/idle-SSE, performance/resource and package-content gates passed.
Review corrections covered malformed error-code objects, unchanged HTTP error
bodies/counters, new static assets' loopback access restrictions, startup
preference conflicts, and portable POSIX/NTFS test expectations.
The first remote gate caught two Windows-only fixture errors (literal POSIX
rollback modes and inherited PowerShell 7 module lookup). Fixtures now compare
the actual pre-write modes and load the system PowerShell modules. Production
behavior and assertion strength were not changed to accommodate the failures.

Synthetic concurrent-model evidence: 12 overlapping lookups perform one
validation/catalog round instead of 12. Cancelling one waiter preserves another;
changing credentials starts separate work; a subsequent query is fresh. This
is a work-reduction result, not a claim about upstream inference latency.

Baseline and final candidate preserve the 8 MiB SSE scan ratio of 1.0, one parse
for repeated 8 MiB tool output, and one image optimization for eight duplicates.
Adapter import RSS is 58.3 MiB in both. Large-payload peak RSS deltas (MiB):

| Scenario | Baseline | Candidate |
| --- | ---: | ---: |
| 5 MiB x 4 | 105.5 | 103.7 |
| 30 MiB x 1 | 167.3 | 162.4 |
| 30 MiB x 2 | 220.6 | 227.4 |

An earlier candidate run measured 219.2 MiB for the last case. The final +3.1%
single-run difference remains within the existing resource gate; timings and GC
vary. No new speedup or universal zero-regression guarantee is inferred from
these samples. The concrete gains are fewer duplicate management requests,
bounded local reads, better failure evidence and smaller ownership modules.

Authentication facade: 810 -> 370 lines. Dashboard coordinator: 746 -> 409 lines.
Moved code remains in focused modules; total source reduction is not claimed.

Publication is gated on the candidate's complete remote CI, including Windows
actual-process updater and NTFS tests, macOS/Linux tests, installed sharp,
temporary-prefix 0.9.31 -> candidate upgrades, official Codex synthetic replay,
and bilingual/light-dark desktop/mobile Chromium/WebKit dashboard checks.
These are not live corporate-network or gray-candidate App UI proofs.

## Publication

Release receipts will be added after CI and GitHub/npm publication complete.
