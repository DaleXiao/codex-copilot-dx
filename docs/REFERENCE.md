# CCDX reference

For installation and first use, start with the [README](../README.md). This reference covers operations and the limits that affect them. Supported systems are macOS and Windows, x64 and ARM64.

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
| `ccdx app codex image …` | Image setup and diagnostics |
| `ccdx app codex review status` / `select` | Read or choose the review model |
| `ccdx config show [--effective]` | Read saved preferences and effective state |
| `ccdx config set <key> <value>` | Save a validated preference |
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
- **Cache cleanup:** adding `--history` can break the next continuation. It does not delete client transcripts or generated images.

Request inspection covers bounded retained records, not a full conversation archive. Unidentified clients stay unidentified. Routine diagnostics omit secrets, prompts and error bodies. Explicit error excerpts use bounded, redacted collection. The usage JSON `requests` field counts recorded usage rows, not HTTP calls. Usage is returned token metadata; cache hit is reused input divided by input, with unknown/partial data indicated. It is not a request-based cache rate or a billing receipt.

## Settings and appearance

Settings separates saved preferences from effective state. Auto-save applies changes by default; required restarts remain explicit. Restore-defaults creates a backup first and keeps accounts, keys, model plans and chats. CLI preference reset/restore uses its own service-only backup; it does not change browser appearance or replace the Web UI's backup.

Web and terminal colors are independent. Web appearance is browser-local. The terminal keeps its selected color and animation; NO_COLOR, dumb/non-TTY and narrow output remain supported. Reduced motion disables decorative movement. Closed tabs and hidden views stop scheduled work. Model/usage data loads on demand; the Web UI adds no inference calls.

Activity, flow and current-run counters use one visible-page SSE connection at `/_ccdx/activity`. TUI activity subscribes to the same in-process notifications. Request starts, model/provider selection, first output, retries and completion coalesce within 50 ms; ordinary output chunks do not trigger pushes. A connection starts with current memory-only state, including the existing recent-request limits. Reconnection restores current state and totals; it does not replay animations or recover arbitrary old history. No replay buffer or durable event store is added.

The stream sends a small heartbeat every 15 seconds; the browser replaces a silent connection after 45 seconds. Hidden/suspended pages and Auto refresh OFF close the stream; returning reconnects with a fresh snapshot. A lost connection means activity is unknown, not idle. The old six-second snapshot expiry applies only to manual HTTP snapshots, not healthy push state. Catalogs, accounts, retained usage and update checks keep their separate on-demand/low-frequency reads. Visible context series refresh after request completion through the existing bounded reader.

Push reads do not invoke the complete diagnostic snapshot, read usage files, refresh credentials/catalogs or send inference. Up to eight native/same-origin loopback streams are accepted. Slow streams keep at most one newer snapshot and close if still blocked at the next heartbeat. Streams are excluded from request/work counts and closed before normal service shutdown. TUI static setup/preferences retain a ten-second local read; live activity does not wait for it. Animation frames and elapsed-time updates remain local. Existing reduced-motion and terminal output controls remain.

Desktop spacing keeps existing fonts, palettes, navigation and disclosure anchors. The header is 64 px at desktop widths; its existing narrow-screen layout stays responsive. Panels use 16 px padding and ordinary rows use 7 px vertical cell padding. Standard controls are 32 px high and inline source/model actions 30 px; coarse pointers retain 44 px controls. Multi-line animation choices retain their natural height. Compact padding does not change model lists, draft fields, settings behavior or focus outlines.

## Installation and updates

Use the installers linked in the [README](../README.md) when Node.js is unavailable. They support macOS and Windows on x64/ARM64, reuse a compatible Node.js, or install verified Node 24.22.0 privately. They do not install Git, compilers or system package managers, or change company registry/proxy/certificate/shell policy.

Complete Release packages include locked runtime dependencies. The updater verifies package identity, version and digests before installation, backs up the discovered package and launchers, and restores them on installation/runtime-check failure. A busy installation fails in place. Lock errors include the lock path; do not delete a lock held by another install.

