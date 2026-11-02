# CCDX 1.3.9

- Preserve M365 inline system instructions and existing cache prefixes, independently of Claude App aliases. Explicit model capability overrides remain available for other endpoints.
- Keep cumulative token counters across null stream updates. Share token-weighted cache-rate evidence across CLI, TUI and WebUI, distinguish missing data, and show cache writes separately.
- Share unsupported M365 count-token probes before privacy detection. Bound long-history rule caching and cancel unused shared checks without freeing occupied native slots early.
- Stage verified privacy components separately, reuse model weights, and keep compatible installed protection working during failed upgrades. Correct invalid UTF-8 token offsets.
- Align prediction repair controls in one responsive action group and preserve unsaved request-limit edits through refresh.
- Discover all unit tests on both supported systems, shard full browser theme coverage, pin native client versions, and require exact-commit CI plus downloaded npm/GitHub artifact verification for publication.

The active desktop applications are not restarted by this release work. Synthetic native client replays validate tool execution; they do not establish acceptance of every signed Claude App workflow. Cache recovery depends on the upstream service and the actual conversation prefix; no target hit rate is fabricated.
