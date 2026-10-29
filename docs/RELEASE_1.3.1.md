# CCDX 1.3.1

Baseline: 1.3.0. Released as a patch; saved accounts, model choices and client configuration need no migration or repeat setup.

- WebUI disclosures expand downward without shifting their summaries, table columns or peer-row values. Existing styles and reduced-motion behavior remain.
- Clicking the sidebar logo plays the existing brief rotation, without stacking animations or forcing a status refresh. Header connection and request-flow activity use a link and circled ellipsis respectively.
- Usage adds a Context tab for reported input, declared windows, cache reuse and observed gateway compactions from this run. Existing token totals and all-history usage remain available.
- Context series require explicit session identity and stay separate by app, source profile, model and declared subagent. Unidentified requests appear individually; parallel requests are not joined into a conversation curve. Missing values remain unknown.
- Context metadata has fixed memory bounds, no persistence, no prompt storage, no tokenization and no extra model calls. The optional page reads a separate snapshot; ordinary status payloads do not grow with retained context series. Content breakdown and compression controls are deferred.

Release gates cover the full local verification command, browser and disclosure replays, context isolation/bounds, unchanged status contracts, performance comparison, isolated package upgrade, Windows/macOS CI, and public package/asset verification. Image generation, native suggestions, native sign-in and client configuration writers are outside this patch.
