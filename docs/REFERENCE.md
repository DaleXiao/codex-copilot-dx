# CCDX reference

For installation and first use, start with the [README](../README.md). This reference covers operations and the limits that affect them. CI and prebuilt releases cover macOS ARM64 and Windows x64/ARM64. Intel Mac code and runtime paths remain available, without CI coverage or new prebuilt assets.

## Commands

`ccdx` is the only executable. Commands and help use one grammar. Use `ccdx help <path>` or append `--help`; old roots and flag aliases are not accepted. Existing saved settings remain readable.

| Group | Operations |
| --- | --- |
| `ccdx` / `ccdx start` | Start or reuse the foreground gateway |
| `ccdx web` | Open the Web UI, or start management without signing in |
| `ccdx status` | Show runtime and app configuration; `--details` expands diagnostics |
| `ccdx source list` / `source add` | List sources or add an API |
| `ccdx source <id> status` | Read saved account and catalog evidence |
| `ccdx source <id> models [--refresh]` | Read cached models, or explicitly refresh the source |
| `ccdx source <id> check` | Check source access without inference |
| `ccdx source <id> access --edit` | Choose allowed apps |
| `ccdx source <id> enable` / `disable` | Change source access; disabling reviews affected apps |
| `ccdx source <id> edit` / `remove` | Edit an API, or remove a disabled, unbound API |
| `ccdx source github login` / `reauth` / `logout` | Manage the saved GitHub account |
| `ccdx source m365 accounts` / `account` | List local company accounts or select one |
| `ccdx app list` | Show client setup and observed activity |
| `ccdx app <id> status [--details]` | Read client configuration and scoped features |
| `ccdx app <id> models --edit` | Choose visible models and a default |
| `ccdx app <id> sync --preview` | Preview the model/configuration plan |
| `ccdx app <id> sync` | Write client settings owned by CCDX |
| `ccdx app <id> enable` / `disable` | Change access without quitting the app |
| `ccdx app codex prediction …` | Native suggestion setup and diagnostics |
| `ccdx app codex image …` | Native image controls and model selection |
| `ccdx app codex review status` / `select` | Read or choose the review model |
| `ccdx config show [--effective]` | Read saved preferences and effective state |
| `ccdx config set <key> <value>` | Save a validated preference |
| `ccdx config privacy status` | Read model readiness, detection work, wait budget and latest reply failure |
| `ccdx config privacy enable` / `disable` / `remove` | Prepare protection, stop later checks, or delete its model |
| `ccdx config terminal` / `animation` | Choose terminal appearance |
| `ccdx config limits [--decoded MiB]` | Read or change the decoded request limit |
| `ccdx config reset --preview` / `restore` | Preview defaults or restore the pre-reset backup |
| `ccdx requests [--failed] [--active]` | Inspect retained requests |
| `ccdx requests show <request_id>` | Read one retained request |
| `ccdx usage [--scope all\|run] [--provider ID]` | Read recorded usage or current-run usage |
| `ccdx doctor [--online] [--compat] [--fix] [--json]` | Check local setup; optional access checks and repairs |
| `ccdx doctor config` / `network` / `report` | Read configuration, routing or a redacted local report |
| `ccdx doctor cache [--limit MiB\|default]` | Inspect runtime buffers or change their limit |
| `ccdx doctor cache --clean [--history] [--yes]` | Clear rebuildable data; history cleanup requires confirmation |
| `ccdx update check` / `update github` / `update npm` | Check or install an update |
| `ccdx version` | Show the installed package version |

Client IDs are `codex`, `claude-app` and `claude-code`. Source IDs are listed by `source list`. Read-only management commands support `--format table|plain|json`. They do not start an app or a gateway. Native image/suggestion status also reads local setup when the gateway is stopped; JSON includes the saved configuration flag and the same public details. Management operations need the running service; use `ccdx web` to start it without launching a client.

`start` supports `--no-browser`, `--verbose` and `--show-request-id`. The normal TUI has one source summary and one app table. It labels the Web UI address directly. `Unchanged` means existing client settings were kept; `Configured` means the configuration write/check succeeded. Neither is proof that a client process has loaded that configuration. Warnings and sign-in instructions remain visible during startup. The final activity row reflects observed model work. Ctrl+C stops the foreground service.

For scripts, source access accepts `--apps codex,claude-app` with `--edit`; edits use confirmation or `--yes`. API/model edits accept `--file`. An API key uses the private prompt, `--key-stdin`, or an environment reference, never a command argument or metadata file. Source removal requires a disabled API with no client binding. Disabling an in-use source requires explicit replacement choices in scripts; `--yes` alone does not choose them.

An app model file contains `deployments: [{"source":"github","model":"<model-id>"}]`, with optional `default_model` and `auto_sync`. An explicit empty array clears the default and pauses access. A file without `deployments` is rejected. Unavailable saved selections remain visible until the user changes them.

## Gemini App and Antigravity (candidate)

The optional **Gemini** page and `ccdx app gemini status|models|enable|disable|open`
manage the original macOS Gemini App. Enable requires acceptance of this data
scope: Antigravity main answers follow the selected Google or Copilot model;
all Antigravity summaries, searches and image generation use GitHub Copilot,
including background work from Google-model sessions. Ordinary Gemini chat
keeps its Google route. No OpenAI account or search fallback is used.

Carbon and Argon appear with Low, Medium and High reasoning levels when the
Copilot account advertises them. Google models, account controls and defaults
are retained. Conversations keep their initial Google/Copilot source; start a
new conversation to change source. Unsupported PDF, audio and video inputs are refused
before Copilot dispatch. Text, inline images and native function tools are
converted to the advertised Copilot Chat interface; truncated streams report an
error rather than successful completion.

`enable` saves CCDX settings and prepares its local source guard. `open --preview` shows the launch plan.
`open` starts a closed, signed `/Applications/Gemini.app` with a process-local
Antigravity endpoint. An already running App is kept open and must be quit by
the user before reopening. Existing gateway environment settings cause a
conflict instead of being overwritten. The Gemini bundle, Google credentials,
global proxy and certificates are untouched. Endpoint adoption remains
unconfirmed until an Antigravity request is observed.

`disable` removes Copilot model access and refuses later Copilot/background
requests without sending them to Google. Quit and reopen Gemini through CCDX
after disabling to restore its native endpoint. This integration is separate
from the Codex/Claude source bindings and is off by default. Native-engine
replay alone does not establish parent-App adoption; observe actual original-App
requests and check ordinary Gemini chat when accepting a new App version.

## Context observations

**Usage → Context** shows reported input, declared model windows, cache reuse and observed gateway compactions from this process. It leaves missing values unknown. Input share is reported input divided by the declared window; it is not a measurement of every item currently held by the client. Reused input still occupies context.

Messages observes the selected model's effective capability snapshot after alias resolution. Legacy connections use cached catalog metadata when no snapshot is supplied. Missing or invalid windows remain unknown; no size is inferred from model names. Existing provider-applied capability observations keep their priority. This adds neither catalog refresh nor inference calls, and does not change request bodies, replies or token-count probes.

Only explicit, bounded session IDs can link requests. Local display identifiers replace native IDs and titles; account/profile, app, source, model and declared subagent identities remain separate. Unidentified requests appear individually. Concurrent observations are points rather than a connected conversation curve. Compaction records cover observed Responses compact calls, not every client-side summary, and their elapsed time includes the whole gateway request. No before/after size is invented from summary output tokens.

Each protocol observer retains at most 64 series of 64 request points and 16 compaction records, plus 20 unidentified requests. These numeric observations are memory-only and reset on restart. The page reads them on demand and after observed request completion through the existing dashboard refresh controller; ordinary status payloads do not include them. There is no prompt storage, text tokenization, transcript scan, extra provider request, content breakdown or compression control.

## Sources and client access

When Claude App encrypts a CCDX-owned gateway key, synchronization keeps the encrypted value and can still update owned model fields. The expected local key must match CCDX's ownership record; foreign profiles, addresses, rotated keys and user edits are not adopted. The sync result can report that the key was kept encrypted without claiming verified access. No system keystore decryption or extra permission is used.

Clicking the Web UI logo plays one brief rotation and keeps its Overview navigation. System reduced-motion preferences disable this effect. The header uses a link icon for the local connection; the request-flow total uses a circled ellipsis for active requests.

Upgrades retain saved account bindings, source IDs, key references, model choices/defaults and capability overrides. Native account stores keep their existing owner; bookkeeping does not request another login. Unchanged client settings need no repeat save or synchronization. Explicit user changes and ordinary credential renewal keep their current behavior.

Sources own accounts, API addresses, keys and model capabilities. Apps own visible models and defaults. Allowing an app to use a source does not select all its models. Selecting no models pauses that app. Settings owns service preferences and appearance, not model routing. An unchanged graph save keeps the file bytes and modification time; explicit sync, refresh and credential actions still run. Existing v1 configuration is backed up byte-for-byte before its first v2 write; reads do not migrate files.

In the Web UI, **Model sources → Add API** saves the source and immediately reads its catalog. A failed read keeps the saved source and editor. Select supported models and their declared interfaces before assigning them to apps. Table details expand downward without shifting their controls or redistributing columns, including request metadata and check results. API-editor capability details open below their model row; manual overrides are separate from reported metadata.

Manual APIs require HTTPS. Codex requires Responses; Claude requires Messages. CCDX does not invent an interface, token-count result, reasoning level or web-search capability absent from the source declaration. Returned maker/name metadata is displayed separately from the source name. Model IDs are not used to guess a maker.

A running request stays with its original source, credential revision and capabilities. Refreshing a catalog does not select models or change defaults. Failed reads keep last-good data with failure evidence; they do not trigger inference, re-login or source switching. Normal API refresh uses a 30-minute cache and a one-minute minimum interval after explicit reads or failures.

Codex selections containing only GitHub models keep native OpenAI mode and readable names. Other selections use the client's private local gateway credential. Paused access is rejected before credential validation. CCDX does not write or clear native ChatGPT sign-in data. When models are missing after a client update, check the selected models and run `ccdx doctor`; fully quit and reopen the app before changing credentials.

Old conversations keep their recorded provider identity. Codex 0.166 requires the currently selected provider to match that identity; a per-resume override does not bypass this check. Continue a legacy custom-provider chat with its original provider selected. CCDX retains the inactive, unchanged legacy provider table and does not silently rewrite chat metadata or switch the global native default back to a custom provider.

