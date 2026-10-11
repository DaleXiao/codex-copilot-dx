# CCDX 0.9.23 verification report

## Scope

Optional next-message suggestions remain off by default. Supported macOS/Linux
Codex runtimes can register a CCDX asynchronous Stop hook through the explicit
`ccdx suggestion on` command. Existing 0.9.22 users run that command once to migrate.
The hook needs normal user review/trust in Codex; CCDX neither grants trust nor
bypasses it. Existing user handlers, native predictions and unrelated settings are
preserved. Unsupported runtimes retain the manual panel.

After a reply, the reviewed hook generates one suggestion without starting a new
turn or waiting on foreground completion. Opening the panel reads the saved
candidate without inference. The user still chooses Add to draft and then Send.
Automatic filling/grey text is intentionally not included: the unmodified MCP host
has no atomic empty-draft insertion and closed panels have no composer bridge.
No client patch, skill, AGENTS.md or authentication change is included.

The bilingual dashboard shows enabled state, selected model, configured automatic
generation, manual draft insertion and recent safe result/time/reason. Configuration
is not presented as confirmed hook trust or official account entitlement. This
read-only endpoint starts no process, invokes no model and exports no suggestions,
thread IDs, context, paths or credentials. It uses existing loopback/dashboard gates.

## Boundaries

Automatic work uses one local slot, a 30-second deadline and no additional retry.
Same-turn attempts are deduplicated; the latest turn and settings are checked before
and after inference. Failed/incomplete results, changed settings and newer turns
cannot become adopted candidates. Context remains the bounded official paginated
read (24 items, eight text excerpts, 16,000 characters); tools/images/reasoning are
excluded. Output remains 64 KiB and 300 characters. Disabled users incur no prediction
process or model call; enabled automatic prediction adds selected-model usage.

Only candidate and metadata are locally saved, at most 32 entries. Adoption expires
after ten minutes; stale files are pruned on the next automatic operation. Context
excerpts are never saved. Manual generation and its existing resource caps remain.
Fast mapping, Responses routing, image delivery, auto-review and dependencies are
unchanged. This is not a claim of faster upstream inference.

## Verification

One bounded review/fix pass addressed disabled model selection, setup idempotency,
configuration validation, metadata projection, lock cleanup, retention limits,
thread/model binding, failure suppression and truthful trust/status wording.

Installed unmodified Codex 0.162.0-alpha.17.2 passed both isolated integration modes:
normal CLI-reviewed hook dispatch generated after a completed turn; a fresh untrusted
hook did not run. Both modes passed native MCP discovery/invocation, bounded context
reads, cached candidate retrieval, draft preparation, unchanged thread contents and
disabled mode with no additional inference. Each used three synthetic primary
responses and two synthetic suggestions; zero external model calls. CI separately
checks the untrusted-hook boundary and directly exercises the automatic component;
it does not fabricate trust or claim trusted dispatch from that component test.

The current installed App hides General's Show predictions component unless both
its remote gate and native bridge eligibility succeed. Search indexing is not proof
the setting is available to a particular account. CCDX leaves those gates untouched.

All 1,033 tests passed, with no failures, skips or cancellations. Full `npm run
verify` passed: unit tests, offline HTTP/SSE replay, performance/resource gates and
offline package checks. The existing isolated startup/configuration replay passed,
including image-disabled/conflict/failure cases and adapter reuse. The package has
120 files, 313,569 packed bytes, SHA-1 `6ac70ec39d0221dd2a2e02e6e27a384a0715bae7`.

Independent browser/iframe checks cover bilingual state rendering, day/night mode,
mobile layout, cached candidate loading, preservation of existing draft text,
send:false and repeat-adoption prevention. This is a browser host harness, not a
claim of a new native-App visual test. The unchanged MCP draft mechanism was
previously user-verified in the unmodified App.

Publication receipts will be recorded after GitHub CI and npm publication succeed.