`ccdx update github` uses the latest stable Release. Normal source-package installation uses the configured registry. After npm EALLOWREMOTE, the updater can use a verified same-version complete platform package without relaxing npm policy. Other failures are not retried across arbitrary sources. Explicit `--allow-remote` grants URL downloads to that installation's whole dependency tree, not one hostname; use it only if policy permits. No persistent npm setting changes.

Finish active work before updating the active installation, then restart CCDX normally. The installed package version can differ from the running process. No interruption-free upgrade is promised for an ordinary foreground service.

Overnight updates are opt-in. The supervised service checks within its local midnight window, stages only eligible patches in the same minor version, and waits for idle work before handoff. Candidates must be published for at least 24 hours. Failed preparation/handoff retains or restores the previous service. Enabling this feature requires its documented normal restart; it does not attach a supervisor to an existing ordinary process. Minor upgrades such as 1.2 → 1.3 remain manual.


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

Claude configuration and gateway catalogs use the same compiled model plan.
Explicit App bindings use opaque source-qualified aliases and actual model/source
labels. Verified 3.x App adapters can use a reasoning-compatible route when the
advertised levels form a client-expressible contiguous set. Older compatibility
routes remain resolvable for that authorized deployment. Gapped or unexpressible
levels are reported as limited; unsupported effort requests fail explicitly.
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
added. Exact input counting and compression thresholds are not proven by a small
reply; the upstream still enforces its actual limits.

Automatic sync can be disabled per client. Shared Claude fields are preserved
when a shared consumer has disabled automatic sync. Closing access restores owned
client connection fields; other active consumers retain shared planning. Review
sync shows declared capabilities, supported budgets and limitations. Reopen the
client after its owned configuration changes. All tests using sample capabilities
are isolated; they do not assign sample limits to a user's real models.


## Optional native predictions

Native next-message predictions are **off by default** and use no MCP, Hook, skill,
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

`prediction off` immediately disables new local overlays. Quit/reopen Codex to
clear its cached predictions and temporary route. If the App is still running,
trust removal is deferred; quit it and run `prediction off` again. Only the exact
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


## Optional image generation

Image generation is disabled by default. Configure it interactively only when you want Codex App to receive the local CCDX image tool:

```bash
ccdx app codex image setup
```

The command accepts an HTTPS base URL or a full `/images/generations` endpoint, then asks for an API key without echoing the key. A bare origin such as `https://api.example` expands to `/v1/images/generations`; `https://api.example/v1` expands to the same endpoint. Custom base paths are retained, and existing full endpoints remain unchanged. CCDX uses GET for the corresponding `/models` catalog and POST for image requests; there is no endpoint-search or automatic fallback. It asks for a numeric model selection only when multiple image models are available, then detects either the standard OpenAI Images request format or the supported `input.messages` format for the selected model only. Its single validation request omits the prompt and does not generate an image.

An empty key answer retains the saved key only when the normalized endpoint has the same origin (scheme, host, and port). Changing origins requires explicitly entering a key before any provider request; the old key is never automatically sent to a new origin.

The provider credential is stored in `~/.config/codex-copilot-dx/image-provider.json`, or under `XDG_CONFIG_HOME`, with mode `0600`. The API key is never written to `~/.codex/config.toml`; that file receives only a marked local MCP entry pointing to the running CCDX adapter with a 210-second tool timeout. Only after enabling, CCDX installs `ccdx-image` guidance under `~/.codex/skills`, with a self-contained Node helper. The concise `SKILL.md` keeps operation selection, safety, and final-image delivery rules; editing details and helper instructions live in references read only for those operations. Codex uses the MCP tool directly, including through deferred tool search; an already-open task without that tool can use the helper to call the same local service and display the saved image. Neither route requires Python, an OpenAI SDK, or copying credentials. Built-in skills and unrelated tools are not modified.

The enable command verifies the local MCP handshake and generation-tool directory without generating an image. It reports provider configuration separately from local service readiness; it cannot assert that every running Codex task has refreshed its catalog. Codex normally detects changed skills; restart Codex App once if an open task has not refreshed them. Normal CCDX startup installs or updates this guidance only for an already-enabled provider, without repeating API setup. Without `enable-image`, it installs neither this skill nor the MCP registration. Unchanged guidance is not rewritten. The existing adapter can remain running because provider settings are loaded when the tool is invoked.