Claude App and Claude Code use separate keys on `http://127.0.0.1:2026/anthropic`. Compatibility aliases are internal; visible model names follow source metadata. Client synchronization respects manual/managed fields and records ownership for restoration. Already-running clients may need a normal restart.

Claude App can continue an existing conversation on another selected, authorized source when complete Messages history is available. Unfinished tool turns, unavailable attachments and company-account isolation are checked before transfer. Opaque signed or compacted history is not transferable between services. Codex and Claude Code keep their existing continuation rules. A 409 is a history/isolation conflict; it does not by itself mean the selected model is unavailable.

Model details show exclusion reasons only when applicable: app/source disabled, source access not granted, missing interface, source restriction, missing catalog entry or no selection. These are configuration/catalog facts, not an online capability test. Expected local GET/HEAD discovery replies are listed separately under Requests → Service probes. Raw HTTP counters remain unchanged; unknown paths, security denials and actual call failures remain inspectable.

## Microsoft 365

Supported company environments discover local accounts at startup. Access depends on the account, tenant, device policy and service entitlement. Optional failure does not block another source.

Choose consuming apps under **Model sources → Microsoft 365 → Allowed apps**. Read the company catalog with `ccdx source m365 models --refresh`; this sends no inference. Use `source m365 accounts` to list accounts or `source m365 account` to choose one. Existing explicit account selection takes priority, followed by an exact Windows work-account match or the single available company account. Account changes require a new conversation.

Catalog diagnostics distinguish local cached data from an online response and expose check time, service origin, HTTP status, last success and service request ID when available. Model counts can differ across environments. A 403 alone does not prove a stale cache, an expired account or a changed endpoint. Do not repeatedly sign in or probe inference to diagnose catalog failures.

## Checks and troubleshooting

- **Saved account, access denied:** use source status/check to distinguish the saved credential from current access. `source github reauth` replaces sign-in only after a successful new login. Other apps' credentials are read-only.
- **No client models:** inspect allowed sources, selected models and unavailable selections. An empty selection means paused access, not missing credentials.
- **Configuration unchanged:** CCDX kept existing settings. Preview the intended plan before syncing; do not overwrite managed settings to force success.
- **Request failure:** use Requests or `ccdx requests --failed`. HTTP failures and model completion outcomes are separate. A successful HTTP transport can still carry a model error.
- **Token counting unavailable:** an observed API count-endpoint 404 is cached briefly per model/header scope. Inference and token counting are separate capabilities; no synthetic count is returned.
- **Local checks:** `doctor` is read-only by default. `--online` checks access; `--compat` sends minimal inference and consumes usage. `--fix` backs up owned configuration and performs bounded repairs. It does not enable optional features, change company policy or force-restart apps. Partial repairs exit 1.
- **App updates:** after the service is ready, CCDX observes installed App versions in the background. Checks & repairs shows the result; `ccdx doctor` can inspect it locally. On macOS this uses known App bundle metadata and, when available, the bundled Codex CLI version. On Windows the registered Codex package is inspected; Claude App remains unknown if reliable metadata is unavailable. The running process may still be an older build, and a version observation does not verify images, predictions, model access or protocol compatibility. A detected unrecognized Claude App major version preserves existing shared capability fields during later synchronization. The compact local version record contains only App versions, builds and observation times, not credentials or conversation data. It is refreshed on startup, local checks and the existing model-refresh cadence; a reused service receives a nonblocking refresh notification.
- **Cache cleanup:** adding `--history` can break the next continuation. It does not delete client transcripts or generated images.

Request inspection covers bounded retained records, not a full conversation archive. Unidentified clients stay unidentified. Routine diagnostics omit secrets, prompts and error bodies. Explicit error excerpts use bounded, redacted collection. The usage JSON `requests` field counts recorded usage rows, not HTTP calls. Usage is returned token metadata; cache hit is reused input divided by input from records with valid counts for both. Unknown/invalid records remain in token totals but are excluded from both sides of the rate, with partial coverage indicated. It is not a request-based cache rate or a billing receipt.

For an identified conversation, hovering a point in the input-history chart shows that request's available cache-reuse ratio. Missing or invalid counts remain unknown; the bounded in-memory history and retained usage do not change.

## Settings and appearance

Settings separates saved preferences from effective state. Auto-save applies changes by default; required restarts remain explicit. Restore-defaults creates a backup first and keeps accounts, keys, model plans and chats. CLI preference reset/restore uses its own service-only backup; it does not change browser appearance or replace the Web UI's backup.

Web and terminal colors are independent. Web appearance is browser-local. The terminal keeps its selected color and animation; NO_COLOR, dumb/non-TTY and narrow output remain supported. Reduced motion disables decorative movement. Closed tabs and hidden views stop scheduled work. Model/usage data loads on demand; the Web UI adds no inference calls.

Activity, flow and current-run counters use one visible-page SSE connection at `/_ccdx/activity`. TUI activity subscribes to the same in-process notifications. Request starts, model/provider selection, first output, retries and completion coalesce within 50 ms; ordinary output chunks do not trigger pushes. A connection starts with current memory-only state, including the existing recent-request limits. Reconnection restores current state and totals; it does not replay animations or recover arbitrary old history. No replay buffer or durable event store is added.

The stream sends a small heartbeat every 15 seconds; the browser replaces a silent connection after 45 seconds. Hidden/suspended pages and Auto refresh OFF close the stream; returning reconnects with a fresh snapshot. A lost connection means activity is unknown, not idle. The old six-second snapshot expiry applies only to manual HTTP snapshots, not healthy push state. Catalogs, accounts, retained usage and update checks keep their separate on-demand/low-frequency reads. Visible context series refresh after request completion through the existing bounded reader.

Push reads do not invoke the complete diagnostic snapshot, read usage files, refresh credentials/catalogs or send inference. Up to eight native/same-origin loopback streams are accepted. Slow streams keep at most one newer snapshot and close if still blocked at the next heartbeat. Streams are excluded from request/work counts and closed before normal service shutdown. TUI static setup/preferences retain a ten-second local read; live activity does not wait for it. Animation frames and elapsed-time updates remain local. Existing reduced-motion and terminal output controls remain.

Desktop spacing keeps existing fonts, palettes, navigation and disclosure anchors. The header is 64 px at desktop widths; its existing narrow-screen layout stays responsive. Panels use 16 px padding and ordinary rows use 7 px vertical cell padding. Standard controls are 32 px high and inline source/model actions 30 px; coarse pointers retain 44 px controls. Multi-line animation choices retain their natural height. Compact padding does not change model lists, draft fields, settings behavior or focus outlines.

## Installation and updates

Use the installers linked in the [README](../README.md) when Node.js is unavailable. They support macOS and Windows on x64/ARM64, reuse a compatible Node.js, or install verified Node 24.22.0 privately. They do not install Git, compilers or system package managers, or change company registry/proxy/certificate/shell policy.

New complete Release packages and privacy binaries are published for macOS ARM64 and Windows x64/ARM64. Intel Macs retain the source-package installation path and can reuse verified compatible privacy components or build locally; new Intel binaries and CI validation are not provided.

Complete Release packages include locked runtime dependencies. The updater verifies package identity, version and digests before installation, backs up the discovered package and launchers, and restores them on installation/runtime-check failure. A busy installation fails in place. Lock errors include the lock path; do not delete a lock held by another install.

`ccdx update github` uses the latest stable Release. Normal source-package installation uses the configured registry. After npm EALLOWREMOTE, the updater can use a verified same-version complete platform package without relaxing npm policy. Other failures are not retried across arbitrary sources. Explicit `--allow-remote` grants URL downloads to that installation's whole dependency tree, not one hostname; use it only if policy permits. No persistent npm setting changes.

Finish active work before updating the active installation, then restart CCDX normally. The installed package version can differ from the running process. No interruption-free upgrade is promised for an ordinary foreground service.

Overnight updates are opt-in. The supervised service checks within its local midnight window, stages only eligible patches in the same minor version, and waits for idle work before handoff. Candidates must be published for at least 24 hours. Failed preparation/handoff retains or restores the previous service. Enabling this feature requires its documented normal restart; it does not attach a supervisor to an existing ordinary process. Minor upgrades such as 1.2 → 1.3 remain manual.


Terminal palettes are green (default), Klein blue, soft pink, black & white (`mono`) and orange. Choose one in Settings → Terminal appearance or with `ccdx config terminal`. Black & white follows the terminal's default foreground without changing its background. Orange adapts to truecolor, 256-color and ANSI; an explicit light `COLORFGBG` uses a darker orange. Non-TTY, `NO_COLOR` and dumb-terminal output keep their plain behavior. Web color remains independent.

## Model capabilities and Claude synchronization

An explicitly selected default keeps its identity when its catalog entry becomes
unavailable. CCDX does not substitute the first model or rewrite that client's
existing configuration. Other authorized models remain in the catalog and can be
requested explicitly; an unavailable model produces a model error rather than a
sign-in challenge. The application page retains the unavailable selection and
asks for a valid default before saving. Catalog recovery restores the same route.

API saves complete independently of metadata reads. Catalog network work runs
outside the configuration transaction; only a version-checked result commit
holds that queue. Same-source, same-deployment reads join the active request.
Changing its endpoint/key, disabling the source, cancelling the read or stopping
the service prevents obsolete results from publishing. Failed reads retain saved
metadata and selections. Capability commits synchronize only affected clients;
shared Claude settings still respect both consumers and manual ownership.


Model sources owns source credentials, native interface declarations and model details.
Codex/Claude own the selected deployment set, default and automatic synchronization.
Claude App and Claude Code have separate segments and local keys. Settings retains
appearance, startup and updates; source/client editors are not duplicated there.

Codex catalogs and its `model` setting use an unambiguous upstream ID. Source
suffixes appear only for same-named authorized deployments; friendly upstream
names/descriptions are retained. Internal defaults and route aliases remain
source-qualified, so adding another same-named source cannot move an existing
default. Existing qualified IDs continue to resolve to their original source. During the
one-time native ID migration, a complete cache containing exactly the recognized
old selected route IDs is moved to `models_cache.json.ccdx-qualified.bak` with
private permissions. The client then reads the current directory; unknown or
partial caches and native authentication/session data are preserved.

