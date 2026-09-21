# CCDX 0.8.3 verification report

Date: 2026-09-21. Baseline: `a0023cb` (0.8.2).

## Scope and release invariant

Fix image MCP configuration ownership and isolate optional image maintenance
from core GPT startup. Image enablement must not turn an image-only failure
into failure of the proxy; users without enabled images must not enter image
maintenance. No changes to model routing, Fast, Auto-review, stream recovery,
generation/edit APIs, image content, or chat thumbnail delivery are included.

The original failure, redesign, and initial bounded review are documented in
[configuration recovery](IMAGE_MCP_CONFIG_RECOVERY.md).

## Isolation confirmed before release

The release check identified two gaps in the initial fix: disabled startup
still requested image maintenance with `false`, and an image-only write failure
could still fail the shared configuration write. Both were corrected:

- Commit essential GPT configuration independently, with image maintenance
  omitted. Shared TOML/UTF-8 and essential file-write errors remain explicit.
- When images are not enabled, stop there. Do not rewrite/remove image entries,
  load/install the image Skill, or probe an image endpoint. The only image state
  check is the local saved-provider check; malformed/unreadable provider config
  is treated as inactive without blocking core startup.
- When enabled, handle image computation and persistence in a separate optional
  failure boundary. Warn and preserve core readiness if this stage fails. Do
  not undo successful GPT setup, overwrite a detected intervening config edit,
  or install new guidance after image setup fails.
- Keep Skill maintenance in its existing separate warning-only boundary.
- Keep generation asynchronous and bounded; an image provider that is pending
  or fails must not prevent independent GPT requests. No image retry or provider
  substitution is added.

Compatible existing MCP entries are reused without comment markers. Updates
and removals target TOML declarations, not comment-delimited byte ranges.
Unrelated or ambiguous user settings stay intact. Explicit `disable-image`
continues to remove recognized owned configuration, credentials, and guidance;
normal disabled startup no longer performs cleanup implicitly.

## Verification

The focused configuration tests and nine-scenario real-CLI isolation replay
passed before the final release gate. The replay uses separate temporary
profiles, fake credentials, synthetic upstream responses, and random loopback
ports; it does not call real GitHub/model/image services or modify the active
user profile.

It covers compatible markerless setup, conflicting MCP registration,
image-only file-write failure, user-owned Skill conflict, malformed provider
configuration, pending/failing image requests, disabled profiles, disabled
profiles with stale image entries and an inaccessible Skill layout, and invalid
shared TOML as a fatal core-error control. Cold start, existing-adapter reuse,
health, and synthetic GPT Responses are checked. During a pending image request
and again after its failure, GPT requests succeed; the image is dispatched once.

Unit fault injection also covers missing-file setup, adapter address changes,
image-only write denial after core commit, and an intervening external config
edit. All keep core settings usable without claiming a failed image update
succeeded. The CLI replay is included in GitHub CI on both supported Node lines.

Final release verification passed on Node 22.20.0:

- `npm run verify`: **800 tests, zero failures**, offline HTTP smoke, existing
  performance/resource gates, and npm package dry-run.
- Nine-scenario startup/runtime replay passed. Instrumented MCP-route and image
  upstream counters remain zero in all startup/reuse cases; only the explicitly
  requested pending/failing image scenario records one of each.
- Installed Codex `0.155.0-alpha.9` image replay passed tool discovery/reload,
  generation, two edits, final-image Markdown, zero-call redisplay, new tasks,
  and saved-task resume. Pixels and model responses were synthetic.
- The extracted 229,990-byte npm package passed version, disabled no-write,
  conflicting-image/core-readiness, and template-inclusion checks. It contains
  no install-time activation hooks or replay-only preload fixtures.
- Existing resource gates measured adapter import at 41.0 ms / 58.1 MiB RSS,
  59,536 bytes of retained image-work heap growth, and zero retained ArrayBuffer
  growth. A warmed on-disk configuration comparison with 80 synthetic projects
  measured 0.713 -> 0.669 ms disabled and 0.648 -> 0.625 ms enabled versus 0.8.2
  (median of three 40-call batches). These are local observations, not universal
  timing guarantees. No work was added to ordinary model-request handling.

## Boundaries

This is image-feature fault isolation, not suppression of unrelated failures.
An invalid shared Codex config or inability to write essential GPT configuration
still fails clearly and preserves the original file. Optional image failures
can leave image setup unavailable until the user resolves them; GPT continues.
No client patch, forced restart, live migration, or change of user credentials
is needed for this release's tests.
