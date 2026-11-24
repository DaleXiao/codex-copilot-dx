# CCDX 1.4.20

- Bark recovers damaged delivery records, reduces repeated catalog reads and gives clearer feedback on save and delivery. New Bark URLs use HTTPS, including reverse-proxy installs. The optional Antigravity Stop hook checks for eligible notifications as soon as the App reports completion.
- Antigravity keeps reasoning usage consistent between the app and ledger, and reports what Copilot counted when its reply has no text or tool calls. Copilot tool turns can carry their sealed reasoning into the next request in the same conversation.
- Copilot and Kimi can continue affected tool history. Claude startup probes share results across saved effort defaults, and Messages explains unsupported sampling fields for the new API version.
- Usage summaries avoid per-record merging. Date filters reuse bounds from unchanged archives while keeping the full model selector. A permissions change no longer counts a newly sealed backup twice after an interrupted rotation.

Unverified: live vendor tool reasoning replay and native completion notifications across the three Bark apps.
