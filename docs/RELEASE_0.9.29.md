# CCDX 0.9.29: visible-page refresh and bounded management reads

## Scope

- Browser-only automatic updates every 30 minutes, on by default and switchable
  in browser storage. Hidden/closed pages have no scheduled read work. Opening a
  data section refreshes its group with a 30-second attempt freshness window.
- One in-flight read per resource; status sections share one snapshot. Opening
  analytics during a summary read requests one sequential upgrade, not concurrent
  scans. Failures keep last-good data/time. Stale cancelled replies cannot replace
  a newer result. Back-forward restoration preserves fresh completed snapshots.
- Retain filters, dates, expanded diagnostics, unchanged model/chart DOM nodes and
  unsaved animation choices. Animation frames load once on demand; metadata reads
  do not reload the frames. No server timer, framework or runtime dependency.
- Transparent single-color atom-orbit SVG uses the existing theme colors and
  inline favicon path. Chinese/English/theme behavior remains independent.
- Extract the unchanged bounded upstream reader into `upstream-body.mjs`, keeping
  all existing transport exports identical. Live catalog reads now share the
  existing 8 MiB success / 1 MiB error bounds and cancellation-aware deadline.
- Preserve explicit upstream `X-Reasoning-Included: true` for native Responses.
  Never synthesize it for absent/false declarations, Chat conversion or HTTP/JSON
  failures. A streaming declaration is not evidence that the stream completed.

## Verification boundaries

Baseline 0.9.28 on macOS Node 22.20: 1,130 passes, zero failures, four Windows-only
skips. HTTP/SSE, relative performance/resource and package gates passed. The first
sandbox run could not listen on loopback; the same code passed with permission to
run isolated local listeners. No baseline code was changed to make it pass.

One bounded review covers lifecycle, cancelled replies, failure freshness,
summary-to-analytics upgrades, selection preservation, metadata-only animation
refresh, byte limits, Host/CSP protection and public API compatibility.
Actual browser inspection found a missing chart-update timestamp node that a
permissive mock DOM had hidden. The node and a static contract were added; browser
checks now require every resource to finish without a read/apply error. A stale
footer assertion and README length guard were corrected without loosening tests.

The real Copilot probe made one minimal `gpt-6.1-sol` / low request. It completed
with HTTP 200 and usage input 17 / output 5 / reasoning 0 / total 22. The upstream
did not return `x-reasoning-included`; CCDX therefore adds no declaration. This
single request does not establish how Copilot accounts for all historical
reasoning, and no performance benefit is claimed from it.

Official Codex source recognizes header presence and can skip its additional
history-reasoning estimate. Literal false must not be passed as a presence flag.
Isolated installed `codex-cli 0.162.0-alpha.17.2` replays covered absent, true and
false declarations through actual CCDX. All three completed three ordinary turns;
only explicit true was forwarded. Reported usage and compaction counts did not
differ in this scenario. Tests establish safe compatibility, not a guaranteed
reduction in context use, automatic compactions or latency.

The first diagnostic used oversized synthetic opaque items to probe compaction;
all arms compacted once, so it did not demonstrate a benefit. The final smaller
fixture is a normal-continuation regression. A cleanup race exposed a child helper
outliving its parent; the POSIX replay now owns and terminates its process group
and uses bounded directory-cleanup retries. These are test changes, not client
program changes.

## Preserved behavior

No change to model selection, Standard/Fast routing, Auto-review model/effort,
image setup/delivery, native prediction setup, inference retry count, request and
history limits, or local plaintext recovery policy. LAN opt-in is unchanged;
dashboard assets remain loopback/Host restricted, and management APIs retain
custom-header and same-origin write protection. No prompt/image content or
credential fields are added to dashboard responses.

Current-client replay and browser checks are controlled tests, not a promise that
every future client, corporate network or user history is compatible. The real
reporter's original history recovery from issue #1 remains a separate open check.

## Sources

- [Floway reasoning declaration change](https://github.com/Menci/Floway/commit/24b0339906640d55a226733aeeb6b044668ef44e)
- [Magpie state-refresh preservation](https://github.com/yetone/magpie/commit/63a361b5ff238c2504608bed9a157089eaa5e293)
- [Official reasoning guide](https://developers.openai.com/api/docs/guides/reasoning)

Existing semantic-conversion rejection, timing-source distinctions, peak-relative
heatmap levels and Host checks were retained rather than implemented twice.
