# CCDX 1.2.21 candidate

GitHub-only Codex selections now retain the built-in OpenAI provider. This fixes
the configuration path that put the App into its custom-provider UI even though
native authentication and model/list probes succeeded.

## Changes

- Use journal-owned `openai_base_url` for managed GitHub-only selections, including
  legacy single-source bindings. Fresh native setups add no custom provider table.
  Non-GitHub selections retain the private provider/key boundary.
- Migrate unchanged v1 ownership and accept the temporary repair that removed
  only the root provider selection. Preserve an inactive old provider table so
  sessions that recorded `ccdx_gateway` can still resume. New sessions use OpenAI;
  existing session files and native credentials are never rewritten.
- Own/restore exact prior base URL declarations and coordinate the startup writer
  with that ownership. User model/base edits survive later sync and startup;
  default-unavailable protection does not prevent a safe native route repair.
- Use readable unambiguous Codex model IDs and friendly upstream names/metadata.
  Same-named authorized deployments remain qualified and show a source suffix.
  Internal defaults retain source identity; old qualified routes remain valid.
- On macOS, read bundled CLI metadata and optional cache versions in doctor.
  A cache mismatch is a hint to fully reopen the updated App, not proof of a
  failed catalog. HTTP `models` and RPC `model/list.data` are separate schemas.
- Add a native replay with model/list as the first RPC, concurrent config/auth,
  a legacy-session resume, cold/warm/old-cache starts and synthetic inference.
  It asserts OpenAI identity for new sessions, ChatGPT auth, seven visible models,
  no source suffixes and no sign-in errors. No model/list retry masks an empty list.

## Evidence and remaining acceptance

The installed App is 26.1021.31345 with bundled Codex CLI
0.164.0-alpha.11.1. Static renderer branches check provider identity independently
of CLI authentication. Official configuration guidance supports `openai_base_url`
for a proxy on the built-in provider.

The native synthetic replay passed for all four cases, including a legacy session
that would fail to resume if its provider table were deleted. Responses WebSocket
attempts still fall back to HTTP/SSE. This patch does not translate SSE into a
new WebSocket protocol.

Local `npm run verify` passed 1,543 tests: 1,533 passed, ten optional/platform
skips, zero failures, plus HTTP/SSE smoke, performance budgets and pack checks.
Twelve Chromium/WebKit connection cases passed across three palettes and
light/dark modes, including default selection, source changes and private APIs.

Actual App model-picker acceptance is pending. The computer-use tool disallows
operating the Codex App, so native RPC/static evidence is not presented as an
observed post-upgrade UI pass. The user's current working configuration and service
remain untouched while this candidate is reviewed.
