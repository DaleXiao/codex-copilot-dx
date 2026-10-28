# CCDX 1.2.31

## Changes

- Model presentation follows bounded upstream display name, upstream name, then
  upstream ID. The display-only cache retains names separately from connection
  v2. Mixed-source Claude bindings write readable labels regardless of their
  default source. Display collisions are disambiguated independently of route
  collisions; upstream IDs, compatible aliases, grants and defaults are retained.
- Source-close previews include every selected consumer, including nondefault
  deployments. Selected counts, default impact and replacement/pause choices
  come from the runtime snapshot. New WebUI confirmations carry a revision;
  changed bindings or source identity require another review.
- First API setup uses **Save & read models** and stays in the editor. Lookup
  failures retain the saved source and model draft, with an explicit retry under
  existing cooldown/coalescing. Selecting models and assigning them to apps
  remain separate actions. Follow-up app links are offered after model saving.
- App pages show selection saving and configuration-write results separately.
  Writing does not prove that the App has adopted the configuration. Unknown
  capability adapters keep existing shared settings and report the limitation.
- HTTP-200 native error envelopes and SSE error events retain their original
  response bytes/status and existing failed accounting, while contributing
  bounded `model.error` diagnostics. No inference retry or replay is added.
- Native disclosures use down/up SVG chevrons, brief cancellable rotation and
  opacity/translation transitions. Reduced motion stays immediate. Keyboard,
  rapid toggling, translated summaries and dynamic disclosures are covered.
- Existing palettes, sidebar, atom, solid selected controls and complete usage
  views remain. Copy duplication, empty check-table chrome and coarse-pointer
  hit targets receive scoped improvements; technical error details remain.

## Upstream review

- [CC Switch 983113a](https://github.com/farion1231/cc-switch/commit/983113a132ab1754e6bb1fab3994fb3b23d15f62):
  adopt explicit presentation/identity boundaries and stable client output;
  retain CCDX's existing user-owned ordering rather than vendor-family ranking.
- [Magpie e68327b](https://github.com/yetone/magpie/commit/e68327b217bd16d5a9f46c13ff21199fb495580e):
  observe native error envelopes carried by successful HTTP transport.
- [Magpie 7bdefe2](https://github.com/yetone/magpie/commit/7bdefe212fd06620219972f7df5fd8d06002aa7a):
  protect layout-free activity updates. CCDX retains its geometry caches, bounded
  lists, DOM reuse and visibility gates; elapsed-only updates have a regression.
- Floway remains at reviewed `3919a92`; its configuration-bound refresh principle
  is already present. No translation framework, broad routing engine, account
  synchronization or new redaction subsystem is imported.

## Verification

Release gates are pending on the candidate branch. Final local, CI, package,
publication and artifact receipts are recorded here before the release tag.

Verification distinguishes isolated synthetic providers/native CLI replay from
real desktop App adoption. This release work does not replace the user's
running service or restart Codex/Claude automatically. Reopen Claude after
upgrading to load new labels; no provider/model reselection is required.
