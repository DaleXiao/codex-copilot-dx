# CCDX 1.3.7

Baseline: 1.3.6. This patch repairs local-masking transport and tool-data boundaries. MCP search, model sources, native credentials, image setup, prediction routing and the active service remain outside the change.

Streaming restoration keeps SSE event names and wire metadata. Responses custom-tool input restores placeholders across fragments. Tool arguments restore in their own context, including ordinary fields named `type`, `signature`, `encrypted_content`, `id` and `data`; protocol state remains opaque. Upstream failure events discard unfinished argument buffers and retain the original failure. Responses Lite inline tool descriptions participate in request masking while definitions and grammars remain unchanged.

Privacy errors have a distinct local origin. A failed outgoing check reports that nothing was sent; a failed response restoration reports that the response was stopped. Request details can show an explicit client-reported tool-error count without keeping its content. Successful HTTP/model completion is not recorded as proof of successful tool execution.

Anthropic/OpenAI SDKs are fixed development-only test dependencies. Native client replays use temporary profiles and simulated providers, execute an actual local MCP fixture, return the tool result and require continuation. Codex replay also verifies a real harmless terminal command. The optional classifier remains pinned to the existing v1.3.6 component Release; no model weights or compiler enter ordinary installation.

## Verification status

Publication checks include full verify, SDK/gateway regressions, native Codex/Claude Code execution/return/continuation, macOS/Windows CI and browser contracts, package/runtime checks, isolated upgrades and public npm/GitHub asset verification. The user authorized publication and will perform the remaining Claude App tool-host test; that test is not recorded as passed.

Local `npm run verify` passed: 1,736 tests passed, ten skipped, zero failed, plus HTTP/SSE smoke, performance/resource and package checks. Native Codex masking-on/off execution/return/continuation passed, including its current code-mode MCP and harmless terminal calls. Native Claude Code masking-on execution/return/continuation passed before the user deferred further Claude testing. The signed App's debugging/data-directory restrictions prevented the attempted local isolation; this was not counted as a pass. The user is taking over Claude App validation after publication. No active service is restarted by publication.