A deployment is identified by source plus actual model ID. Its stable public route
is independent of catalog order and key rotation; its private history/evidence
identity includes endpoint, authentication and credential generation. Same-named
models from two sources remain separate. Old unqualified IDs/aliases resolve only
when unambiguous. A closed source removes its selected bindings; restoring the
source alone does not reopen model access. There is no intent router, load balancing,
model substitution, cross-source retry or automatic protocol conversion.

Each custom model accepts an optional `capabilities` object with positive token
limits (`context_window`, `max_input_tokens`, `max_output_tokens`), reasoning flags,
`reasoning_efforts`, optional reasoning budget bounds/format, `thinking_modes`, `input_modalities`,
boolean tools/parallel tools/streaming/structured output and a `web_search` array
of supported native protocols. Empty arrays mean an explicit empty set; in the
editor enter `[]`. Blank fields follow the current deployment catalog. Known
numeric limits, flags and enums are strictly validated; arbitrary JSON is rejected.

Discovery retains recognized structured fields with per-deployment timestamps.
The existing common catalog fields and Anthropic ModelInfo declarations are
supported. Anthropic `max_input_tokens`/`max_tokens`, thinking types, effort
levels, image input, structured output and native search are interpreted as
Messages capabilities. They do not automatically apply to Responses or Chat.
Effort and thinking modes remain distinct; declaring a server-side search tool
does not prove support for client tool calls. The current upstream's declarations
are authoritative for that deployment, not a model-name database or the original
vendor's published limits. See the [Anthropic Models API](https://platform.claude.com/docs/en/api/http/models/list).
Model details show values by interface, then optional manual overrides. ID-only
catalogs say that upstream did not provide capabilities; unrecognized capability
formats have a separate state. Parsed values are saved, not raw upstream JSON.
Manual fields, including false/empty arrays, take priority over API declarations.
ID-only results keep missing fields unknown. A failed refresh preserves saved
metadata and records a bounded error; a changed endpoint/key invalidates prior
catalog evidence. A listing or minimal successful reply is not a capability test.
Ordinary page reads use saved data and never probe each model. No public model-name
heuristic or original-vendor limit is applied to an arbitrary relay deployment.
The managed Codex catalog uses an explicitly declared input modality in preference
to the native template. Unknown modalities retain the existing template fallback.
For GitHub models, fast/priority tiers are shown only when the full source catalog
supports the existing priority route, including an eligible fast variant that is
not itself selected in the model picker.

Claude configuration and gateway catalogs use the same compiled model plan.
Explicit App bindings use opaque source-qualified aliases and actual model/source
labels. Verified 3.x and 4.x App adapters can use a reasoning-compatible route when the
advertised levels form a client-expressible contiguous set. When a declaration has
a gap after at least two lower levels, the App can select that safe lower prefix;
the higher levels are reported as limited and remain in the source declaration.
For example, `low/medium/high/max` shows `low/medium/high` without inventing
`xhigh`. Older compatibility routes remain resolvable for that authorized
deployment. Unsupported effort requests fail explicitly.
No tool permission or safety-review setting is disabled for compatibility.

The App Code host and independent Code share some settings. CCDX plans them once,
then applies field-owned changes through the existing rollback journal. A known
managed set entirely within 100K–1M can use the largest shared host window and
per-model `modelSettings.<route>.autoCompactWindow` budgets. The shared display
window is not each model's context limit. Unknown, 64K, above-1M or unverified
consumers prevent this global context override. Existing manual/managed values
remain unchanged. Unknown client builds retain working catalogs and report the
advanced host limitation. Code package/native-path version detection is read-only;
it does not install or run a version probe at startup.

The host output override is written only when all managed consumers declare an
output limit and is capped at 128K by the adapter. The gateway also clamps each
custom Messages/Responses request to that deployment's declared maximum, records
`capability_revision`/`capability_constraints`, and never deletes conversation
history to fit a budget. Reasoning-budget conflicts and unsupported declared
levels fail locally. Native search is recorded per protocol: Responses support
does not imply Messages support. Native tool/citation/replay data remains on the
existing protocol path; no shared search executor or external search account is
added for custom APIs. GitHub Copilot's Gemini 4 Carbon uses its separate search
path described below. Exact input counting and compression thresholds are not proven by a small
reply; the upstream still enforces its actual limits.

Automatic sync can be disabled per client. Shared Claude fields are preserved
when a shared consumer has disabled automatic sync. Closing access restores owned
client connection fields; other active consumers retain shared planning. Review
sync shows declared capabilities, supported budgets and limitations. Reopen the
client after its owned configuration changes. All tests using sample capabilities
are isolated; they do not assign sample limits to a user's real models.


## WebUI and CLI controls

Normal management belongs in the WebUI. CLI provides the same backend operations plus scripting and recovery:

| WebUI task | CLI | Effect |
| --- | --- | --- |
| Accounts, APIs and models | `source`, `app <id> models` | Shared connection graph, catalogs and credential storage |
| Client access and synchronization | `app <id> enable/disable/sync` | Preview/recheck ownership; no forced App exit |
| Delete a disabled, unbound API | `source <id> remove` | Shared impact revision; selected consumers block deletion |
| Input suggestions: enable/disable | `app codex prediction enable/disable` | Synchronize bridge preference and native Show predictions |
| Prediction setup/remove/repair/open | `app codex prediction setup/remove/repair/open` | Shared control; App closure may be required |
| Images: enable/disable/select | `app codex image enable/disable/select` | Native GHC images; no independent image credential |
| Install a stable update | `update apply --yes` | Same supervisor request; download, verify and idle service handoff |
| Local masking: prepare/disable/delete | `config privacy enable/disable/remove` | Same verified model lifecycle; existing protected replies retain restoration |
| Local masking status and personal information | `config privacy status`, `config set privacy_personal true/false` | Read readiness or change the personal-information choice |
| Standalone update/recovery | `update github/npm`, `doctor` | Available when service management is unavailable |
| Local/network checks, repair and report | `doctor`, `doctor network/report`, `doctor --fix` | Existing checks and configuration repair |
| Explicit model compatibility test | `doctor --compat` | Finite Codex Responses/stream/compaction requests; supports vendor IDs; local client credential stays on loopback; WebUI confirms quota use |
| Decoded request limit | `config limits --decoded <MiB>` | 128–512 MiB; saved for next start; launch environment has priority |
| Usage, requests, appearance and backups | `usage`, `requests`, `config` | Shared service data/preferences; browser appearance stays browser-local |

CLI-only interaction forms include JSON output, file input, key stdin and shell pipelines. Initial installation/startup, a failed service and headless hosts need an external launch/recovery entrypoint. These are not prerequisites for prediction or image configuration. Full runtime-cache purges, batch/file/key-stdin input, JSON formatting and one-installation remote-download exceptions remain advanced CLI operations. Company policy changes remain outside CCDX control.

## Prediction controls

WebUI → Codex → Input suggestions is the complete enable/disable control. Setup and explicit enable write only `desktop.composer-predictions-enabled` in Codex TOML and its legacy persisted-atom equivalent; unrelated configuration/state remains intact. Writes require Codex to be closed. An open App keeps a pending display change. On macOS, the WebUI can apply it during an explicitly requested normal Codex restart; alternatively, quit the App and Continue setup. Windows retains its existing open and manual-close flow. No running App is forcibly closed.

Native configuration and startup environment checks use temporary work threads so OS/crypto work does not block the core service. Missing Apps are checked before trust/proxy setup. A normal cold startup attempts setup once when no CCDX prediction record exists, prediction access is allowed, and the App display preference is not saved off. Failed setup leaves core startup available and can be completed in WebUI. Saved off records and App off choices are preserved. Explicit enable intentionally overrides a prior App display-off setting. Repair keeps the selected on/off intent. Disable retains trust and routing; Remove setup owns trust/route cleanup and may defer cleanup until Codex closes. Visible predictions still require native App/thread eligibility and an actual returned suggestion.

Installed command launches use the existing supervisor and immutable workers. WebUI updates preserve accounts, models and request continuation through verified handoff; failure rolls back to the previous installation/runtime. Warm version handoff does not perform first-time setup or apply pending App display writes. Prediction intent/trust participates in the handoff fingerprint; port allocation and App stat bookkeeping are runtime data. Manual updates do not enable the overnight schedule, do not downgrade, and defer while requests or settings operations are active. Launches outside a writable matched installation display their limitation explicitly.

## Optional native predictions

New native next-message integrations **attempt setup by default when Codex is closed**. Existing CCDX or App off choices are retained. They use no MCP, Hook, skill,
panel, renderer injection, or client-program modification. This compatibility
feature uses the App's existing composer UI and the conversation's
selected model through CCDX. Suggestions are not sent automatically. Native
eligibility rules still apply; availability is not promised for every thread type.

App identity is verified through system installation metadata and platform trust,
without scanning internal App archives. Checks are asynchronous and leave account,
model and image settings alone. Existing prediction trust, profile and port are
reused after an App update. Known live configuration schemas determine adaptation;
unknown payloads keep their existing forwarding behavior. No configuration traffic
means unverified availability, not a confirmed incompatibility. Visible suggestions
still require an App-side check. The bridge accepts headers up to 64 KiB; larger
headers fail with bounded stage diagnostics and are not retried.

The `0.9.40` routing revision uses the stable local PAC URL
`/proxy.pac?v=2`, independent of the package version. The primary proxy remains
`127.0.0.1` on the saved port. A secondary, time-bucketed `.localhost` name points
Chromium back to that same loopback listener after a cached proxy failure. Its
name changes every ten seconds when the PAC is evaluated, without a Node timer,
new listener, dependency, port, or background App watcher. Healthy traffic keeps
the original primary connection path. Direct/static/company-PAC fallbacks remain
after the two local entries, and unrelated hosts retain their original route.
The optional listener starts alongside GitHub auth and model initialization;
slow proxy setup does not delay the core adapter listener.

An App that loaded the old PAC must normally quit once to load this revision;
CCDX never force-restarts it or hot-writes an open profile. Subsequent upgrades
keep the revision URL, saved port and trust unchanged. An occupied saved port or
missing App route is not repaired by this retry mechanism. The installed App may
cache a failed prediction configuration for five minutes, and a subsequent
eligible turn may be needed to request another prediction. Returning configuration
traffic is not proof that native gray text is visible. Cross-platform browser
routing is tested separately from the user's native end-to-end acceptance;
the investigation report records these evidence levels without equating them.

