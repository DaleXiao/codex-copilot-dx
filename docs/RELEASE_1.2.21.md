# CCDX 1.2.21

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
- Preserve a complete recognized qualified-ID catalog cache as a private backup
  so the first App read after this ID migration obtains the fresh native catalog.
  Unknown, partial or unrelated caches remain untouched.
- On macOS, read bundled CLI metadata and optional cache versions in doctor.
  A cache mismatch is a hint to fully reopen the updated App, not proof of a
  failed catalog. HTTP `models` and RPC `model/list.data` are separate schemas.
- Reconcile GitHub bindings after startup directory initialization and after
  existing background refreshes. No extra directory request or refresh timer is
  added; the full CLI startup replay checks the final native default.
- Add a native replay with model/list as the first RPC, concurrent config/auth,
  a legacy-session resume, cold/warm/old-cache starts and synthetic inference.
  It asserts OpenAI identity for new sessions, ChatGPT auth, seven visible models,
  no source suffixes and no sign-in errors. No model/list retry masks an empty list.

## Verification

The installed App is 26.1021.31345 with bundled Codex CLI
0.164.0-alpha.11.1. Static renderer branches check provider identity independently
of CLI authentication. Official configuration guidance supports `openai_base_url`
for a proxy on the built-in provider.

The native synthetic replay passed five cases, including the temporary repair's
fresh qualified-ID cache and a legacy session that would fail to resume if its
provider table were deleted. Responses WebSocket
attempts still fall back to HTTP/SSE. This patch does not translate SSE into a
new WebSocket protocol.

Local `npm run verify` passed 1,545 tests: 1,535 passed, ten optional/platform
skips, zero failures, plus HTTP/SSE smoke, performance budgets and pack checks.
Twelve Chromium/WebKit connection cases passed across three palettes and
light/dark modes, including default selection, source changes and private APIs.

Cross-platform CI passed all 17 jobs on the verified code commit, including the
official Codex 0.164.0 client replay. After the approved local upgrade, the user
confirmed that the actual App lists models normally. The native authentication
file remained unchanged during that upgrade. Actual old-session UI acceptance
was not separately reported; legacy-session resume passed the synthetic replay.
GitHub assets and public npm bytes are checked after publication. The configured
company registry and proxy policy remain unchanged.
