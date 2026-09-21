# Image MCP configuration recovery

Initial local fix verified 2026-09-21 against release `v0.8.2` (`a0023cb`).
This report records the initial 797-test stage. The subsequent
[0.8.3 release report](RELEASE_0.8.3.md) documents stronger core/image write
isolation and disabled-profile guarantees added before publication.

## Failure and design

The released configuration writer identifies its image registration using two
comment markers. Removing those comments without changing any MCP values
reproduces `Codex config already defines [mcp_servers.ccdx_image] outside the
CCDX-managed block`. The startup exception then closes the newly opened adapter.
This reproduces the failure mechanism; it does not establish which application
or edit removed the user's original markers.

The replacement separates compatibility, ownership, and startup failure policy:

- Reuse a compatible image endpoint in place. Comment absence, partial/duplicate
  markers, quoting, key order, equivalent URL spelling, and custom timeout/tool
  policies do not require rewriting it. An explicitly disabled registration is
  not silently re-enabled.
- Automatically migrate/remove only recognizable CCDX defaults. Recognition
  checks the effective keys and values, the configured endpoint, and where
  needed the previous core adapter origin or narrowly scoped legacy markers.
  A remote user endpoint is not adopted merely because it shares the previous
  model-provider origin.
- Edit actual TOML declarations, never an arbitrary range between comments.
  Preserve other MCP servers, projects, credentials, inline comments, and
  marker-like text inside strings.
- Catch only optional image-configuration conflicts at startup. Recompute core
  setup from the original content with image maintenance omitted, not with
  images disabled. Preserve the existing image configuration and warn only
  after core setup succeeds. Do not install new image guidance for a conflicting
  registration.
- Keep invalid TOML/UTF-8, filesystem errors, and core-write failures explicit.
  They are not converted into successful startup and do not overwrite the
  original configuration.

No ownership sidecar, extra daemon, runtime network probe, dependency, retry
loop, or client patch was introduced. Users who have not enabled images still
receive no image MCP registration or Skill. Provider credentials, image tools,
generation/editing, delivery, Fast, Auto-review, and model transport are not
modified by this patch.

## Deliberate preservation boundaries

Custom or ambiguous registrations are not claimed merely because of their
server name. Shared inline parents are reused when already compatible, but are
not reserialized to update/remove one member; their siblings may include
user-maintained settings or credentials. Startup warns and preserves such a
conflict while core service continues. Explicit `disable-image` still removes
the CCDX provider credential and owned guidance, so CCDX image calls fail closed;
unrecognized/customized MCP configuration can remain for the user to manage.

Existing recognized registrations continue to support adapter address changes,
including IPv6, and normal enable/disable cycles. No-op edits preserve final
newline choice and CRLF bytes. The original CRLF implementation temporarily
left a lone CR at EOF; preserving the working newline fixes that parse failure.

## Bounded review and tests

One focused source/behavior review covered only configuration ownership,
startup failure isolation, opt-in gating, safe edits, and relevant regressions.
Related findings were corrected once, including no-op final-newline handling,
default HTTP-port URL comparison, and avoiding a continuation warning before
a failed core write. A replay-only preload was moved outside test autodiscovery
after the first full gate correctly rejected running it without its isolated
environment. No unrelated optimization followed.

- `npm run verify`: **797 tests passed, zero failures**, plus offline HTTP smoke,
  existing performance/resource gates, and npm package dry-run on Node 22.20.0.
- Config regressions include missing/start-only/end-only/reversed/duplicate
  markers, quoted/dotted/inline-leaf/multiline values, CRLF, marker-like strings,
  default ports, IPv6 migration, disable after marker loss, exact no-op writes,
  custom policy preservation, shared-inline parents, secret-safe warnings,
  invalid TOML/UTF-8, and simulated write denial.
- `node scripts/config-startup-replay.mjs` passed the actual CLI's cold-start
  and existing-adapter reuse paths for markerless, conflicting, and disabled
  image setups. Health and synthetic GPT Responses succeeded in each case;
  configuration bytes stayed unchanged. No new Skill was installed for disabled
  or conflicting image registrations. Invalid TOML remained fatal, preserved
  its file, and closed the fixture adapter.
- `node scripts/codex-image-replay.mjs --codex <installed-codex> --edit` passed
  on installed Codex `0.155.0-alpha.9`: discovery, MCP reload, generation, two
  edits, final chat-image Markdown, zero-call redisplay, and saved-task resume.
  Original pixels and source handles were preserved. This is protocol/behavior
  replay, not a new manual UI screenshot acceptance test.
- All replay credentials, model answers, and pixels were synthetic. The running
  user adapter and real configuration were neither changed nor restarted.
  A read-only calculation on the current user config returned unchanged bytes.

The configuration-only comparison against 0.8.2, using 80 synthetic project
entries, three warmed batches of 40 calls each, measured median per-call times
of 0.570 -> 0.515 ms with images disabled and 0.619 -> 0.518 ms enabled. The
existing resource gate retained 59,360 bytes of image-work heap growth and zero
ArrayBuffer growth. These are local measurements, not universal timing claims;
no work was added to the request hot path.

The pre-existing draft was backed up outside the repository before replacement.
No commit, version bump, publication, or live configuration migration occurred
during this initial stage; release preparation is recorded separately above.
