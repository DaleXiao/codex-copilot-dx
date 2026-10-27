# CCDX 1.2.27

This patch fixes Claude App model synchronization being blocked by its own 1M
preference, and gives new declared 1M models one context choice by default.

## Changes

- Ordinary `inferenceModels` synchronization compares parsed model-list structure.
  A boolean `prefer1m` change is preserved per exact model identity without
  treating the entire list as user-managed. JSON formatting alone does not block
  a managed update. New declared 1M entries default to showing only their 1M
  option; explicit supported true/false choices are retained. Smaller or unknown
  windows are not promoted.
- An already-correct manual model recovery can refresh an existing ownership
  record without rewriting the App profile. Surviving recorded models must keep
  their other fields and relative order. The original restoration value remains
  unchanged. A future selection change can then synchronize normally.
- Real edits to names, labels, effort limits, unknown fields or model order stay
  protected. Malformed model JSON, duplicate names and invalid preference types
  are not erased. Other client fields, unowned settings, managed policy and
  restoration retain their previous strict checks.
- Model routing, credentials, conversation-source isolation, input budgets,
  protocol handling, retries and all WebUI layouts remain unchanged. Old
  conversations stay bound to their source/key; use a new conversation when
  changing source. This patch does not clear conversation ownership.

## Verification

Focused regressions cover model updates after App preference/formatting changes
on macOS, Windows and Linux paths, already-desired manual recovery, later model
additions, preservation of original restore state, genuine custom edits, invalid
JSON/preference types, duplicate identities, non-model keys and user ordering.
The reported manual recovery was accepted in the real App before this patch:
a new M365 conversation replied normally and the duplicate context entries
were gone. Release checks use isolated profiles and synthetic providers, not
additional paid inference. Exact-commit CI, full verification, isolated package
upgrade and independently checked release/public npm artifacts gate publication.

Local full verification passed 1,633 tests: 1,623 passed, ten platform/optional skips and zero failures, followed by HTTP/SSE smoke, performance budgets and pack checks. Native Codex passed five isolated startup/cache states, ChatGPT auth, complete first-read catalogs and old-session resume. Synthetic service handoff/outage/rollback preserved config/auth and old response IDs. A staged replay of the actual four-record/seven-model recovery refreshed the ownership record without rewriting the staged App profile or changing its original restore state. The live user profile was not written by this replay.