For Qwen-style image responses, CCDX accepts canonical PNG, JPEG, or WebP `data:image/...;base64,` output within the existing 32 MiB image limit. Public HTTPS image URLs still use the same pinned-DNS download checks; HTTP, private-network targets, and URLs with embedded credentials remain rejected.

Existing compatible `ccdx_image` registrations are reused without requiring CCDX's comment markers or resetting user timeouts/tool policies. Missing or damaged markers alone do not block startup. Core GPT configuration is committed independently before optional image maintenance: image configuration conflicts, image-only write failures, or Skill maintenance failures warn without aborting the core service. No new image guidance is installed after failed image configuration. With images disabled or their provider configuration invalid/unreadable, normal startup performs no image configuration maintenance, Skill installation, or image-network probe; explicit `disable-image` owns cleanup. Automatic updates/removal are limited to recognizable CCDX defaults and isolated TOML declarations, never everything between two comments. Ambiguous shared-inline or customized registrations are left intact; `disable-image` still disables the CCDX provider and removes its owned guidance. Invalid TOML/UTF-8 in the shared Codex config or a failed essential core configuration write remains an explicit error rather than a silent success.

Direct MCP generations and edits retain their original inline image content and editing ID, and also save the exact image bytes privately under `~/.local/share/codex-copilot-dx/images`. The result includes ready-to-use image Markdown for Codex's final chat reply, so the image appears as a clickable thumbnail instead of only inside a tool result. Files use unique names and are not overwritten or removed on adapter restart. Asking to show the same image again reuses its existing Markdown, not a new generation or edit. If saving fails, CCDX still returns the generated image content, reports the delivery failure, and does not retry the provider or invent a file path. The bundled helper continues saving once at its existing output location, without a second adapter-side copy. Existing enabled users receive updated, unmodified CCDX-owned guidance on the next CCDX startup; no new setup command is needed.

Inspect or disable the optional provider with:

```bash
ccdx app codex image status
ccdx app codex image remove
```

`image-status` never prints the API key and performs only a local, non-generating tool-readiness check. It lists generation and editing separately based on the local tools/list response; a configured model name alone does not prove editing is available. Disabling removes the stored provider credential, the CCDX-owned MCP block, and unmodified skill, reference, and helper files; user-modified files are preserved. Cached tool calls then fail closed. The Node helper creates a new file under the task's `output/imagegen` directory by default and reports its absolute path; it never overwrites an existing file or automatically repeats a failed generation. The image endpoint is contacted only by `enable-image` validation and by explicit `generate_image` or `edit_image` tool calls. Ordinary Responses, models, authentication, Fast, Auto-review, compaction, and image-input paths remain on their existing routes.

Generated image downloads must use public HTTPS addresses, do not follow redirects, are DNS-checked against private and reserved addresses, and are capped at 32 MiB. Well-known NAT64 `64:ff9b::/96` addresses apply the same IPv4 public/private rules to the embedded address, without rejecting legitimate public translations. DNS resolution and downloading share one deadline and respond to cancellation; a late DNS result cannot start a cancelled download. The local MCP route accepts calls only from the same device and permits at most two concurrent image operations. Host must name loopback, the actual local socket address (including equivalent IPv6/IPv4-mapped forms), or the explicitly configured bind hostname. Missing Host remains compatible with HTTP/1.0 and in-process clients. It requires `application/json` and rejects browser `Origin` headers; native Codex and Node clients do not send an Origin. The tool supports new-image generation at `1024x1024`, `1536x1024`, or `1024x1536`.

Image API generation/editing requests retain same-origin HTTPS redirects, with Fetch's existing POST/GET rules, a 20-hop limit and one shared timeout/cancellation signal. Cross-origin, HTTPS-to-HTTP, credential-bearing or invalid redirect targets are refused before another request is sent. Use the final API base URL when a service redirects to another origin. Redirect bodies are cancelled; generation failures are not automatically retried. The provider's returned image-download URLs still never follow redirects.

The Chat compatibility bridge ignores repeated complete tool names only when the name is declared and concatenation cannot be a fragment of another declared name. Overlapping fragments, delayed names and ambiguous/undeclared streams retain their existing assembly rules; argument deltas and tool-call IDs are not deduplicated. Native Responses routing and payloads are unchanged.

