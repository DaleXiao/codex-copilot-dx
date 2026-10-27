# CCDX 1.2.28

Claude App can continue an existing conversation after selecting a model on
another already-authorized Messages source. The client keeps its original
conversation; CCDX rebuilds only the request forwarded to the chosen source.
Codex and Claude Code retain their existing source/history rules. WebUI,
client configuration synchronization, native sign-in and model catalogs do not
change in this patch.

## Behavior and boundaries

- The protocol-level transfer policy has no application/provider/model-name
  rules. Claude App's authenticated connection supplies the policy only after
  resolving an enabled, selected model from an authorized source. It preserves
  visible messages, available media, tools and completed native tool pairs.
  Incompatible old-prefix thinking is omitted from the forwarded view; thinking
  produced by the new source after that prefix is retained on later requests.
- Model validation without previous messages and count requests do not move
  the conversation. Usable JSON/SSE text, tool or private state commits a
  checkpoint before delivery. A failure before output retains the previous
  checkpoint. Partial output keeps its actual source's checkpoint. No request
  is automatically replayed on another source and no tool is rerun.
- Active source work holds a per-conversation lease. A new source waits until
  that request/tool turn is complete. A changed/compacted client prefix can be
  rebuilt at a completed tool boundary. Missing tool pairs, remote file or
  container handles, unsupported content and encrypted-only history return a
  clear error while preserving the original conversation. There is no automatic
  summary, transcript truncation, extra inference, signature fabrication or
  guarantee that another source supports identical capabilities/input limits.
- `conversation-transfers.json` holds at most 1024 hashed conversation keys,
  owner/prefix hashes and message counts, within a 512 KiB read limit. Atomic
  locked writes persist only committed checkpoints. It contains no prompts,
  raw session IDs, attachments or credentials. Invalid records fail closed and
  are preserved. Normal same-source requests do not rewrite the checkpoint.
- M365 accepts first account association only from a matching private prepared
  request grant. Known different-account history remains refused. Responses
  account isolation, native Codex provider/auth/catalog setup, private client
  keys and source/model authorization remain authoritative.

## Upstream reference

[Magpie f51ab77 Messages adaptation](https://github.com/yetone/magpie/blob/f51ab771f6fc43f8590253dcc35aaa1db16a8647/internal/gateway/anthropic.go)
and its reasoning-state tests inform preserving native tool/history semantics
and treating source-private reasoning separately. Its vendor/model-name replay
rules and artificial thinking placeholders are not copied. No new runtime
dependency or generic router/framework is added.

## Verification

The user accepted an isolated runtime prototype in a real old Claude App
conversation: DeepSeek API to M365 Claude and back both succeeded. That result
establishes this specific conversation/path, not every model or capability.
The formal implementation adds persistent checkpoints, output-time commit and
leases. Local verification passed 1,644 tests: 1,634 passed, ten platform/optional
skips, zero failures, followed by HTTP/SSE smoke, performance budgets and pack
checks. Seventy-six focused checks completed: 75 passed and one platform skip. A real Codex
runtime passed five isolated startup/cache states, ChatGPT auth, complete first
model lists and old-session resume against synthetic providers. Service handoff,
catalog-outage retention and rollback preserved config/auth and old response IDs.
An isolated 1.2.27-to-1.2.28 npm upgrade loaded sharp and the supported native
broker. These automated checks used no real model inference or user App profile.
Exact-commit CI, artifacts and publication receipts accompany the release. The
user's working service is retained during release.
