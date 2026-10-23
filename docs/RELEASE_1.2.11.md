# CCDX 1.2.11

This patch implements the approved request-flow view and WebUI refinement.
Classic green stays the default; Klein blue, Soft pink, both languages, the atom
logo and circle status icons retain their existing roles. CLI stays English.
No runtime dependency, provider, routing policy or account-selection rule changes.

## Changes

- Requests shows live app → CCDX → source/model paths above the existing source
  summary, last 20 finished records and issues. Rounded curves have static waiting
  dots and moving output dots; retries and delivery completion remain distinct.
  Idle uses a breathing lamp. Hidden views pause motion, reduced motion stays
  static, and stale reads stop activity instead of reporting idle or success.
- Concurrent requests group by application and source/model pair. Explicit client
  hints supply labels; unmarked Claude requests stay unspecified. Name-only solid
  selection filters active details, with counts outside the selection. Global
  totals and finished records keep their scope. Up to 64 active details per
  metrics instance are retained; omitted details and lower-bound group counts are
  labeled. Twelve model groups show initially, with an explicit expansion control.
- Existing fixed histograms provide approximate first-output P50/P95 and sample
  counts in Codex/Claude performance. Empty samples remain unknown. Partial-output
  failures stay in the measurements; no raw samples or scoring engine is added.
- Tables keep header/interior separators and use whitespace before adjacent
  details. Terminal animation, settings and version sections avoid stacked rules.
  The main-content focus frame is removed; interactive keyboard focus stays visible.
- Eight page-opening descriptions are removed. Repeated explanations are reduced
  or moved to details; operation impact, setup steps, quota, scope and privacy remain
  available. Saved/effective state and errors remain factual. Source/account,
  application, usage and settings ownership are unchanged. Current install links
  and both bootstrap scripts target 1.2.11.

## Upstream references and boundaries

- [Magpie snapshot e00fbdb](https://github.com/yetone/magpie/tree/e00fbdbbc74f9829027a78769cbeb265d6271fb4):
  request/attempt traces, rounded path geometry and idle/visibility-aware animation
  inform this small CCDX-owned SVG controller. Its routing framework, intent
  classifier and slow-model cooldown are not imported.
- [cc-switch snapshot 79ba798](https://github.com/farion1231/cc-switch/tree/79ba7982aa3980b001c0b68efde05505884c1f8b):
  coherent filter scope and credential ownership reinforce CCDX's existing
  source-local views and explicit checks. No extra token refresh or identity poller
  is added; saved sign-in remains separate from online access.
- [Floway snapshot 3919a92](https://github.com/Menci/Floway/tree/3919a92f90b2a00b54cc0e78b90fd614cf6f14f5):
  separate timing boundaries, partial-output failures and opaque-state affinity
  inform histogram presentation and regression checks. This snapshot has no new
  commits since the previous review. Existing generation/affinity guards remain;
  no protocol intermediate format, cross-source replay or automatic failover is added.

The complete copy disposition is recorded in [WEBUI_COPY.md](WEBUI_COPY.md).
Runtime contracts and approximation limits are in the shipped reference and
architecture documents. Synthetic checks cannot prove every enterprise account's
entitlement or every upstream model's behavior.

## Verification

Local `npm run verify` passed **1,470 tests: 1,461 passed, nine platform/optional
skips, zero failures**, plus HTTP smoke, SSE idle, performance/resource and pack
checks. Chromium/WebKit passed **48** combinations of language, palette, light/dark
mode and viewport with zero real provider calls. Concurrent app/model grouping,
name-only selection, stale status, source tables, request retention, the removed
focus frame, square selects, readable models, settings and reduced motion were
covered. Two additional 360px/736px narrow-layout cases passed. Isolated
configuration startup also passed.

A real isolated **1.2.10 → 1.2.11** npm upgrade loaded sharp and the supported
Microsoft broker on macOS arm64. The verified baseline tarball SHA-256 was
`972e11b1a694100ce1bafeae36cdbb30011f9896b51dc15126e5606f6764356d`.
No-Git and no-Node bootstrap, installed commands, corrupt-download retention and
configured CONNECT proxy/private-CA download checks passed locally. TLS stayed
strict and offline mode remained enforced.

Three alternating held-stream runs per version covered 16/64/128 concurrency and
returned active work to zero. At 128 streams, status-P95 medians were **1.478 ms**
for 1.2.10 and **1.602 ms** for this candidate; maximum sampled RSS was
**114.89 / 114.92 MiB**. Added observation has a small measured cost in this test;
these synthetic results do not establish a universal speedup or real-model latency.
Existing performance/resource budgets pass.

The pack contains **200 files / 544,475 compressed bytes**, with unchanged runtime
dependencies. All packed file contents matched the checkout. Tarball SHA-256:
`422207f6cb1f7c0dcad1686573f691506b6d4f4f66531cc5d464db4960b59799`.

Final platform CI, npm publication and freshly downloaded asset receipts are
attached to [GitHub v1.2.11](https://github.com/DaleXiao/codex-copilot-dx/releases/tag/v1.2.11).
The configured company registry, proxy, certificate and shell policy are
preserved; mirror synchronization is checked separately from public publication.