Version `0.9.26` adds Windows platform adapters. Native gray suggestions,
adoption/sending and switching predictions off were verified on Windows with the
`.4` candidate. Windows setup
requires a current-user, Store-signed `OpenAI.Codex` MSIX registration (Store and
official offline MSIX use the same registration), an initialized Codex profile,
Windows PowerShell and .NET Framework 4.7.2 or later. Since `0.9.27`, prediction
setup and renewal do not require Git or OpenSSL. Node generates ephemeral RSA
keys; the Windows .NET certificate API signs the same scoped CA/leaf certificate
pair. Private keys travel only through a child-process stdin pipe; only the leaf
key and public certificates are saved in CCDX's private directory. No Windows
certificate store is opened. Existing valid PEM credentials are reused without
conversion or reauthorization. macOS retains its system OpenSSL setup path.
CCDX does not download a runtime or bypass company PowerShell policy; unavailable
system APIs fail the optional setup without preventing core service startup.
Git is also unnecessary for `ccdx update github` since 1.2.1; it uses a verified Release tarball.
Run CCDX using Windows-native Node, not inside WSL. The App's agent may still use
WSL independently. No administrator prompt or execution-policy change is added.
AppData may be virtualized by MSIX: setup selects an existing `Codex/Local State`
profile (also `ChatGPT/Local State` for `ChatGPT.exe`) under roaming AppData or the
package's `LocalCache/Roaming` directory. The nested `Codex/web/Codex/Local State`
layout is also recognized; trust belongs to that nested profile's `Default`
directory, not to its parent `Codex` directory. Setup does not recursively scan
App data. A previously verified profile binding is reused on reactivation;
turning predictions off removes only CCDX trust, not that directory binding.
Absent or initially ambiguous profiles are not guessed; open the App once or set the exact
`CODEX_ELECTRON_USER_DATA_PATH`. Existing App profile trust uses the same bounded
Chromium database schema. Private-key privacy is verified with NTFS ACLs, not
Unix mode bits. No Windows root/personal certificate store is changed.

Windows reads the current user's WinINET proxy configuration through WinHTTP's
query API without changing it. Static proxies/bypass rules compose with the same
environment precedence. Automatic routing uses a separate, persistent Windows
WinHTTP worker and a temporary PAC that delegates unrelated URLs to the original
company script. The script is syntax-checked but never executed in Node. Windows
handles upstream routing, proxy failover, authentication and certificate trust;
the bridge never weakens TLS checks or the OS credential policy. Requests and
responses stream through bounded private pipes; cookies are not cached by the
worker, and redirects are not followed. Only the selected HTTPS hosts use the
bridge; WebSocket PAC URLs keep the original company decision. If native WPAD
discovery reports no PAC, configured static/direct settings are retained. A
configured PAC that cannot be downloaded is not replaced with direct access.
Explicit proxy environment rules combined with automatic routing are currently
preserved and reported as a conflict, not silently merged. The
launcher pins both Chromium `--user-data-dir` and the process-only
`CODEX_ELECTRON_USER_DATA_PATH` to that verified existing profile and passes the
local PAC to the exact registered executable. This prevents a direct MSIX launch
from using another profile without the trust record. An explicit conflicting
profile override is preserved and the optional launch is skipped. There is no
shell, account replacement, new profile, `CODEX_HOME` change or forced App exit. Disabled predictions
add no Windows probe or launch. `CCDX_AUTO_LAUNCH=0` is still respected.

Since `0.9.30`, macOS and Windows remember their own loopback bridge port after
the first successful bridge start and reuse it across service restarts and
package updates. Windows already used this policy in `0.9.26`. Each user setup
gets its own port, not a shared fixed port. A busy saved port is not stolen or
silently replaced; only the optional prediction bridge becomes unavailable,
and core inference and enabled image tools can still start. Port settings are
committed under the existing file lock; a concurrent preference change aborts
and closes the uncommitted bridge. Restarting with a saved port does not rewrite
the preference or rotate certificates. Before launch, CCDX checks only verified App main-process route
metadata. A running App with an old/unreadable PAC receives an explicit quit and
relaunch instruction; it is not killed or reported as newly connected. The first
upgrade from an ephemeral-port version may require one full App quit. Successful
process creation is not proof of configuration traffic. A bounded post-launch
main-process check verifies retained PAC arguments; adapter readiness is reported
separately from App route readiness. macOS reads exact App main-process metadata
using the system `ps`, never prints complete process arguments, and polls only
for a bounded interval after a new launch, not while ordinary inference runs.
Matching running Apps are reused without relaunch. Unreadable or mismatched
routes get a warning, never a forced exit or an unverified success message.
The stable address prevents port-change failures; it does not replay interrupted
requests, clear App configuration caches or guarantee immediate gray suggestions
after every restart. Network-policy changes and App compatibility checks still
have the separate restart/setup requirements described below.

```bash
# Fully quit Codex App first.
ccdx app codex prediction setup
# Restart the running CCDX process, then launch Codex through ccdx.
ccdx
ccdx app codex prediction status
# Repair only an already-enabled bridge in a compatible running CCDX service:
ccdx app codex prediction repair

# To remove the optional setup, fully quit Codex first:
ccdx app codex prediction remove
```

Enabling explicitly adds a private certificate trust record to the selected App
profile and a process-scoped PAC route for `chatgpt.com` and `ab.chatgpt.com` only.
HTTPS traffic for **all paths on those two hosts** is decrypted and forwarded
locally; PAC cannot select HTTPS paths before TLS. Only the bootstrap prediction
flag, prediction configuration, and corresponding Statsig refresh values are
overlaid. Other paths preserve upstream status, cookies, streaming and WebSocket
traffic. Upstream TLS verification stays enabled; no OS trust, global proxy, login,
account identity or account-permission value is rewritten. Credentials are not
logged or persisted by the bridge. The local private key has owner-only permissions;
its signing key is discarded after certificate creation.

Static proxy settings are composed with the local bridge. For HTTPS targets,
`https_proxy` takes precedence over `HTTPS_PROXY`, then `all_proxy`/`ALL_PROXY`,
then the macOS HTTPS proxy or SOCKS proxy. HTTP targets follow their corresponding
HTTP setting. An HTTP-only environment proxy is not used for HTTPS. HTTP CONNECT,
TLS to an HTTPS proxy, SOCKS5 (including username/password), `NO_PROXY`/`no_proxy`,
system exceptions and simple-host exclusions are supported. Proxy credentials
remain in memory, are never included in PAC responses or diagnostics, and are
sent only to the proxy. TLS verification remains enabled for both proxy and target.
Other App domains keep the resolved original route; if a bridge fails, its PAC
fallback uses that route rather than adding an unrequested direct connection.
Bypass lists support host/domain patterns, optional ports and IPv4/IPv6 CIDRs.
CIDRs match only IP literals in URLs, not the resolved addresses of domain names,
following Chromium's manual bypass semantics. No DNS request is added to proxy
selection, and SOCKS remote name resolution is not replaced by local resolution.
IPv6 CIDRs use unbracketed notation (`2001:db8::/32`); IPv6 host/port rules use
brackets (`[2001:db8::1]:443`). Malformed rules fail explicitly without echoing
their contents. Node and the generated PAC use the same matcher. Legal unused
exceptions do not block a direct environment or change it into a proxied route.

macOS dynamic PAC/WPAD remains unsupported and is not overwritten. Windows
automatic routing is opt-in and requires the native worker; a failed worker
closes its optional bridge while core inference continues. Restart CCDX and Codex
after changing company PAC contents at an unchanged URL; this is not a live
network-policy watcher. Static/system-setting changes can be rechecked by
`prediction fix` as described below. Native composer behavior was verified on one Windows machine. Its
observed upstream route was direct; arbitrary company PAC, integrated-authentication
and client-certificate policies are not claimed as live-tested. A non-default `CODEX_API_BASE_URL` is
also preserved and reported as a custom-route conflict; setting it to the normal
`https://chatgpt.com/backend-api` does not cause a conflict. No automatic direct
fallback after upstream-proxy rejection is added. The default App profile
is `~/Library/Application Support/Codex`; an explicit
`CODEX_ELECTRON_USER_DATA_PATH` is respected. Quit the App before trust changes;
CCDX never kills it. The launcher uses the exact App that passed the compatibility
check. A changed App is rechecked once at bridge startup using the existing
signature/protocol and profile checks. The exact App/profile identity, saved port
and trust must remain unchanged; unsupported updates still require explicit setup.
Unknown client/store/configuration formats are not forcibly rewritten.
These are checked compatibility boundaries, not a promise for every future App.

The bridge changes only its own prediction fields and preserves already-enabled
official prediction configuration. A missing prediction-config route can receive
CCDX's own short JSON-suggestion prompt using low reasoning effort. Authentication,
permission, rate-limit and server errors are returned unchanged. Full and live
refresh schemas are supported; delta requests ask for complete values to avoid
merging upstream checksums with locally changed fields. Configuration bodies are
bounded at 16 MiB; larger or unknown bodies pass through without an overlay.
No extra inference or bridge exists for users who leave the feature disabled.
When enabled, prediction requests consume Copilot usage; the setting does not
provide a separate prediction-model picker.

`app codex prediction remove` immediately disables new local overlays. Quit/reopen Codex to
clear its cached predictions and temporary route. If the App is still running,
trust removal is deferred; quit it and use Remove setup in WebUI again. Only the exact
owned certificate record is removed, never the whole store. A CCDX-owned persistent
proxy preference is restored first, preserving all unrelated preference values.
User-replaced proxy preferences are not restored over. Failed activation
rolls back newly added trust; certificate replacement keeps old trust until the
new preference is committed. If the bridge stops, new connections can fall back
to the original route; already-interrupted requests are not replayed. An App
already using the saved address need not be relaunched just because CCDX restarts.
If its route is missing or differs, fully quit Codex and run `ccdx` to attach it.
`CCDX_AUTO_LAUNCH=0` keeps automatic launch disabled and never hot-attaches a
running App. An already-persisted direct-environment preference can still be read
when the App is manually opened.
Optional prediction failures never prevent the core adapter or image service from
starting. `prediction status` reports the saved preference and, when a compatible
running adapter responds, its bridge state, configuration-response observations
and bounded TLS/upstream errors. The dashboard uses the same snapshot and manual
refresh. Configuration traffic is evidence of a request reaching the bridge, not
proof of a generated/displayed candidate. Candidate visibility remains unknown;
no prompt matching, UI injection, transcript scanning or extra inference is used
to invent that status. Prediction settings are stored separately in
`~/.config/codex-copilot-dx/native-prediction/` (or under `XDG_CONFIG_HOME`).

