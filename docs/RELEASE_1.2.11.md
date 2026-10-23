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

Final local, platform CI, package-upgrade and publication receipts are attached
to the GitHub release. Publication is gated on these checks and verified package
bytes. The configured company registry, proxy, certificate and shell policy are
preserved; mirror synchronization is verified separately from public publication.
