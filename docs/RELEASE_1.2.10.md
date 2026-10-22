# CCDX 1.2.10

This patch implements the approved dashboard refinement and bounded upstream
lessons. Classic green remains the default; Klein blue and Soft pink, both UI
languages, the atom logo and circle status icons remain available. CLI stays
English. No runtime dependency or model-routing policy is added.

## Changes

- Selected source, installation-platform and animation choices use a solid
  theme fill and centered text, without a preceding check or radio mark. Hover
  preserves selection. Selects use square borders with a keyboard focus outline.
  Model names and metadata use normal readable text colors.
- Source pages group account/access evidence and the model list. Technical model
  fields remain in expandable rows. GitHub reauthentication remains transactional;
  M365 uses one source switch with confirmation and failed-save rollback. Account
  discovery remains explicit. Saved credentials are not proof of online access.
- Settings groups webpage appearance, terminal color/animation, startup and
  version information. Terminal preview is expandable. Equal saved/effective
  states are concise; overrides and restart requirements retain their reasons.
- Usage trends and model summaries are peer panels with their existing on-demand
  loading. Source filters and partial/unknown cache counts keep their semantics.
- Codex choices and source catalogs share one freshness/single-flight resource.
  Source changes cancel obsolete waiters and discard late results. Profile/account
  changes invalidate old snapshots; routine refreshes retain unsaved choices.
- Terminal animation rendering/saving has its own small controller. Provider
  descriptors are a pure projection, separate from source/account transactions.
  No core SSE, provider fallback or client protocol redesign is included.
- M365 catalog errors expose only fixed cause/HTTP/check/last-success/request-ID
  evidence. The known Entra-disabled response is distinct from an unexplained
  403. Raw server bodies and secrets are excluded. Successful discovery clears
  old source/composition failures without switching providers or probing models.
- Request rows distinguish observed HTTP failures from model terminal evidence;
  existing request IDs and attempt counts stay in bounded details. Dashboard
  list timestamps share local 24-hour formatting in both languages.
- Current README/reference installation links and both bootstrap scripts target
  1.2.10. Package construction now rejects stale current installation links;
  historical release reports keep their original versions.

## Upstream references and scope

- [Magpie identity-query reuse](https://github.com/yetone/magpie/commit/6fc5321)
  and [draft preservation](https://github.com/yetone/magpie/commit/87d703c): share
  already-needed catalog reads and retain unsaved choices; no new identity watcher.
- [Magpie settings rows](https://github.com/yetone/magpie/commit/46176fc): consistent
  setting scope, spacing and state, within CCDX's existing visual style.
- [cc-switch Windows launch lifetime](https://github.com/farion1231/cc-switch/commit/6226f5c):
  protect CCDX's existing ignored-pipe, bounded external-launch contract with a
  Windows-specific stalled-child regression. No installer process behavior change.
- [Floway redundant-copy removal](https://github.com/Menci/Floway/commit/bba28f9)
  and [localized time formatting](https://github.com/Menci/Floway/commit/2141925):
  reduce repeated instructions and share UI timestamp formatting. Its version-bound
  discovery approach informs source-generation and late-result regression checks.

Unix PATH/FD changes, repeated identity probes that CCDX already avoids, broad
dynamic routing, automatic account fallback and protocol intermediate formats are
not imported. These references inform CCDX-owned implementations and tests.

## Verification

Local `npm run verify` passed **1,464 tests: 1,455 passed, nine platform/optional
skips, zero failures**, plus HTTP smoke, SSE idle, resource/performance and package
checks. Chromium/WebKit passed **48** theme/mode/language/viewport cases with no
real provider calls; a final two-case narrow-screen replay covers long company
account names. xterm passed **36** palette/color/size cases including animation and
resize. Local configuration startup, no-Git/no-Node bootstrap, corrupt-download
retention and configured CONNECT proxy/private-CA replay passed.

An isolated real **1.2.9 → 1.2.10** npm upgrade loaded sharp and the supported
Microsoft broker on macOS arm64, using the verified prior GitHub tarball
`ebd3c939745aee79ca6b420b872f2bdb6aa6746812dc3b13bf4b51149a311bd9`.
The company registry/proxy/certificate configuration was retained.

Three alternating small-body held-stream runs per version completed 16/64/128
concurrency and returned active work to zero. At 128 streams, status-P95 medians
were **1.314 ms** for 1.2.9 and **0.687 ms** for this candidate on this host; maximum
sampled RSS was **114.8 / 112.5 MiB** respectively. These small synthetic samples
are not evidence of a universal speedup. Existing performance/resource gates pass.

Cross-platform CI and publication receipts are recorded after those gates finish.
Synthetic browser/protocol/load checks do not prove every physical device,
enterprise account entitlement or real upstream model's behavior.
