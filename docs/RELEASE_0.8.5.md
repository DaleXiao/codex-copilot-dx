# CCDX 0.8.5 verification report

Date: 2026-09-23. Baseline: `58504ff` (0.8.4).

## Scope

Expose GPT-6 Sol and GPT-6 Luna to Codex App installations whose bundled
0.155.x model catalog predates those entries, but only when the active GitHub
Copilot catalog advertises the exact model as enabled, selectable,
OpenAI-owned, and Responses-capable. Add explicit runtime cache inspection,
history sizing, and bounded cleanup without deleting saved tasks or generated
images.

Existing Responses/Chat routing, encrypted-history recovery, compaction,
Auto-review, image input, optional image generation/editing, terminal
animation, and the explicit LAN mode remain in place.

## Model catalog behavior

- CCDX continues loading the complete catalog from the installed Codex binary,
  keyed by the binary identity and requested client version.
- If `gpt-6-sol` or `gpt-6-luna` is missing, CCDX derives a compatibility entry
  from that client's GPT-6 Astra schema and the OpenAI Codex public model
  definitions at commit `0a2eb4696c26ac33204bcd255721ab30220a4774`.
- Compatibility entries are inserted only for exact eligible Copilot models.
  Ineligible, duplicate, disabled, non-OpenAI, or non-Responses entries are not
  exposed. Every unrelated client entry and capability is preserved.
- Client-provided Sol/Luna entries always win over compatibility metadata.
  Their future fields and reasoning choices remain client-owned.
- Fallback Sol/Luna reasoning choices are intersected with Copilot's advertised
  choices. The verified account advertises Low through Max for both. Existing
  Astra Ultra remains unchanged.
- Fast is exposed and routed only when Copilot advertises an exact eligible
  `<base-model>-fast` entry. The current Sol/Luna catalog does not, so their
  inherited ChatGPT Fast metadata is removed and priority requests safely use
  Standard. The established `gpt-5.6-sol-fast` route remains supported.
- Actual minimal non-streaming Responses requests to both `gpt-6-sol` and
  `gpt-6-luna` completed over Copilot with HTTP 200, the matching response
  model, completed status, and `OK` output.

## Cache control

`ccdx cache` reports configured and running history limits, shared history
occupancy, and rebuildable image-transform occupancy.

- `ccdx cache --limit <MiB>` (or `-128`) accepts 16–1024 MiB. It applies to a
  compatible running adapter and persists under the existing CCDX settings
  file. `--limit default` removes the override. The environment variable
  `CCDX_RESPONSE_HISTORY_MAX_BYTES` retains higher precedence.
- A requested limit below current history use is rejected without evicting
  task state or rewriting the saved setting.
- `ccdx cache --clean` clears completed input-image transforms only. It does
  not delete image files, image edit handles, provider configuration, model
  catalogs, usage logs, or response history.
- `ccdx cache --clean --history` also clears all process-local
  `previous_response_id` chains. It requires interactive confirmation or
  `--yes`, rejects cleanup while relevant cache work is active, and explains
  that the next continuation of an existing task may fail.
- Cache control is loopback-only, rejects browser Origin requests, requires
  bounded JSON, and is advertised through adapter protocol 4 capability
  `cache-control-v1`. Older running adapters require a restart.

## Verification

- `npm run verify`: **828 tests, zero failures**, offline HTTP smoke,
  performance/resource checks, and npm package dry-run passed on Node 22.20.0.
- Focused coverage validates exact eligibility, old-client insertion,
  future-client precedence, reasoning intersection, Astra Ultra preservation,
  Fast exact matching, native Responses routing, cache status and settings
  precedence, low-limit rejection, cleanup confirmation, busy-cache rejection,
  and loopback/browser boundaries.
- A read-only merge of the installed Codex `0.155.0-alpha.9.2` catalog with the
  active Copilot catalog produced visible Astra, Sol, and Luna entries. It kept
  all nine original entries and every non-target entry unchanged, adding only
  Sol and Luna. Astra kept Ultra; Sol and Luna exposed Low through Max; none
  advertised Fast without an upstream fast model.
- Nine isolated CLI startup/reuse scenarios passed with fake credentials,
  synthetic model responses, random loopback ports, and temporary profiles.
  Disabled image scenarios performed no image MCP/provider request; a pending
  and failing image request did not block GPT before or after failure.
- Model refresh, catalog selection, stream handling, compaction, image
  behavior, and cache operations remain bounded. Existing performance/resource
  gates passed without changing their thresholds.

The model rollout remains account- and workspace-dependent. These checks prove
the tested account, client, and release behavior, not universal entitlement.

## Publication

GitHub CI, release URL, npm workflow, and published package integrity are added
after the corresponding release operations complete.