Since `0.9.34`, an enabled bridge has a lightweight 30-second listener check.
Healthy checks do not spawn processes, call upstream, inspect transcripts or
probe model endpoints. A failed owned listener/native company-routing worker can
be recreated on the saved port, using the same checked profile and certificate.
There are at most three automatic recovery attempts per bridge lifecycle, with 30/60/120-second
backoff gates; checks themselves run every 30 seconds. Occupied ports are not
stolen or rotated. Startup failures do not gain a retry loop, and configuration
HTTP errors or missing gray text alone do not trigger transport restarts. Existing
requests can fail during an outage and are never replayed by this supervisor.
Disabled prediction startup creates no recovery timer. The existing in-memory
overlay switch still observes explicit on/off changes independently.

`ccdx app codex prediction repair` asks the running adapter for one explicit repair, without
starting another core service or forcibly restarting Codex. Disabled predictions
remain off. Healthy/current bridges with unchanged environments are kept; a failed bridge or changed App identity
reuses the saved port, certificate and verified profile. Compatibility, certificate,
company proxy and port-ownership checks are not bypassed. Certificates are not renewed
by fix; setup problems can still require a normal closed-App `prediction on` action.
An explicit successful recreation starts a fresh three-attempt automatic recovery
lifecycle; it is not an automatic retry loop for initialization failures.

Since `0.9.37`, fix rechecks system proxy settings and compares the effective
network snapshot before replacing a listener. A changed valid snapshot recreates
only the optional bridge on its saved port, retaining certificate/profile checks.
A running App may cache its earlier PAC, so `needs_app_relaunch` (exit 1) remains
until inspection observes it closed or with a different readable main PID. No App
is forced closed. A failed recheck reports `environment_preserved` (exit 1) and
keeps the previous bridge; this is not a successful application of the new policy.

Environment variables belong to the running service's process. A new terminal's
variables are not copied into it by fix. Node trust inputs, including
`NODE_EXTRA_CA_CERTS`, are startup settings, not a hot-reload interface. Changed
inputs or changed readable extra-CA content report `needs_service_restart` (exit 1)
without recreating certificates or claiming new trust was loaded. Extra-CA files
are inspected read-only up to 1 MiB; `configured` means readable PEM certificates,
not proof that they were loaded or trusted. Missing/invalid/oversized bundles are
reported diagnostically; no root is imported and TLS verification remains required.

Startup, `status`, `prediction status/fix` and a running-adapter `doctor` use the
same sanitized environment summary: source/type, exception/CIDR counts, trust-file
state and adaptation/restart status. They do not print proxy credentials, internal
rules, CA paths or private comparison hashes. Status/doctor reuse runtime evidence
instead of spawning another proxy probe. Disabled predictions perform no prediction
environment discovery, CA-file inspection or worker/timer startup. Existing App
paths, user settings, npm/PATH/prefix, permissions and terminal policies remain
owned by their existing modules; there is no global auto-configuration framework.

The command checks the adapter's advertised `prediction-fix-v1` capability before
posting bounded JSON to the native-loopback-only `/_ccdx/prediction/fix` endpoint.
Browser Origin headers, remote peers and non-JSON bodies are refused. A repair does
not count as model traffic. An older running adapter needs one upgrade/service restart
to gain this endpoint; the new CLI cannot hot-upgrade an old Node process.

Repair reports bridge readiness separately from the inspected App launch route.
If a running App has no verified route, fix returns a partial result (exit 1), preserves
its process and asks for a normal full quit followed by `ccdx`. A closed App is not
launched by fix; run `ccdx` to open it. Neither HTTP 200 nor a verified route proves
that gray text appeared. Normal replies, image setup and account state are not changed.
Unavailable/ambiguous process inspection reports `route_unverified` (exit 1), not
a definite missing route or an instruction to restart an otherwise healthy App.

App compatibility inspection checks up to 16 named main candidates and 16 named
general-settings candidates, rather than assuming the first hashed chunk owns the
implementation. A forwarding chunk therefore cannot hide a later real settings
module. Reads retain a 32 MiB header limit, 32/4 MiB per-entry main/settings limits,
a combined 36 MiB source limit, archive bounds/snapshot checks and platform signature
verification. Unknown layouts remain unsupported instead of being patched blindly.

Before enabled App launch, CCDX can persist its PAC in that verified profile's
`Default/Preferences`, but only in a direct environment, with initialized regular
profile files and the App closed. Existing explicit App proxies and all company
static/PAC/WPAD routes are preserved. Ownership intent is stored in `route.json`
before changing the one proxy field; unrelated settings are retained, concurrent
edits fail closed, and matching setup is not rewritten. If an App is already
running, first-time migration is deferred until a normal closed-App launch;
CCDX does not claim it can hot-attach a missing route. A manually reopened App
with a saved preference is reported as awaiting configuration traffic, not as
launch-route verified. This preference is a prevention measure, not a guarantee
for every future Chromium profile format or OS version. Company proxy users keep
the verified launch-argument path. Core inference/image routes are unchanged.

`prediction status` and `ccdx status` also expose launch-route evidence, persistent
route state, recovery attempts and recoveries. These are independent of the
unknown candidate-visibility value. A successful recovery only means the bridge
was recreated on the original address, not that gray text appeared.


## Error delivery and conversation commits

Image and custom API HTTP errors keep their stable `ccdx_images_http_<status>` or `ccdx_api_http_<status>` code, status and validated Retry-After. A failure-only reader can retain a small allowlist of structured source codes in `upstream_code`; source messages and bodies are not forwarded. Reads are limited to 64 KiB and a 200 ms timer, with at most four concurrent readers. Unknown or unfinished bodies fall back to the existing generic error. Admission is normally released before this read; a recognized compatibility rejection may hold it through one retry. Image-generation slots are still released before the read.

An explicit source validation error for a standalone tool output without a call ID can trigger one compatibility retry. An explicit rejection of a supported root-union tool schema can trigger one Messages retry; tool inputs are checked against the original schema before delivery. Schemas that cannot be checked safely remain unchanged. Other failures, including a silent connection, are not retried by these adaptations.

For custom APIs using the Node HTTPS agent, idle pooled connections are retired after 60 seconds at most, or earlier when the server declares a shorter keep-alive period. Active streams and their existing timeouts are unchanged. Windows WinHTTP continues to use its own connection handling. A connection can still fail within the idle period; reconnecting an expired connection can add setup time.

Conversation-source admission and Messages checkpoint commits wait asynchronously for the existing cross-process locks. Cancellation ends lock waits. Checkpoint writes retain the primary/marker ordering and rollback behavior; the gateway awaits a successful commit before forwarding corresponding usable JSON or SSE output. Cached source checks keep their synchronous fast path. CLI configuration writers retain their existing synchronous behavior.

## Native image generation

The native image host uses the current CCDX address for separate Images API requests. CCDX serves `POST /v1/images/generations` and `POST /v1/images/edits`, reuses the existing GitHub Copilot authentication, and maps the native client’s `gpt-image-2` request to the selected available GHC image model. GPT Image 2.5 Flare is the default when advertised. The `X-CCDX-Image-Model` response header identifies the actual model. Image usage counts toward the GitHub account’s image credits; organization model policies still apply. The image model does not replace the selected conversation model.

On macOS with Codex 0.166 or later, CCDX launches the unchanged Codex CLI through a local stdio host adapter. The adapter registers `ccdx_images.imagegen` using Codex’s native `dynamicTools` interface. Codex emits native tool progress and includes image content in the chat history; display in the signed App depends on the client and requires a real-window check. CCDX saves image files under the active Codex home’s `generated_images/ccdx/` directory and uses these files for later edits, including after a host restart. No separate image address or key, image MCP registration, or CCDX image skill is required. Windows continues to expose the Images API; automatic host activation on Windows is not yet provided.

The Web UI image panel and terminal `check`, `repair`, and `open` controls use the service's image setup and launch controls. `check` verifies the Node loopback response with a fresh nonce and checks the launcher and runtime evidence; it does not prove the Codex App's proxy route. `repair` prepares owned launch files and client configuration without opening or closing the App. The terminal `open` command opens Codex only when it is closed. Disabled image settings and custom launch routes are preserved.

On macOS, the image and input-suggestion panels use the same App state and launch control. If Codex is closed, the button opens it; if the enabled integrations are ready, it switches to Codex; if they need a restart or their route is unconfirmed, it offers **Restart Codex to connect** with a warning that running tasks can be interrupted. The restart happens only when that button is clicked. CCDX prepares enabled routes first, requests a normal App exit, waits for it to close, applies a pending suggestion display change, and opens it through the existing launcher. It does not force-quit the App or restart CCDX. If the App refuses to close, its identity changes, or preparation fails, the action stops and reports the reason. If a post-close display change fails, CCDX retains it as pending and reports it when reopening. A successful launch request does not prove that the current chat has the image tool; an older chat without the tool still needs a new chat.

The stdio host pauses each input source when its destination is blocked or an asynchronous frame operation is pending. Ordinary frames retain their synchronous path and original wire text; output batching follows the destination high-water mark. Shutdown waits for child close and queued stdout delivery, including a final frame without a newline. No arbitrary new protocol-frame byte limit is imposed.

The runtime separately reports host initialization, accepted new-chat registration and image-call outcomes. Reports contain only host PID, anonymous host/chat identifiers, event type and time, remain in bounded process memory, and are not an automatic image-generation probe. Registration evidence applies to observed chats, not every existing conversation. Dead host processes are unconfirmed. The TUI exposes the repair command; terminal image status includes the same host state. Request details show anonymous session correlation and the previous retained request's outcome when supplied session metadata allows it; missing identity stays unassigned.

The adapter uses `CODEX_CLI_PATH` only for the App launch requested by CCDX. It does not modify App binaries, ChatGPT authentication files, credential storage mode or account-plan declarations. All other app-server traffic, including Apps and approval requests, passes through to the original CLI. Existing custom CLI routes and unowned launcher files are preserved. A running App retains its existing launch environment. Use the image panel's explicit restart when that App has not loaded the host, then use a new chat if the existing chat lacks the tool. CCDX does not forcibly restart the App. Native built-in image tool availability still depends on the installed client and thread. A successful direct API request alone does not establish visible App behavior.