`ccdx usage` reports genuine log-read failures with the normal error line and exit code 1, without an uncaught exception dump. Missing logs remain a successful empty summary; malformed records are skipped with a warning rather than making usage unavailable.

With `qwen-image-3.0-pro` or `qwen-image-3.0` using either supported protocol, CCDX also exposes `edit_image`. Ask Codex to modify a specific CCDX-generated image; it passes that image's returned `image_id` and the edit instruction to the same configured provider. Each edit returns a new image and ID while preserving the original; omitting `size` retains the source's requested dimensions. The Qwen request contains the source image again on every edit, as required by its [single-turn image editing API](https://help.aliyun.com/zh/model-studio/qwen-image-generation-and-editing-api-reference).

Editing references are opaque IDs bound to the provider configuration, not paths or URLs. Source images up to 10 MiB are kept in a 64 MiB byte-bounded in-memory LRU. IDs expire on eviction, provider/credential changes, or adapter restart; restarting Codex App alone does not clear them. A missing or expired ID fails before upstream dispatch. This feature does not import arbitrary local images or provide masks, transparent output, or an `/images/edits` endpoint. Other providers retain their existing generation behavior. The helper accepts `--image-id` for the same edit operation; its stdout remains the saved absolute file path and stderr reports the new ID. Normal host approvals still apply, and failed edits are never replaced with an automatic new generation.


## Security

- CCDX binds to loopback by default. Non-loopback hosts are rejected unless `CCDX_ALLOW_LAN=1` is set explicitly.
- Enabling LAN binding exposes a Copilot-backed API to other reachable machines. Provide your own host firewall and network isolation; do not expose the listener to an untrusted network.
- Inference POSTs reject any browser `Origin` header before reading the body or contacting upstream, including simple `text/plain` requests. Native Codex/Node requests without Origin and deliberately enabled native LAN clients keep their existing access. This is not authentication or protection against untrusted local native programs.
- Explicit auth tools store GitHub OAuth credentials at `~/.local/share/ccdx/github_token`, with precedence over the compatible legacy `~/.local/share/copilot-api/github_token` store. Short-lived Copilot service tokens remain in process memory and are refreshed as needed. First-time local discovery hands its verified service token to the startup client when the saved credential and account match and more than a minute of validity remains, avoiding a duplicate exchange. Existing cached tokens, refreshes in flight and account bindings are retained. See Account and repair tools for safe replacement/sign-out behavior.
- The optional image API credential is stored separately with mode `0600` only after `ccdx app codex image setup`; it is never placed in Codex configuration or diagnostic output.
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

The summary covers the current log and its single rotated backup, not an unbounded lifetime history. It reports recorded responses and per-model input, cache-read, output, and total token metadata.

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

Changing the model or transport of a continuation can require removing incompatible encrypted history from the forwarded request. A specific upstream encrypted-state verification failure can also trigger one sanitized retry, including when a nominally successful HTTP response ends with `response.failed`. CCDX withholds only the pre-output prelude of an encrypted continuation while evaluating that terminal event; it never retries after visible model output, so it cannot duplicate an already-started answer. Unrelated failures pass through unchanged. CCDX does not decrypt that state locally.

Native Responses forwards Codex `agent_message` items unchanged. When a model requires Chat Completions, CCDX frames them as messages from another agent, not human input or approval, retaining author/recipient, typed text/refusal/reasoning and representable image/screenshot content. Content unsupported by Chat, including file, audio or opaque encrypted parts, receives an explicit compatibility error instead of being serialized into ordinary text. This projection does not introduce another model request or change native Responses, Fast, Auto-review or compaction routing.

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

Usage queries for recently written logs may share an in-flight aggregate only when observed device/inode/size/mtime/ctime identities and query filters match. Those results are not kept after the scan. The existing two-second settled-file rule and bounded caches remain. Appends, rewrites, replacement, rotation, provider filters, time zone and calendar date retain independent identities. Custom warning callbacks bypass sharing. Cancelling one waiter does not stop other waiters; a bounded scan already started may complete without retaining its result.
