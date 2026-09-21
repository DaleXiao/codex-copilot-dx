# CCDX 0.8.4 verification report

Date: 2026-09-21. Baseline: `7427789` (0.8.3).

## Scope

This release addresses the eight agreed audit items, with one bounded review
and corrections limited to these changes. It does not change model routing,
Fast, Auto-review model selection, encrypted-history recovery, compaction,
animation choices, image provider protocols, or the deliberate opt-in LAN API.

1. Downstream SSE backpressure now observes cancellation/deadlines. A client
   that never drains is closed after timeout; final error-frame drain waits
   have a separate one-second bound. No inference retry is added.
2. Interactive image setup rereads shared TOML after prompts/network checks
   and checks again before commit, preserving intervening unrelated edits and
   rejecting conflicting image declarations. Unchanged config/provider bytes
   are not replaced; private permissions are still enforced.
3. A blank image-key answer reuses the credential only for the same normalized
   origin. A different origin requires explicit key entry before networking.
4. Failure diagnostics and file logs redact common credential forms and
   labelled content echoes. Error codes, request IDs, retry diagnostics, and
   ordinary useful messages remain. Arbitrary prose cannot be fully classified;
   documentation no longer promises universal secret detection.
5. Model discovery keeps live-first semantics, but limits the upstream wait to
   1.5 seconds when a usable catalog exists. Uncached discovery retains its
   existing timeout. Received 401/403 responses are not hidden by the cache.
6. Usage and debug logs use asynchronous batched writes with per-record
   rotation semantics. Pending plus in-flight ceilings are 4096 records / 4 MiB
   for usage and 4096 records / 2 MiB for debug files. Overflow warns and counts
   dropped records without blocking inference. Usage retains its cross-process
   lock; shutdown flushes are bounded. Status exposes backlog/drop/failure counts.
7. Image MCP HTTP traffic has its own route bucket. Generation outcomes track
   success, failure, busy, cancellation, and delivery failure separately from
   HTTP 200 and input-image optimization. Status does not initialize images,
   read provider credentials, install guidance, or make provider requests.
8. README and CLI guidance describe these actual boundaries, including no-op
   writes, cache deadlines, diagnostic limitations, and overload behavior.

## IPv6 safety verification

Offline checks used Node's real literal-address resolver with an intercepted
HTTPS transport; no internal host was contacted. Equivalent loopback/mapped
IPv6 spellings passed the old string checks while dotted spellings were
rejected. The fix canonicalizes IPv6 before classification and decodes mapped
IPv4 before applying the existing IPv4 policy. Tests reject equivalent private
forms and retain public IPv4/IPv6 and pinned DNS behavior. Literal IPv6 URLs
also remove brackets before resolution.

This confirms and closes an address-validation gap, not a demonstrated
end-to-end DNS/TLS exploit against a real provider or internal service.

## Verification

- Regression cases cover a never-draining stream, concurrent config edits,
  conflicting declarations introduced during validation, unchanged file
  identities, same-origin key retention, cross-origin no-dispatch, diagnostic
  redaction, cached/uncached model deadlines and 401/403 handling, blocked-disk
  queue limits/recovery, rotation semantics, and tool-level image statistics.
- Bounded review caught and corrected a non-regular log-destination hazard:
  asynchronous rotation must reject a directory rather than rename it. The
  regression verifies its contents and path remain untouched.
- The nine-scenario real-CLI startup replay passed cold start/reuse/core GPT,
  including image config/write/Skill conflicts, malformed provider config,
  disabled and disabled-with-stale-image-state cases. Those startup cases
  make zero image MCP/provider requests. A pending/failing image operation
  still allows GPT before and after failure and dispatches only once.
- Installed Codex `0.155.0-alpha.9` offline replay passed discovery/reload,
  generation, two edits, final-chat image Markdown, zero-call redisplay, new
  tasks, and saved-task resume. Model responses and pixels were synthetic;
  no real generation, credentials, or active user configuration were used.
- Baseline and candidate performance/resource gates passed with equal native
  SSE parsing/copying/write counts, preserved content, no reads while
  backpressured, settled image work, and zero retained ArrayBuffer growth.
  Three alternating image-lifecycle comparisons (four concurrent requests,
  five warm samples per process) yielded warm medians of about 73.8 ms baseline
  and 74.2 ms candidate. Timings overlap and vary with host load; this is not
  a universal latency guarantee. Candidate import sample: 42.4 ms / 58.2 MiB RSS.

Final release gate on Node 22.20.0:

- `npm run verify`: **815 tests, zero failures**, offline HTTP smoke,
  performance/resource checks, and npm package dry-run passed.
- Extracted npm artifact reports `ccdx v0.8.4`, includes the new diagnostic
  module, and excludes tests, release scripts, logs, and temporary artifacts.
  Package size: 234,002 bytes / 89 entries.
  SHA-1: `979e9833138f292eba0951d85f0170aa8d86d1ef`.
- A local 2,000-record debug-log comparison retained all 2,000 records in both
  versions. Foreground logging time was approximately 54.6 ms baseline versus
  4.1 ms candidate (candidate drain completed at 5.5 ms). This is one local
  fixture measurement, not a production speed guarantee.

## Remaining boundaries

- Config checks are not a filesystem-wide transaction with external apps that
  do not share a lock. Core startup/image isolation from 0.8.3 is retained.
- Image generation stays explicit opt-in. Existing tool names, schemas,
  image bytes/IDs, helper single-save behavior, and no-automatic-retry semantics
  are retained. Redisplay does not generate or edit again.
- Finite diagnostic buffers may drop excess records under sustained storage
  failure/overload, with visible counters. They are not a billing ledger.
- Images saved for chat delivery remain user artifacts, not an automatically
  deleted disk cache. No Codex client modification is included.

These measurements and replay results are historical evidence for this
release, not a guarantee of every future upstream/client version.