The WebUI’s image switch is on by default and pauses or resumes new requests. A previously saved off choice is preserved. Available GHC image models appear below the switch; multiple models use one radio selection. The same image purpose appears in Model sources and Codex model configuration. Image models stay out of Codex’s conversation-model picker and conversation default selection. Saved pause choices survive upgrades, and active calls may finish. The CLI uses the same preference:

```bash
ccdx app codex image status
ccdx app codex image check
ccdx app codex image repair
ccdx app codex image open
ccdx app codex image models
ccdx app codex image select --id gpt-image-2.5-flare
ccdx app codex image enable
ccdx app codex image disable
```

`enable` and `disable` change only the image preference; the GitHub account and selected model are retained. `models` reads the running service's available image catalog; `select --id` saves one advertised GHC image model. `status` can fall back to local configuration when the service is stopped, without a model request. The old `setup`, `remove`, `pause` and `resume` image commands are retired. GitHub must remain enabled and allowed for Codex, regardless of which source supplies the conversation model.

The selected image model is stored as `clients.codex.image_model` in CCDX's connections configuration. Codex model configuration and sync previews include this image selection, while native client configuration retains a conversation model as its `model`. Native Images requests use the saved image selection through the existing gateway address. No unsupported image-model setting is written into Codex TOML. A saved image model that disappears from the available catalog fails explicitly rather than switching models.

Requests accept one generated image, `auto` or the three existing sizes (`1024x1024`, `1536x1024`, `1024x1536`), `auto`/`low`/`medium`/`high` quality, and `auto`/`opaque`/`transparent` backgrounds. Edits accept one to five inline PNG, JPEG or WebP images, each at most 10 MiB. Remote URLs, ChatGPT file IDs, masks, GIF output and unrecognized fields fail explicitly. Output is bounded at 32 MiB per image. Upstream capabilities remain authoritative; unsupported options fail without silently changing the requested operation or model.

Both routes require native local clients and JSON, reject browser Origin headers, share request-body admission, enforce at most two active image operations, and propagate cancellation. Prompt text uses the existing local masking policy; pixels are outside text masking’s scope. CCDX uses a 180-second deadline and never retries image inference or follows redirects. Usage and operation counts use the existing status/usage paths without logging prompts or pixels.

The old external image provider, Qwen-specific generation/editing, `/mcp/image`, adapter-held edit IDs, image setup form and skill/helper installer are retired. `/mcp/image` returns HTTP 410, including cached calls from old tasks. Startup deletes the old `image-provider.json` credential without reading it and removes recognizable CCDX-owned MCP configuration and unmodified guidance. Customized declarations and modified guidance are preserved with a warning; review them manually. Existing image files remain user artifacts and are never deleted by retirement. Core startup remains available if optional legacy cleanup cannot complete.

## Security

- CCDX binds to loopback by default. Non-loopback hosts are rejected unless `CCDX_ALLOW_LAN=1` is set explicitly.
- Enabling LAN binding exposes a Copilot-backed API to other reachable machines. Provide your own host firewall and network isolation; do not expose the listener to an untrusted network.
- Inference POSTs reject any browser `Origin` header before reading the body or contacting upstream, including simple `text/plain` requests. Native Codex/Node requests without Origin and deliberately enabled native LAN clients keep their existing access. This is not authentication or protection against untrusted local native programs.
- Explicit auth tools store GitHub OAuth credentials at `~/.local/share/ccdx/github_token`, with precedence over the compatible legacy `~/.local/share/copilot-api/github_token` store. Short-lived Copilot service tokens remain in process memory and are refreshed as needed. First-time local discovery hands its verified service token to the startup client when the saved credential and account match and more than a minute of validity remains, avoiding a duplicate exchange. Existing cached tokens, refreshes in flight and account bindings are retained. See Account and repair tools for safe replacement/sign-out behavior.
- Native image requests use the existing GitHub credential. The retired independent image credential is removed during legacy cleanup.
- Runtime status and usage records retain metadata by default; explicitly enabled HTTP error excerpts can contain private context. Diagnostic logging records status and error messages; it is not a general redaction layer for arbitrary error text. See Debug logging before sharing logs.
- Request/response bodies, request-admission queues, retained history, image work, SSE buffers, log queues, retries, and shutdown have explicit limits. These component limits are not a single process-wide memory ceiling; completed image files are persistent user artifacts, not an automatically evicted cache.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `ADAPTER_HOST` | `127.0.0.1` | Adapter host; only loopback hosts are allowed by default |
| `ADAPTER_PORT` | `2026` | Adapter port |
| `CCDX_ALLOW_LAN` | unset | Set to `1` to permit a non-loopback host such as `0.0.0.0`; this exposes the Copilot-backed adapter beyond this machine |
| `CCDX_MAX_BODY_BYTES` | `67108864` | Maximum compressed or raw request-body size |
| `CCDX_MAX_DECODED_BODY_BYTES` | `134217728` | Maximum decoded request-body size after decompression |
| `CCDX_MAX_INFLIGHT_BODY_BYTES` | `33554432` | Per-pool byte budget for raw bodies, decoded bodies, and materialized response history; a larger item runs exclusively in its pool |
| `CCDX_MAX_UPSTREAM_CHAT_RESPONSE_BYTES` | `67108864` | Maximum buffered successful Chat Completions response used by the internal Responses compatibility path |
| `CCDX_MAX_UPSTREAM_RESPONSES_RESPONSE_BYTES` | `268435456` | Maximum buffered successful native Responses or compact response; streaming Responses use bounded backpressure |
| `CCDX_MAX_QUEUED_REQUESTS` | `16` | Maximum body requests waiting for shared byte admission |
| `CCDX_REQUEST_QUEUE_TIMEOUT_MS` | `120000` | Maximum wait for request-body admission before returning `503` |
| `CCDX_REQUEST_BODY_TIMEOUT_MS` | `120000` | Maximum time to receive and decode a request body before returning `408` |
| `CCDX_MAX_UPSTREAM_BODY_BYTES` | `31457280` | Strict maximum forwarded Responses body size; larger payloads are adapted locally or rejected with `413` |
| `CCDX_MAX_SSE_BUFFER_BYTES` | `8388608` | Maximum buffered bytes for one unterminated upstream SSE line or event |
| `CCDX_UPSTREAM_TIMEOUT_MS` | `120000` | Per-phase timeout for Responses/Messages preparation and non-streaming upstream requests |
| `CCDX_STREAM_HANDSHAKE_TIMEOUT_MS` | `120000` | Timeout while waiting for upstream streaming response headers |
| `CCDX_STREAM_IDLE_TIMEOUT_MS` | `120000` | Maximum idle time between upstream streaming body chunks |
| `CCDX_UPSTREAM_RETRIES` | `2` | Retries for safe requests and clearly pre-connect POST failures; capped at `5` |
| `CCDX_UPSTREAM_RETRY_DELAY_MS` | `300` | Initial upstream retry backoff in milliseconds; capped at `5000` |
| `CCDX_AUTO_REVIEW_MODEL` | saved selection or `gpt-6.1-sol` | Copilot Responses model used for Codex Auto-review; overrides the interactive selection |
| `CCDX_LOG_PATH` | unset | Record diagnostic logs independently of quiet terminal presentation; set to `1` for `~/.local/share/codex-copilot-dx/debug.log` |
| `CCDX_LOG_LEVEL` | `info` | Set to `debug` for upstream attempts, status codes, retry causes, and timings |
| `CCDX_HTTP_ERROR_DETAILS` | unset | Set to `1` on a new service to retain redacted HTTP error excerpts (500 characters) in bounded memory; review before sharing, no file logging is enabled |
| `CCDX_LOG_MAX_BYTES` | `16777216` | Rotate the debug log at this size and retain one `.1` backup; set to `0` to disable rotation |
| `CCDX_TERMINAL_ANIMATION` | auto | Allow the selected animation in the fixed interactive status region during business activity; set to `0`, `false`, `no`, or `off` to disable |
| `CCDX_IMG_MAX_DIM` | `2048` | Maximum long edge in pixels for image downscaling |
| `CCDX_IMG_QUALITY` | `82` | Initial WebP quality for image re-encoding |
| `CCDX_IMG_MIN_BYTES` | `100000` | In-bounds images smaller than this skip re-encoding; oversized dimensions still trigger an optimization attempt |
| `CCDX_IMG_CONCURRENCY` | `2` | Global concurrent image-optimization tasks; values above `12` are capped |
| `CCDX_IMG_MAX_INPUT_PIXELS` | `40000000` | Sharp's per-image decode limit; an optimization failure retains the original image, subject to the overall forwarded-body limit |
| `CCDX_IMG_CACHE_MAX_BYTES` | `67108864` | Process-local byte ceiling for cached image transforms; set to `0` to disable the cache |
| `CCDX_DISABLE_IMG_OPT` | unset | Set to `1` to disable image optimization |
| `CCDX_AUTO_LAUNCH` | enabled | Set to `0`, `false`, `no`, or `off` to start without opening Codex App |
| `CCDX_GITHUB_TOKEN` | unset | Explicit GitHub Copilot OAuth token to validate and import before Device Flow |
| `CCDX_GITHUB_TOKEN_PATH` | unset | Explicit file containing a GitHub Copilot OAuth token |
| `CCDX_GITHUB_TOKEN_PATHS` | unset | Multiple token files separated by the platform path delimiter (`:` on macOS, `;` on Windows) |
| `CCDX_GITHUB_LOGIN` | saved account | Require automatic discovery and recovery to use this GitHub login |
| `CCDX_DISABLE_TOKEN_DISCOVERY` | unset | Set to `1` to skip local token discovery and use the saved token or Device Flow |
| `CCDX_TOKEN_LOCK_TIMEOUT_MS` | `600000` | Maximum time to wait for another process to finish GitHub token login or import |
| `CCDX_TOKEN_LOCK_STALE_MS` | `900000` | Minimum age for stale-lock recovery; a lock with a live owner is not removed |
| `CCDX_EXISTING_ADAPTER_TIMEOUT_MS` | `500` | Timeout for detecting an already-running local adapter during startup |
| `CCDX_MODEL_REFRESH_TIMEOUT_MS` | `5000` | Timeout for Copilot model refresh or live Auto-review model lookup |
| `CCDX_MODEL_REFRESH_INTERVAL_MS` | `7200000` | Periodic model refresh interval; `0` disables periodic refresh, while startup cache/refresh behavior still applies |
| `CCDX_RESPONSE_HISTORY_MAX_BYTES` | `67108864` | Higher-precedence total in-memory byte budget for locally expanded Responses history; `ccdx doctor cache --limit` provides a persistent 16–1024 MiB setting when this is unset |
| `CCDX_RESPONSE_HISTORY_MAX_ENTRIES` | `4096` | Maximum stored incremental Responses history nodes |
| `CCDX_USAGE_PATH` | `~/.local/share/codex-copilot-dx/usage.jsonl` | Local JSONL token-usage log |
| `CCDX_USAGE_MAX_BYTES` | `33554432` | Rotate the usage log at this size and retain one `.1` backup; set to `0` to disable rotation |
| `CCDX_DISABLE_USAGE` | unset | Set to `1` to disable usage logging |
| `CCDX_SHUTDOWN_TIMEOUT_MS` | `5000` | Time to drain active HTTP connections before forcing shutdown |

