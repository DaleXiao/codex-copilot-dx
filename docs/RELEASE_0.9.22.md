# CCDX 0.9.22 verification report

## Scope

Optional next-message suggestions through MCP, off by default. Commands:
`ccdx suggestion on`, `off`, `model [MODEL_ID]`, and `status`. The numeric model
picker does not enable the feature. Initial model: GPT-6 Luna, low reasoning
when advertised. The feature does not force a service-tier parameter.

The panel returns one suggestion. The user's Add to draft action appends ordinary
text through the existing MCP draft extension with `send:false`; it never sends
or grants approval. The cancelled client-patch/grey-text experiment is not included.
No client binary, AGENTS.md, image integration, main proxy route, Fast mapping,
Auto-review setting, startup path or dependency was changed.

The CLI preserves user-managed, inline/dotted and profile-specific MCP settings.
Repeated enabled setup does not rewrite files. Only explicit commands change the
feature; there is no startup installer or predictor. Native prediction settings
are left intact. Account/remote feature gates do not provide a reliable generic
local signal, so automatic recognition of every future official default is not
promised. This boundary was explicitly accepted before implementation.

## Data and resource boundaries

- The host supplies the exact local thread ID; no recent-thread guessing.
- The official `thread/items/list` reader retrieves at most 24 recent items.
  Only user/assistant text is selected: up to eight excerpts and 16,000 characters.
  Images, reasoning items and tool results are excluded. No direct transcript
  scan, SQLite access, fork, resumed turn or client-history edit.
- Context lookup has a 5-second/2 MiB cap; one operation has a 30-second deadline.
  The model reply is capped at 64 KiB and the suggested text at 300 characters.
  At most two operations run concurrently. No feature-level retry is added.
- At most 16 candidates are retained in process memory. Adoption expires after
  ten minutes and validates the original thread and selected model. Config-off
  is checked on every tool request and before inference; no new inference after
  disabling. Existing adapter retry/routing policies remain unchanged.
- The MCP has no provider key. It calls only the configured loopback CCDX URL.
  Recent text goes to the selected Copilot model under the provider's data policy.
  The panel uses textContent and a supported draft capability check, not HTML
  insertion into the native composer. Raw malformed model bodies are not echoed.

## Verification and bounded review

Baseline HEAD `4821843`: all 1006 existing tests passed. Candidate: 1027 tests
passed with no failures, skips or cancellations. Full `npm run verify` passed:
unit tests, HTTP/idle-SSE replay, performance/resource gates and package checks.
The existing startup/configuration replay also passed, including image-disabled,
image-conflict, pending/failed optional setup and adapter-reuse scenarios.

One scoped review/fix pass covered default-off/no writes, idempotency, numeric
selection and cancellation, user/profile settings, concurrent configuration edits,
UTF-8 split frames, malformed responses, terminal states, thread/model binding,
expiry, parallel-work limits, cancellation and disabled-before-inference behavior.
Documentation gates caught a missing environment-variable explanation and inline
shell comments in executable examples; the docs were corrected, not the checks.
No adjacent refactor or additional feature was added during review.

Installed unmodified Codex `0.162.0-alpha.17.2` passed the full synthetic MCP
replay: native tool discovery/invocation, official paginated context reading,
one synthetic suggestion, panel-originated draft preparation, unchanged thread
items before/after reading, and disabled mode with zero additional inference.
All inference in that replay is served by localhost fixtures. The replay is also
included in the latest-official-Codex CI job.

Independent browser/iframe UI checks passed: ordinary draft append, original
draft preservation, no sends, repeat-click prevention, rejection after a thread
switch, and disabled adoption without host draft support. This UI harness is
not presented as a new native-App visual test. The same original MCP `send:false`
draft mechanism was previously verified in the unmodified App with user confirmation.

One successful live GPT-6 Luna / low check using a synthetic Chinese conversation
returned a valid next-message suggestion in approximately 2.45 seconds. Before
that, a 400 response and one bounded diagnostic reproduction identified an
unsupported explicit `service_tier: default`; the new feature omits that field.
The existing Fast implementation was not modified. No live user transcript was
used for this inference test and no automatic retries were introduced.

## Performance statement

Existing proxy performance/resource gates pass. Disabled users get no MCP
registration, prediction subprocess, model request, new startup work, or hot-path
imports. Enabled suggestion requests incur bounded on-demand reader/model work;
there is no background polling. This is a capability addition, not a claim of
faster foreground model inference or improved upstream service reliability.

## Publication

GitHub uses the same previously supplied DaleXiao PAT, retrieved from the exact
source used for 0.9.21, identity-verified again and held only in memory. npm uses
the repository's existing NPM_TOKEN through its publish workflow. No alternate
credential, browser sign-in or local registry lookup is used. CI and publication
receipts will be recorded after the release gates complete.

Cleanup is limited to task-owned fixture, UI-test and release-helper directories.
User credentials, client configuration, saved conversations, generated images,
installed dependencies and the existing running service are preserved.
