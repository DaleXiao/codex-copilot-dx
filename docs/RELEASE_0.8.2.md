# CCDX 0.8.2 verification report

Date: 2026-09-17. Baseline: `794c04d` (0.8.1).

## Bounded scope

This release reorganizes the opt-in image skill and clarifies MCP guidance.
It does not replace native ImageGen, patch Codex, add image capabilities,
change image request routing, or alter provider execution, credentials,
concurrency, cancellation, retries, image bytes, output paths, or edit handles.

The skill entrypoint retains operation selection, final-chat image delivery,
and the no-duplicate-request boundary. Editing details and the MCP-unavailable
helper procedure are separate, conditionally loaded references. Source Markdown
templates replace the large inline JavaScript instruction string. The helper
implementation and its stdout-path/stderr-ID contract are unchanged.

MCP tool names, parameter schemas, annotations, and output envelopes are
unchanged. Tool descriptions now focus on their input/output contract. Server
instructions fit within 512 characters for editing-enabled and generation-only
providers, with delivery and retry rules before optional workflow detail.
The existing image content plus text/metadata format is retained; no
`structuredContent` or new media-rendering mechanism is introduced.

## Opt-in and installation lifecycle

Users who have not enabled images receive neither a Codex image MCP registration
nor an installed `ccdx-image` skill. The package contains inert templates, not
an install-time activation hook. The existing startup gate checks the saved
enabled provider before loading/updating image guidance. Image status and
disable commands on a fresh profile perform no image setup or network request.

Already-enabled users receive the new owned bundle on their next CCDX startup
without repeating `enable-image`. The installer verifies all four destination
files before writing, installs references before publishing the entrypoint,
and rolls back ordinary write failures. Existing two-file installations remain
recognized. Idempotent startup does not rewrite any bundle file.

Disabling removes the owned skill, both references, helper, provider credential,
and managed MCP registration. User-modified or unowned files and symlink targets
are preserved. Existing cached image tools still fail closed after disabling.
This is rollback-safe installation, not a claim of cross-file atomicity across
power loss or arbitrary concurrent user edits.

## Review and verification

- One bounded source/instruction review covered the changed installer, templates,
  MCP guidance, opt-in startup gate, and regression tests; no unrelated module
  optimization was added.
- Targeted image/config/helper tests passed: 57 tests. Additional coverage
  includes reference discovery, no default installation, legacy migration,
  four-file rollback with exact modes, reference conflicts/symlinks, post-rename
  write failures, safe command-path rendering, and initialization without image
  dispatch. An initial test fixture incorrectly classified editing support by
  protocol alone; the fixture was corrected to preserve the existing supported
  Qwen models under both protocols. Provider code was not changed.
- Skill Creator validation passed for the source entrypoint.
- Installed `codex-cli 0.155.0-alpha.2.6` offline replay passed default absence,
  skill discovery, MCP reload, generation, two edits, zero-call redisplay,
  saved-task restart/resume, and a new enabled task.
- Real `gpt-5.6-sol` selection with the built-in imagegen skill coexisting passed
  generation, two edits, and original redisplay. Each requested image operation
  issued exactly one fixture-provider call; redisplay issued none. Final replies
  embedded the actual saved image path, and edits preserved source pixels/IDs.
- The separate real-model missing-MCP replay passed the same sequence via the
  helper, with three normal helper approvals, exactly three image operations,
  no duplicate adapter-side saves, and zero image calls for redisplay. Its
  observed file reads loaded the entrypoint/helper reference for fallback
  generation, deferred the editing reference until editing, and performed no
  guidance reads for redisplay. It installed no Python/SDK dependencies and
  did not switch endpoints.
- All replay pixels were synthetic; no real image-provider request was charged.
  The user's installed configuration, running adapter, and client files were
  not changed for verification. The existing 0.8.1 chat-thumbnail mechanism is
  unchanged; this release did not repeat manual UI click acceptance.

Final `npm run verify` passed on Node 22.20.0: **777 tests, zero failures**,
offline HTTP smoke, all existing performance/resource gates, and npm package
dry-run. The documentation-link gate first caught the release index entry
before this report was present; the report was added and the complete gate
rerun successfully. No production-path change was needed for that failure.

The actual 228,068-byte npm tarball includes all three Markdown templates and
has no install-time activation hooks. Its extracted installer passed disabled
no-write, enabled four-file installation, template substitution, helper help,
idempotence, full disable cleanup, and Skill Creator validation checks.

## Performance and remaining boundaries

The source entrypoint shrank from approximately 670 whitespace-delimited words
to 352. A normal generation need not load editing or helper procedures. This is
a context-size comparison, not a promised latency percentage; conditional
reference reads still have a cost when their workflow needs them.

No new dependencies, startup network probes, model calls, generation retries,
image re-encoding, or work on the ordinary Responses/Fast/Auto-review path were
added. Disabled-image startup does not load the new templates. The installer
reads two additional owned references only for image-guidance maintenance.

The existing local gates measured adapter import at 37.0 ms / 57.8 MiB RSS,
zero reads while downstream was blocked, 59,792 bytes of retained image-work
heap growth, and zero retained ArrayBuffer growth. These passed the existing
budgets and are machine-specific observations, not universal performance
guarantees.

Edit IDs retain their existing adapter-memory lifetime. Saved images are not an
arbitrary uploaded-image editing service. The helper remains a bounded fallback
for missing MCP tools, not recovery after an ambiguous dispatched request.

References: [OpenAI skill documentation](https://developers.openai.com/codex/skills)
and [MCP server instructions](https://developers.openai.com/codex/mcp#supported-mcp-features).
These measurements and observations describe this release environment, not
every future client, model response, or provider.