## Usage logging

When upstream responses contain usage fields, CCDX records token counts, model names, API surface, and response IDs in `~/.local/share/codex-copilot-dx/usage.jsonl`. It does not record prompts, completions, tool arguments, or image content.

```bash
ccdx usage
```

The summary covers the current log and its single rotated backup, not an unbounded lifetime history. It reports recorded responses and per-model input, cache-read, cache-write, output, and total token metadata.

M365 preserves system instructions at their original mid-conversation position. This avoids moving each new reminder ahead of the already cached history. Other Claude App API endpoints keep legacy behavior unless the model's `mid_conversation_system` capability is explicitly true. A false override selects legacy hoisting; Responses and Chat use their existing paths. This preserves instruction priority rather than converting system messages to user text.

Messages input is the sum of Anthropic uncached input, cache-read and cache-creation tokens. Cache creation is new input, not a cache hit; output tokens, including thinking output, are not added to the cache-hit denominator. M365 follows this same protocol accounting. Cache writes are shown separately when reported; missing write counts remain unknown. Stream usage updates replace cumulative counters, preserve earlier values when a later field is null or absent, and retain explicit zero. Each gateway request writes at most one usage row; forwarded usage is unchanged.

CLI/TUI, WebUI totals and daily analytics use the same paired evidence for cache rates. Aggregate JSON exposes `cache_hit_known_requests`, `cache_hit_unknown_requests`, `cache_hit_input_tokens` and `cache_hit_read_tokens` so the rate and its coverage can be checked. `~` marks incomplete coverage; a rate without a positive known input basis remains unknown. Historical logs are re-aggregated without rewriting their records, and unknown cache values are never filled with zero.

Usage writes are asynchronous and batched under the existing cross-process rotation lock. Pending and in-flight records share a 4096-record / 4 MiB ceiling. If either ceiling is reached, new excess records are dropped with a warning and a status counter; inference does not wait or retry. Normal records and per-record rotation boundaries are unchanged. The bounded shutdown flush remains 1.5 seconds; disk failures and shutdown deadlines can prevent persistence, so usage is diagnostic rather than a billing ledger.

Repeated plain usage summaries reuse one bounded entry when retained files are unchanged, with the existing two-second recent-write guard and 256 KiB/128-group limit. Dashboard analytics keeps up to two independent aggregate checkpoints within 2 MiB. Its first read scans both retained logs. Later reads apply only append batches witnessed by this process under the existing write lock, with a 256 KiB pending-delta limit per checkpoint. Another process's writes, rotation, truncation, replacement, incomplete tails, warnings, future/undated records and oversized results fall back to a complete read. Queries remain scoped by source, time zone and local date; returned results are cloned and identical concurrent reads share work. The asynchronous writer supplies file-version evidence only while analytics checkpoints exist. There is no persistent index, background poll or added model request.

Diagnostic redaction removes Basic authorization payloads and URL userinfo, and consumes escaped quotes inside sensitive JSON fields. Ordinary Basic-related prose, safe host/path information and error codes are retained. These protections apply to existing failure/status/debug diagnostics, not forwarded requests or upstream response bodies. They do not make arbitrary upstream prose guaranteed safe to share.

## Debug logging

Set `CCDX_LOG_PATH=1` to record diagnostic logs independently of quiet terminal presentation to `~/.local/share/codex-copilot-dx/debug.log`, or provide a custom path. Add `CCDX_LOG_LEVEL=debug` for upstream attempts, retry causes, status codes, and timings. The adapter does not deliberately dump request/response bodies or authorization headers. File diagnostics redact common credential forms and labelled content echoes, but this cannot identify every secret in arbitrary external prose; review logs before sharing them. File writes are asynchronous and batched with a 4096-record / 2 MiB pending-and-in-flight ceiling. Overflow drops excess file records with one warning and a status counter; terminal output continues. CLI exit paths flush for at most 1.5 seconds. `ccdx doctor config` bypasses file logging entirely.


## Large histories and images

Long computer-use sessions can accumulate screenshots that are sent again on later turns. This can increase local preparation time, upstream handshake latency, and the chance of a `413 Payload Too Large` response.

The response-history cache is process-local and byte/entry bounded. Ordinary adapter restarts discard it; verified opt-in nightly handoff is the exception described below. Without such a handoff, a `previous_response_id` stored only in that process becomes unavailable. CCDX does not persist conversation history to disk. Near-limit status diagnostics report the largest tree and actual lookup misses, but do not recover an already evicted ID or change the cache budget. Clients can still submit explicit history in the request body, subject to the same limits.

CCDX attempts to downsample inline base64 images to model-appropriate pixel bounds, with a 2048 px long-edge fallback, and initially encodes them as WebP quality 82. It never replaces an image with a larger encoding and uses one global concurrency limit across direct images and function/custom-tool outputs. GIFs and non-inline references are not re-encoded. An encoding/decode failure keeps the original image; the final request-byte limit still applies.

The final serialized UTF-8 body is measured before forwarding. Above the configured limit, unique source images are processed largest-first from their originals at quality 75 / 1600 px and then quality 65 / 1280 px, stopping when the body fits. If necessary, the forwarded view omits older duplicate images, historical tool images, other historical images, and finally old tool outputs while preserving current input and tool-call skeletons. Requests that still do not fit receive a structured local `413`.

Completed image transforms are reused from a byte-bounded process-local LRU cache, and concurrent requests for the same transform share one encode. Failures are not cached and request cancellation remains isolated.

The visual-history pressure pass does not omit images while there are at most 24 historical images and the expanded body is at most 18 MiB; normal image encoding and other limits still apply. Above either threshold, this pass preserves current-turn images and keeps up to 16 recent historical images, targeting 16 MiB. The separate 50-image and total-body limits remain in force. After an eligible large-visual-history preparation, handshake, upstream timeout, or HTTP `408`, the next retry uses an 8-image, 10 MiB recovery window for ten minutes. Two successful requests or a successful compaction clear recovery mode. CCDX never transparently repeats an ambiguous timed-out POST, and it does not delete local history.

When expanded history exceeds Copilot's 50-image request limit, CCDX removes older duplicate occurrences first and then keeps the 50 most recent images. This affects only the forwarded request; local history remains complete and current images are preferred.

For `/v1/responses/compact`, CCDX sends one terminal `compaction_trigger`, validates completed compaction state, and preserves the complete returned window as the canonical next context. Only a validated window becomes a new local history root. Existing older branches remain available until normal history eviction.

Changing the model or transport of a continuation can require removing incompatible encrypted history from the forwarded request. A specific upstream encrypted-state verification failure can also trigger one sanitized retry, including when a nominally successful HTTP response ends with `response.failed`. CCDX withholds only the pre-output prelude of an encrypted continuation while evaluating that terminal event; it never retries after visible model output, so it cannot duplicate an already-started answer. Unrelated failures are not retried. CCDX does not decrypt that state locally.

Native Responses forwards Codex `agent_message` items unchanged. When a model requires Chat Completions, CCDX frames them as messages from another agent, not human input or approval, retaining author/recipient, typed text/refusal/reasoning and representable image/screenshot content. Content unsupported by Chat, including file, audio or opaque encrypted parts, receives an explicit compatibility error instead of being serialized into ordinary text. This projection does not introduce another model request or change native Responses, Fast, Auto-review or compaction routing.

GitHub Copilot's `gemini-4-carbon` uses Chat Completions. CCDX maps Codex custom,
namespaced and client-side tool-search calls to function tools and restores their
original identities in the reply and conversation history. The upstream receives
ordinary function tools; free-form grammar constraints are included in the tool
description rather than enforced by the Chat protocol. Other models retain their
existing routing and compatibility checks.

Carbon's standalone web search uses the current GitHub Copilot account. Only
search queries and requested constraints are sent to its search endpoint; the
conversation input and ChatGPT credentials are not forwarded. With live web
access, opening a page uses the installed macOS Copilot runtime and contacts the
page from the local machine. Cached mode returns indexed excerpts. Page reads
are limited to the first 20,000 characters, and image/literature search, PDF
screenshots, finance, weather and sports are not supported. Search references
are process-local and may expire; date restrictions are not guaranteed. A
configured domain policy that cannot be enforced is rejected. Local privacy
masking applies to the search commands when enabled.

After the stream handshake succeeds, stream liveness uses the idle timeout rather than the expired handshake deadline. Eligible HTTP-200 failure recovery acquires a bounded preparation budget and history admission before rebuilding its payload, then releases those reservations when the retry opens upstream or fails. Normal streams still release preparation admission after their response headers arrive.

Messages and token counting stop the body-upload timer after JSON is read, then
use `CCDX_UPSTREAM_TIMEOUT_MS` for preparation. A preparation timeout returns
`504 messages_prepare_timeout`; a slow body upload remains governed by its own
body timeout. Upstream dispatch starts the existing handshake/non-streaming
budget, and counting keeps its shared dispatch deadline across capability waits.
Cancelling a manual API credential waiter returns promptly without cancelling
other callers or forwarding after a late credential result. The shared OS secret
read may finish under its existing ten-second bound. No new timeout setting or
inference retry is added.

Downstream backpressure waits also observe cancellation and the stream deadline. A client that stops reading cannot retain the pending stream indefinitely after timeout; CCDX closes that connection without retrying its request. Final error-frame delivery has a separate one-second maximum drain wait.

