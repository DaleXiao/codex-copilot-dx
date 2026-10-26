# CCDX 1.2.23

This patch makes local model rejection and optional token-count failures
explainable, bounds repeated count work, and reduces flow rendering and hidden
page activity without changing native client sign-in or deployment selection.

## Changes

- Capture safe requested model/client evidence before model resolution. Report
  a fixed binding reason while keeping the existing error code and HTTP status.
  Never substitute a default or call another source on a resolution failure.
- Carry Claude evidence through the shared HTTP context: actual model/source,
  HTTP origin and logical upstream calls. Cached counts report zero calls;
  callers sharing count work are marked separately.
- For manual APIs, join identical concurrent token-count requests with
  independent cancellation. Sharing has body, count and byte limits; responses
  have a 64 KiB ceiling. Remember observed 404s for one minute per model/header
  scope, bounded to 128 scopes. Return an explicit 404 without inventing counts;
  generation, authentication, rate limiting and other errors retain their paths.
- Separate generation issues, capability notices and connection/path records.
  Keep bounded raw counters, group retained repeated notices and show specific
  bilingual messages. Count auth/rate/server failures remain actionable.
- Retain flow path/dot nodes on phase changes; remeasure geometry on layout,
  topology, labels or language changes. Stop the two-second status timer while
  hidden or automatic refresh is off; refresh on returning to the page.
- Back off repeated background API-catalog failures (1/5/30/120 minutes), retain
  explicit refresh's one-minute minimum and honor bounded Retry-After. Revision
  changes invalidate prior results; failures never replace saved models.
- Scope a validated Claude Code child-agent hint separately in the local source
  guard. Preserve parent keys and existing company account/history checks;
  hints never grant access.

## Boundaries and upstream references

No global inference circuit breaker, cross-source retry, protocol IR, masking,
new tokenizer, background service or native provider migration is added. One
count-endpoint 404 is not evidence that a source is down. Normal Responses
serialization already ran once per request in the measured 1/4/16 MiB baseline;
that path is preserved rather than replaced with a custom JSON parser.

The request ownership and rendering principles reference Magpie's pinned
[request-local reuse](https://github.com/yetone/magpie/commit/254461829bc2705c6c4636a7c3ad94a837474706),
[routing aggregation](https://github.com/yetone/magpie/commit/9787ca436cf1da77f1e778a4de34e5745b1ac8bf)
and [child affinity isolation](https://github.com/yetone/magpie/commit/3b717d5e0d62a73af365a84ace0eed295809918a).
Floway's revision-bound refresh/backoff at `3919a92` informs catalog handling.
CC Switch's [compaction accounting regression](https://github.com/farion1231/cc-switch/commit/e8e1cfbff4f2d93f2d6c4ba4ad10b511e012c733)
informs validation of gateway usage, without importing its history-log scanner.
No upstream runtime or benchmark result is claimed as CCDX performance.

## Verification

Local `npm run verify` passed 1,590 tests: 1,580 passed, ten optional/platform
skips and zero failures, plus HTTP/SSE smoke, performance budgets and pack checks.
The 48 Chromium/WebKit theme/language/size cases passed; four focused cases also
verified issue-category switching, bounded notice grouping and phase-only SVG
identity. Native Codex passed all five isolated startup/cache states, seven
first-read models, ChatGPT auth and old-session resume. A real 1.2.22 → 1.2.23
npm upgrade loaded sharp and the supported broker in an isolated Darwin arm64
prefix. Real CLI handoff retained the original process on discovery outage and
restored it after promotion failure, with unchanged native config/auth.

A bounded synthetic flow replay (40 phase changes, 12 models) reduced layout
reads from 1,200 to 30 and SVG rebuilds from 40 to one. This is a structural
work-count result, not a frame-rate or end-to-end latency claim. Plain manual
Responses probes at 1/4/16 MiB, single/four concurrent, retained one complete
serialization per request. All replay providers and identities were synthetic;
no paid inference or real login/configuration changes were performed.

Exact-commit cross-platform CI gates publication. Published assets and the npm
package are independently checked after release. The running user service and
company registry/proxy/CA policy are preserved.
