# CCDX 0.8.0 verification report

Date: 2026-09-15. Baseline: `57843ae` (0.7.10).

## Bounded scope

This release addresses the six confirmed findings from the 0.7.10 review.
It does not change model selection, Sol Fast, Auto-review, GPT-6 capabilities,
animation themes, or the intentionally retained opt-in LAN API.

1. **Configuration safety.** Quoted/dotted TOML declarations are recognized
   without formatting the whole file. Source spans preserve unrelated text;
   parsed before/after checks protect non-managed settings. Invalid TOML,
   invalid UTF-8, misleading markers inside strings, and unsafe block removal
   cannot overwrite the original configuration. Doctor reports safe errors.
2. **Recovery deadlines.** A completed SSE handshake transitions to the idle
   timeout. Exact pre-output encrypted-state failures can start a fresh,
   bounded recovery-preparation phase even after the first handshake deadline.
   Initial handshake limits, cancellation and one-use retry policies remain.
3. **Recovery admission.** HTTP-200 failure recovery reacquires request and
   history admission before materialization. Queued cancellation, expiry and
   failed/no-op recovery release reservations. Normal successful streams do
   not acquire extra reservations or retain them through output streaming.
4. **Image DNS cancellation.** Resolution and transfer share a deadline;
   cancellation ends waiting even if DNS has not returned. Late results cannot
   initiate a request. Active failed downloads are destroyed safely.
5. **Selected-model protocol.** Image setup chooses from the catalog before
   probing the selected model. It still performs one catalog read and one
   prompt-free protocol probe, with no generation or provider fallback.
6. **Image request boundary.** The same-device MCP endpoint rejects browser
   Origin headers and non-JSON media types before body/configuration access.
   Native Codex/Node JSON requests, charset parameters, initialization,
   notifications, generation, editing and existing socket rules are retained.

## Review and tests

Each original finding was reproduced before its fix and received regression
coverage. One bounded integration review also addressed strict UTF-8 handling
in the image CLI and safe cleanup of failed download response streams. The
scope was not expanded into unrelated model or transport changes.

- Full `npm run verify`: **752 tests, zero failures**, offline HTTP smoke,
  performance/resource checks and npm package dry-run passed on Node 22.20.0.
- Independent review of recovery lifecycle and image request boundaries
  found no remaining blocking issue in the reviewed changes.
- Installed Codex CLI **0.154.0-alpha.6.2** offline replay passed deferred
  discovery, activation, generation, two successive edits and saved-task
  restart/resume. Four image operations retained native image content and
  the exact source handles; each operation was dispatched once. Normal
  fixture approval handling remained enabled.
- Image helper/readiness, generation/edit semantics, immutable originals,
  disabled providers, one-shot failure behavior, Fast, Auto-review, message
  identity, compaction and animation regressions remain in the full gate.

## Performance evidence

The local synthetic checks measured adapter import at **40.0 ms / 57.9 MiB
RSS**, and 5,002 stable SSE events at **25.8 ms**. Reads while downstream was
blocked remained **zero**. Two 30 MiB synthetic requests peaked at **285.4 MiB
RSS**; the 32 MiB admission budget is not a process RSS ceiling. Repeated image
optimization retained about **59 KiB** additional heap with zero retained
ArrayBuffer growth. All existing resource gates passed.

These are machine-dependent synthetic measurements, not an upstream latency
SLA or proof of absolute zero overhead. New configuration validation occurs
only during setup/startup, not in the Responses hot path. This release did not
make paid image calls or modify the user's installed App/configuration during
testing. Historical live-provider results from 0.7.10 are not claimed as new
0.8.0 live-provider validation.