Successful streaming responses are accepted only when the upstream body is SSE and reaches its protocol terminal event. Unexpected EOF becomes a protocol-native stream error, and repeated blank tool-argument deltas are stopped per tool call. Allowlisted rate-limit, retry, model, trace, and upstream request-ID metadata are forwarded; cookies, authorization, body-length, and encoding headers are not.

Responses stream errors, including untyped upstream error frames and interrupted streams, end in a `response.failed` event carrying the failure message. Missing response IDs and creation times are supplied locally. After a successful Claude `message_stop`, the client response ends immediately; CCDX reads toward upstream EOF to allow connection reuse. The reader is canceled after one second or when received tail bytes exceed 64 KiB; the last chunk can exceed that threshold. Errors and cancellation also close the reader.

Responses, Chat fallback, Messages and local response restoration accept LF, CRLF and CR SSE line endings. Existing comment heartbeats, upstream timeouts, retry eligibility, output and usage remain unchanged.

CCDX keeps each native Responses message on its first upstream ID when Copilot changes that ID during streaming. Message deltas, completion events, and cached history stay consistent, addressing this cause of duplicate live messages in Codex App. Tool identities, reasoning/encrypted content, message phases, and speed-tier routing are unchanged by this ID normalization. Stable events retain their original SSE bytes; changed events are rewritten with bounded, backpressured streaming.

Newer Codex App builds can advertise an `image_gen` namespace that already exists upstream. CCDX removes that exact conflicting client tool before forwarding and retries once only when Copilot explicitly reports an image namespace collision. Image input and screenshot optimization remain enabled.

## Development

Run `npm run verify` for unit tests, streaming smoke, resource budgets and package checks. Native Windows and macOS CI verifies installers, credential/configuration ownership, client protocols and the browser UI. Keep inference tests synthetic unless an online probe is explicitly requested. Release evidence stays in dated release notes; architecture proposals are separate from implemented guarantees.

## License

MIT

## Common environment controls

| Variable | Use |
| --- | --- |
| `ADAPTER_HOST` | Listener host; default loopback |
| `ADAPTER_PORT` | Main listener port; default 2026 |
| `CCDX_AUTO_LAUNCH` | Set to 0 to skip opening Codex |
| `CCDX_M365` | Set to 0 to disable the company source for this run |
| `CCDX_USAGE_PATH` | Recorded usage file path |
| `CCDX_LOG_LEVEL` | Optional diagnostic logging level |
| `CCDX_LOG_PATH` | Optional diagnostic log path |

Internal supervisor and installer environment fields are not user settings.

## Diagnostic and usage read bounds

Diagnostic presentation omits input longer than 16,384 UTF-16 code units before normalization or credential scanning. Ordinary identifiers/messages retain budgets of 200/500 UTF-16 code units (400 for operation details), clipped only at complete surrogate boundaries. Oversized diagnostics retain structured status, error and request identifiers; original HTTP/SSE payloads are not changed. The general-purpose credential recognizer keeps its original semantics.

Usage queries share a bounded aggregate checkpoint only when file identities, filters, time zone and calendar date match. Only appends witnessed inside CCDX's writer lock can advance it incrementally. Other-process writes, rewrites, replacement, rotation and unsafe tails trigger a full read. Custom warning callbacks bypass sharing. Cancelling one waiter does not stop another waiter.

## Local masking

Settings → Local masking is off by default. Enabling it downloads the optional local component and AstrLink Guard 0.1.3, verifies their checksums and loads the model before activating protection. The npm package and ordinary installation do not contain model weights or require Go, Python or CUDA. The model and tokenizer total 38,958,270 bytes; the executable and optional macOS acceleration cache require additional space. Component upgrades stage in a separate version directory. A verified compatible older component keeps serving during a failed download; the staged component takes over at an idle detection boundary. Model weights with matching checksums are reused.

Covered text includes conversation instructions, message text, tool results, tool argument values and tool descriptions on Responses, Chat and Messages routes. Protocol identifiers, tool schemas, authentication headers, images, signed thinking and encrypted reasoning retain their current behavior. Masking cannot retroactively remove data already sent to a service or control an agent's file/tool permissions. Personal-information detection is a separate opt-in; detection can miss values or mistake ordinary text.

Rules and a local model replace detected values with stable placeholders. Replies and tool arguments restore their values before delivery. The placeholder seed is private local configuration; original-value mappings live only with the request and are never added to CCDX logs or backups. A restart retains the seed, not the mappings. Local history keeps client-visible text rather than placeholders.

Tool data is interpreted in its own context: ordinary argument fields named `id`, `signature`, `data` or `type` are restored, while protocol identifiers and signed blocks remain unchanged. JSON-encoded Responses and Chat tool arguments retain their numeric values, including integers beyond JavaScript's safe range, when masked or restored. Streaming restoration retains SSE event metadata and restores Responses custom-tool text across fragments. Incomplete parameters are discarded when the upstream emits a failure rather than replacing that failure with a restoration error.

Each request pins its masking choice, including compatibility retries. Checks normally wait up to 15 seconds; a plan with at least one 16 KiB batch of uncached or in-flight text, or more than one pending native window, receives a bounded 60-second wait. A request still exceeding its wait is rejected before any upstream call. Submitted native batches finish and remain reusable; callers share in-flight work, and unused queued work stops. The 1.3.13 component reuses exact natural token-window predictions. Independent short CPU sequences run in bounded groups, with at most 512 total tokens including sequence markers and 16 KiB text. Each sequence keeps its tokenization, positions, attention and quantization scale; fields are not joined into a shared context. A single uncached sequence and accelerator-eligible windows retain their previous execution path. CPU batch-group and computed-window counts are exposed in the existing status metadata. Sparse non-O labels and exact scores use a separate 4 MiB/5,000-entry memory cache; original tokenization, window overlaps and current-text byte offsets are unchanged. Up to two text batches run concurrently, toward 16 KiB or 64 entries, keeping a larger individual text whole. Exact completed texts retain hot aliases. When the last waiter leaves, supporting components finish current windows, cache them and acknowledge cancellation before releasing the native slot. A waiter joining during cancellation resumes after acknowledgement; older compatible components finish whole batches as before. No request uses an incomplete model check. A native job retains its five-minute deadline and the native eight-job/16 MiB limits; the detection queue adds a 16 MiB/8,192-entry bound. Cache metadata remains within 5,000 entries/4 MiB, without storing detection history on disk. Cold-check cost and recovery are measured separately from hot reuse. Fully cached checks do not create native-work wait timers or cancellation listeners; they still honor caller cancellation before returning. CPU intermediate matrices are reused only within one inference. CoreML reuses one C-owned input array/provider per model under its existing mutex and clears its buffers after every successful or failed prediction. Go input memory is not retained by CoreML; classification mathematics and thread budgets are unchanged.

Streaming restoration emits argument fragments incrementally with JSON string escaping, keeps protocol identities and signed state opaque, and validates completion against argument snapshots or incremental JSON syntax. Only unfinished placeholder tails and structural metadata are retained; raw argument bytes per channel remain capped at 8 MiB, retained tails/metadata/validator state at 32 MiB and active channels at 1,024. Added tail deltas preserve increasing Responses sequence numbers. An incomplete or failed upstream response does not manufacture a completed tool call. Successful frame bytes remain unchanged when restoration is unnecessary. A timeout or busy check reports that nothing was sent, with `Retry-After` for temporary waits. Model readiness, the latest check and the latest protected reply are separate. WebUI and `ccdx config privacy status` report pending detection and reply-restoration errors; the CLI retains explicit enabled/disabled values, while graphical switches omit duplicate normal-state labels; request details retain bounded error/event/channel codes and buffer quantities, never their values. A loaded model or HTTP 200 does not establish that a request or client tool completed.

Turning masking off affects subsequent requests. Existing protected replies keep their restoration mappings until they finish. The downloaded component can then be deleted separately. Settings reset backs up and resets masking choices while keeping accounts, model selections, client connections, images and prediction access. Older settings backups inherit masking off.

WebUI controls and `ccdx config privacy` use the same preparation transaction. While the service runs, `config set privacy_enabled true/false` and the personal-information preference use these same controls. Offline preference writes and backup restoration retain saved intent; they do not prove model readiness or download a missing model. Unavailable configured protection holds requests back. Use Enable/Retry or `config privacy enable` to prepare it.

Try locally sends sample text only to the local component. Request records show the number of replacements and elapsed local-check time, never the original values. Initial setup failures keep protection off; failed component upgrades retain verified compatible protection. Configured but unavailable protection refuses covered requests. Downloads retain the selected npm's proxy, certificate and offline policy, with no automatic policy relaxation or alternate downloader.

Privacy failures have a separate local diagnostic origin. Response-restoration failures report that the response was stopped; request-check failures report that nothing was sent. When the latest Messages input explicitly contains failed tool results, request details show their count without retaining their content. HTTP success describes the model response, not proof that a client executed its tools successfully.

The optional component is pinned to v1.3.13. Verified older components, including 1.3.10, retain their original whole-text behavior. ABI 1 is unchanged; window reuse, advisory window plans and acknowledged cancellation are advertised capabilities. Plans contain only text indices and window counts, never request text. Startup retains its previous inexpensive preflight; accelerator initialization remains lazy. Native CI checks both cold detection and startup-plus-cold cost. Verified 1.3.6 and 1.3.9 installations remain compatible. New component receipts bind their protocol ABI and model revision before older versioned components can be reused. On Intel Macs where CoreML selects CPU, windows below 128 tokens use the existing native int8 reader; longer windows, GPU, Neural Engine and ARM selection retain their prior policy. Its source and license notices are in `native/privacy-guard` and `src/privacy-notices.txt`. AstrLink Guard model files use their publisher's Apache-2.0 license.

Paired timing comparisons report cold, startup-plus-first-check, append and hot-check observations without blocking publication. Classifier correctness, byte verification and reuse assertions remain blocking. Real-use request records expose local-check duration and errors for observation after upgrading; fixed-machine results do not establish sustained real-use performance.

Usage tables and analytics model selectors display the current saved name for a configured custom API source. Filtering and aggregation retain the stable provider/model keys. Renaming a source updates its label without merging records; a deleted or unknown source keeps its ID. Existing historical records are not rewritten.
