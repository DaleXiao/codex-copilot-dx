# Architecture boundaries

CCDX is one local Node service with client-specific protocol surfaces and isolated
upstream providers. GitHub is the default Codex provider; Microsoft 365 and explicit manual API connections are optional.
Client integration, image tools and the dashboard are not a general plugin framework.

| Responsibility | Ownership | Boundary |
| --- | --- | --- |
| Core inference | `adapter.mjs`, Responses modules, model catalog, history | Codex wire contracts, streaming and recovery |
| Providers | `providers/github.mjs`, `providers/m365*.mjs`, `providers/api*.mjs` | Source-owned auth, discovery, routing, capabilities and transport |
| Provider composition | `provider-runtime.mjs`, `connection-runtime.mjs`, provider/access settings | Explicit selection, lifecycle, history namespaces and snapshots |
| Claude clients | `claude-gateway.mjs`, `claude-client-lifecycle.mjs`, `claude-client-config.mjs`, `claude-models.mjs` | Native Messages relay and field-owned reversible client setup |
| Client integration | `client-integration.mjs`, Codex config, native prediction | Client setup, optional start/stop, diagnostic snapshots |
| Optional images | Image provider, CLI setup, image MCP and skill | Opt-in API access and image delivery; failures do not block core startup |
| Management | CLI, dashboard, observability, package updates | Bounded metadata and explicit user actions |
| Shared foundations | Codex paths, file locks, atomic files, network routes | No dependency on inference or dashboard rendering |

## Composition and lifecycle

### Manual connection graph (1.2.13)

`provider-runtime.mjs` composes built-in lifecycle with `connection-runtime.mjs`,
which owns grants, switches, versioned model-deployment bindings and lifecycle. `access-settings.mjs`
validates strict versioned metadata and locked atomic writes; stale cross-process
saves are rejected. Accepted inputs and public snapshots do not share mutable
objects with the live graph. The built-in registry does not load external code.
One Codex access-mode calculation distinguishes disabled, paused (no selections),
native GitHub and gateway bindings. Sync and request authorization share that
calculation; paused access is rejected before credential checks without expanding
model visibility or changing sign-in.

Manual API setup uses abort-aware shared waits for credentials and transport.
A cancelled caller releases its wait independently; a late shared result cannot
resume its request. Messages keeps body upload, preparation and upstream budgets
separate using the existing request-abort boundary.

`model-capabilities.mjs` owns neutral limits, reasoning/tool/input/search fields,
strict manual values, per-field evidence and deployment revisions. It reads no
credentials or client files. Explicit manual values override the current API's
structured declarations; absent or generation-mismatched fields remain unknown.
`client-model-plan.mjs` compiles immutable authorized catalogs and source-qualified
routes. `clients/codex-models.mjs` projects native Codex catalogs and
`clients/claude-models.mjs` owns desktop compatibility aliases. These adapters do
not read upstream credentials, and API providers do not import client projections
or configuration writers. Same-named models never collapse into one deployment.
Legacy null bindings retain their original single-source catalog; explicit arrays
expose only selected models. A v1 file is backed up byte-for-byte before the first
atomic v2 write. Source grants are not silently promoted to model grants.

Compiled plans are cached by immutable binding/source/catalog identities and
generation, not serialized on each request. The control plane refreshes metadata;
the data plane resolves a model once after its admitted bounded body read, then
pins the real provider, history namespace and capability snapshot through the
stream. Responses and Messages keep their existing admission, cancellation,
backpressure and history paths. A shared Messages admission pool spans client
handlers. Failed calls do not select another provider.

`claude-capability-config.mjs` plans shared App Code/Code host fields once for all
managed consumers, then uses `claude-client-config.mjs`'s existing field journal.
Per-model compact budgets are distinct from the largest shared host window.
Unknown/unsupported consumers prevent unsafe global context overrides; unowned
Code base settings, explicit environment values and manual fields are preserved.
Shared operations have a separate restore selector, so pausing Code cannot tear
down active App budgets. Sync work coalesces and reruns once for newer control
state rather than letting concurrent App/Code writes race. No permission or
safety-review field is owned by this adapter. Native version/schema limitations
are public data, not fabricated capabilities. Output constraints are recorded as
bounded revision/constraint labels in existing request context observations.

`providers/api.mjs` owns configured native clients, model capabilities,
configuration/key history identity and bounded discovery. Its protocol-specific
capability snapshots feed both request validation and application projections.
`providers/api-model-metadata.mjs` interprets declared common/Anthropic catalog
schemas without a model-name registry. Native thinking and effort stay distinct;
Messages declarations do not leak into other protocols. `connection-runtime.mjs`
serializes automatic refresh on save/start/existing refresh ticks, coalesces
refresh batches and retains last-good data on failure. Normal reads use a
30-minute cache; explicit reads/failures have a one-minute minimum interval.
Catalog-only changes preserve grants, source identity and running requests;
endpoint/credential changes create a new private revision. Environment credentials
are captured per provider instance so an active request cannot adopt another key.
It uses no
Copilot/M365 retry or request-body policy. Its lazy transport is retained per
configuration, not rebuilt or serialized against the whole catalog per request.
`providers/api-network.mjs` preserves enterprise routing/TLS and pins exact HTTPS
targets, with a GET-only validated catalog cursor exception. The WinHTTP API mode
checks the same allowlist/cursor boundary in JS and C#; prediction/M365
retain their original host restrictions. A failure before response headers marks
the transport unhealthy. The next request replaces it without replaying the
failed call; retirement waits for unrelated active responses to drain. Shutdown
still closes all current/retiring transports. HTTP error statuses and intentional
cancellation do not invalidate the transport. Node response streams are pulled
on demand to avoid eager delivery into an already-cancelled Web stream.
`operation-error.mjs` projects fixed transport phases, a local error-code
allowlist and socket-reuse evidence. API errors preserve their private cause,
but client diagnostics/logs expose only those bounded fields, not raw causes,
addresses, credentials, headers or prompts.

The API editor separates catalog candidates from selected models. Only selected
models enter the strict saved graph, with a required native protocol; unused
ID-only catalog entries cannot invalidate a save. Client grants remain separate from model visibility and protocol reachability. Source CRUD/capability details live on Model sources; application pages select deployments/defaults and review synchronization; Settings retains common preferences. The App and Code use separate segments and keys.

`api-secrets.mjs` owns OS-protected credentials and a private-pipe cache; no
command argument contains an upstream key. Failed metadata commits remove their
candidate key. Retired keys/transports wait for pinned requests. An environment
reference provides headless operation without plaintext files or a new npm
dependency. `private-helper-environment.mjs` retains OS credential-service and
company-network inputs while omitting unrelated credentials and Node hooks.

`client-gateway-keys.mjs` separates caller identity from display hints and upstream
credentials. `codex-api-config.mjs` reconciles an owned provider/model/table with
paired writes. Native sign-in material/store policy keeps OpenAI authentication
enabled for account operations; the static local bearer still takes precedence
for model requests. No native credential writer is added. GitHub-only bindings
retain legacy loopback callers but expose only selected models; any mixed or
non-GitHub binding requires the private Codex key. Bound catalog reads use their
compiled facade even when the default source is GitHub, without a live refresh.
Claude uses its existing mounted relay and field journal with
independent app/code lifecycles. M365 beta policy is not imposed on API clients;
adding a source alone never migrates old client credentials. Configuring clients
does not patch/restart their binaries or override managed settings.

`claude-models.mjs` owns deterministic desktop compatibility routes for manual
Messages sources. The same mapping feeds the App field writer, authenticated
App catalog and gateway resolver; Code/Codex and M365 do not adopt these aliases.
Standard Claude IDs retain their native family identity. Other model routes use
opaque digits with the real ID as `labelOverride`, without asserting Anthropic
capabilities. The gateway canonicalizes the request before history validation
and upstream dispatch, then projects the requested alias only into the returned
JSON model field or SSE message-start model field. Bounded SSE observation
retains other frames and applies client backpressure without a separate tee.
Usage and performance continue to identify the upstream model. A route cannot
authorize a model outside its source's Messages catalog.
For this same manual App boundary, system-role text is collected into the native
top-level system field in order; conversation blocks and their order are retained.

`conversation-source-guard.mjs` retains bounded HMAC correlations for observed
managed histories. Codex and Claude Code retain their existing conflict checks.
Claude App explicitly supplies the protocol-level `messages-history-transfer.mjs`
policy after resolving an authorized model/source. The policy has no application,
provider or model-name rules. It rebuilds only the forwarded Messages prefix,
removes source-private thinking from that prefix, preserves native completed tool
pairs and available media, and rejects unfinished tools or unrecoverable source
handles. New-source thinking after the checkpoint stays unchanged. Changed
prefixes can be rebuilt only at a completed tool boundary. It adds no automatic
retry, summary inference, routing fallback or conversation database.

Transfer records are bounded to 1024 hashed keys per 512 KiB versioned file;
they contain owner hashes, prefix hashes and counts, not transcripts.
`conversation-prefixes.json` adds protocol-equivalent block fingerprints beside
the unchanged legacy `conversation-transfers.json` shape. Strings and single
text blocks compare equally; adjacent same-role messages can be combined without
changing the proved block prefix. Text/code whitespace, arrays and tool argument
values remain significant. Only protocol cache hints are excluded. The semantic
receipt is anchored to its legacy owner/count/hash so an older writer invalidates
stale proof. Both files commit under the existing lock and atomic file-pair
rollback. Legacy receipts upgrade only after their prefix is proved; unmatched
old history is never guessed. Old versions can still read the legacy receipt.
Count/model-validation requests do not rebind. A per-conversation request lease
pins active source work; the gateway commits a checkpoint immediately before
delivering usable output/tool/private state and releases every lease on failure
or completion. Pre-output errors preserve the earlier checkpoint, while partial
output keeps the actual source's provenance. A matching private request grant
allows first association with the selected M365 account; known foreign account
owners are still refused. Native Responses recovery/configuration is unchanged.

`dashboard/connections.js` owns settings forms; application source/review and
account/catalog views keep their existing scopes and use the same backend graph.
M365's `source_access` action changes client grants without choosing a source or
model. Only revoked active routes and necessary shared-key migrations synchronize
client configuration; unrelated clients and empty sync targets are untouched.
Unchecked routes are removed from runtime authorization while other deployments
remain selected. Fresh discovery without owned legacy configuration grants no
automatic M365 consumers; existing graph/legacy ownership is retained. Explicit
CLI source selection remains an intentional grant for Codex only. Shared native
Claude capability settings are preserved when an unaffected consumer is not yet
checked, until normal reconciliation can verify both consumers.
Its binding draft retains selected identities independently from current catalog
availability. Missing selections stay visible and cannot be silently dropped on save.
Full configuration is on-demand; ordinary status uses compact cached summaries.
Disabled sources and clients have separate restore lists inside their owning
Settings cards, hidden when empty.
Shared Messages observation includes all sources, while M365-specific status
projects M365 counts. Bounds cover two built-ins plus 16 APIs without unbounded
labels, request histories, body logging or a new refresh loop.

### Provider boundary

Each provider supplies its client, model registry, route plan, model/request policy
and compatibility opener. The existing GitHub implementation remains the default;
its Fast mapping, retries and recovery are not applied blindly to M365. Protocol
adaptation belongs to the client boundary. There is no generic intermediate message
format that would erase native Responses or Anthropic semantics.

`provider-registry.mjs` declares the bounded internal source metadata used by selection validation and dashboard source choices. It loads no external code; GitHub and M365 remain built-in sources. `access-settings.mjs` validates up to 16 user-defined API records; `providers/api.mjs` is their first-party implementation, not a third-party code loader. Client grants, selected deployment sets and defaults remain in composition.

`provider-runtime.mjs` owns source selection, not the providers themselves. Each
request pins a provider before admission. An explicit change affects later requests;
it does not reroute an in-flight stream or retry it through another account. Core
`providers.json` stores Codex selection separately from the optional M365 profile.
History lookup keys include source/account namespaces; the existing global byte
budget remains shared. Explicit source transfer can restore visible history but
cannot silently discard encrypted tool or compaction state. Existing verified local
plaintext recovery is attempted at that boundary; failure remains explicit.

M365 discovery is background-only when GitHub is selected. On supported platforms,
a bounded short-lived Node helper loads the official optional Microsoft broker
runtime, discovers an unambiguous/matching account and requests a token silently.
Private pipes carry the result; no token is saved or logged. Cached tokens refresh
within two minutes of expiry, with single-flight cancellation and bounded failure
backoff. Device management is not inferred to be sufficient authorization.

The fixed Loki target, account-bound catalog and dedicated network agent belong
to M365. No GitHub token, image credential or browser Cookie is reused. Windows can
use a separate OS WinHTTP worker for M365 company routing; macOS preserves static
system/environment routing and reports unsupported dynamic PAC. Native runtime
absence and policy refusal do not disable GitHub.

`network-route.mjs` canonicalizes abbreviated IPv4 CIDRs only while adapting system `ExceptionsList` input, before merging it with the unchanged strict `NO_PROXY` input. `network-bypass.mjs` remains the shared strict Node/PAC matcher; it performs no DNS lookup. This fixes no-proxy and static-proxy macOS configurations without dropping exception rules or weakening unsupported dynamic-PAC protection.

`providers/m365-endpoint.mjs` declares the fixed production origin and path shared by Node transport and the Windows parent whitelist. A regression checks the C# worker’s matching fixed-host policy. Catalog publication and history namespaces include the service origin and company account; legacy/different-origin caches stay on disk but do not publish as the new catalog. No cross-environment retry or implicit source switch is introduced.

`providers/m365-network-diagnostic.mjs` is a small pure projection of fixed proxy failure codes, source and stage, shared by transport, provider state, protected dashboard routes and CLI. Raw error chains/settings never cross that boundary. M365 retains existing outer error categories; the source runtime forwards the bounded diagnostic, and existing bilingual renderers expose a readable explanation with technical details. Startup uses the same fixed English explanation. Refresh failures retain last-good catalogs and never change the selected provider; successful transport creation clears the setup diagnostic. No new service, storage, dependency, route fallback or provider retry is introduced.

`claude-client-config.mjs` treats only the typed App-owned `prefer1m` flag as a
mutable preference during ordinary model-list synchronization. The generated list
keeps that flag per exact model name and defaults declared 1M entries to one 1M
choice. Structural comparison tolerates JSON formatting, but not changed managed
fields or model ordering. Already-desired manual recovery can refresh an existing
ownership record only when surviving recorded entries remain unchanged apart from
that preference. Its original `before` value stays intact; it does not claim an
unowned field or broaden restoration, route, key or organization-policy authority.

`claude-client-lifecycle.mjs` owns configuration reconciliation and restore state, independently from source auth/catalog code. It checks lifecycle/profile validity after asynchronous policy inspection and preserves the existing field-ownership writer.
Claude handler/configuration readiness is also separate from M365 provider
readiness. A Claude setup failure or a GPT-only catalog cannot block the explicitly
selected Codex backup; a catalog without Claude models does not install Claude settings.

The Claude gateway is mounted at /anthropic in the main listener, independently requires a loopback socket/Host and its private local key, and
rejects browser-origin requests. It preserves native Messages/SSE bytes, observes
bounded usage/terminal metadata and honors downstream backpressure. The client
writer records field-level ownership before applying changes and restores only
fields that still match its own values. Foreign gateways and managed desktop
policies are not overwritten. Removing M365 does not remove shared management,
GitHub auth, prediction, image configuration or historical usage.

Company-account discovery and selection are separate from token acquisition. `providers/m365-accounts.mjs` normalizes/deduplicates broker identities, excludes consumer accounts and applies saved binding → unique exact system UPN → single-company-account selection. A bounded Windows system `whoami.exe /upn` lookup runs only for unbound multiple-account discovery; failure never guesses an identity. The short-lived native helper's `accounts` operation performs no token acquisition. `provider-runtime.mjs` owns explicit account changes: admission is paused for M365, a separate candidate validates one account/catalog, then the locked binding writer commits before provider/gateway replacement. GitHub is unaffected; failed candidates are discarded. CLI and the same-origin dashboard use this composition boundary rather than invoking authentication themselves.

`providers/m365-conversation-accounts.mjs` bounds account ownership metadata to 1024 hashed conversation keys, writes only on first association, and refuses cross-account or unknown old history after account changes. Response-history transfer between M365 account namespaces is disabled. Binding metadata retains selection provenance and history isolation across restarts; it contains no token. Catalogs remain account-fingerprinted. These controls do not establish Windows enrollment, model entitlement or successful inference, and no account is tried merely because another was refused.

### Existing service composition

The CLI composes the service. Client integration owns its `configure`, `start`,
`snapshot` and `close` operations. It does not forward inference requests or
render the dashboard. The adapter exposes integration snapshots and keeps
management/MCP routes separate from the Responses path.
`management-routes.mjs` owns status, health, cache control and prediction repair
HTTP checks. It receives a snapshot callback and the existing explicit repair
action, not a model client or a second recovery lifecycle.
`optional-routes.mjs` owns lazy WebUI/API and image-MCP dispatch and image stats.
The adapter remains the HTTP composition root; neither extracted route module
imports it. Native prediction belongs to client integration, WebUI to management,
and terminal animation to presentation. Input-image optimization remains core
multimodal inference, distinct from optional image generation. This is a module
boundary, not a plugin framework, daemon, IPC protocol or package split.
The HTTP dispatch boundary rejects browser Origin-bearing inference requests
before body admission, credential use or provider dispatch; native LAN opt-in is unchanged.

Manual package installation is an explicit management operation in `package-update.mjs`,
not part of inference or optional client integration. Windows uses the system
command interpreter only for the fixed `npm.cmd` installer command; stable-tag
validation remains upstream of launch. macOS uses direct npm argv. There
is no generic shell runner or package-manager framework, and npm's configured
registry/proxy environment remains owned by the user.
Readonly npm policy discovery is update-only and uses the same global context as
the installer, not an unrelated working project's `.npmrc`. It queries version,
`allow-remote` and registry only, never the complete credential-bearing config.
Default installer argv preserves the saved download policy. The boolean
`--allow-remote` opt-in adds one fixed permission argument only when supported;
it applies to that installation's entire dependency tree, not selected hosts.
Unknown support fails before an explicitly requested override. npm stderr is
forwarded unchanged while a bounded scanner recognizes only EALLOWREMOTE.
A confirmed GitHub dependency-policy refusal rolls back the first installation,
then permits one same-version complete platform package attempt offline. Other
failures do not trigger a retry. There is no npm policy write or public-registry
fallback. Explicit npm-source updates retain their original source.
The source lock retains exact versions/integrities without binding smol-toml to a
developer's corporate feed; omitted registry resolution is delegated to npm.

`release-install.mjs` owns complete-asset names, platform selection and bounded
SHA-256/version/target/bundled-root validation. Manual GitHub updates and nightly
candidate preparation reuse this contract. Complete installs disable network
dependency resolution and scripts; existing installation protection and native
runtime verification remain required. Bootstrap prefers a manifest-listed complete
asset and retains the old path for source-only releases. `runtime-package.mjs`
builds each complete package from the exact standard source tarball plus its
locked runtime dependencies, pruning only unrelated Broker OS/architecture files.
The npm artifact remains unchanged in form. Native target CI installs complete
packages using empty caches and strict npm12 offline policy. No runtime component
cache, new loader, inference route or background process is introduced.
Readonly update preflight reports Node/npm, the running package and npm's selected
global target. A different target warns, but never changes PATH or prefix. Its
bounded npm probe is limited to explicit update/full doctor commands and opted-in supervisor startup, never inference.
Its stdout/stderr are captured separately; npm configuration warnings do not
leak into doctor output. The real installer's inherited streams are unchanged.
After installation, the updater verifies bounded package metadata at that same
selected target, with exact-version verification for GitHub. It never equates
installation with replacement of an already-running service.

Authentication keeps its public facade in `auth.mjs`. Device-code polling and
cancellation live in `auth-device-flow.mjs`; local discovery and transactional
credential storage live in `auth-credentials.mjs`. These modules do not depend
on the CLI, dashboard or service composition root.
`auth-sources.mjs` isolates known external credential contracts: legacy OpenCode
Copilot OAuth and noninteractive GitHub CLI token retrieval. Provider-specific
readers do not validate or write credentials. The auth facade enforces bounded
GitHub/Copilot validation, account matching and ambiguity handling. Saved-token
startup does not scan sources or make new validation calls.
An optional `ensureAuth` import callback hands verified discovery results to the
startup client's `reuseVerifiedAuth`. The session rechecks the saved credential
and identity, expiry and existing cache/flight/account binding before using the
existing cache writer. Rejected handoffs leave normal refresh behavior intact.
No service-token file, shared global handoff cache, new endpoint or configuration
field is introduced; the auth facade still imports no runtime/client module.

`windows-command.mjs` owns exact npm-generated CCDX PowerShell launcher cleanup.
Best-effort Windows startup, the verified updater target and explicit doctor
repair share it. No install-time lifecycle script is added. It never edits
profiles, aliases, execution policy or npm's own shim.
Custom launchers and unverifiable installations are preserved.

Doctor composition stays in `doctor.mjs`; inference probes live in
`doctor-compat.mjs` and explicit bounded repairs in `doctor-repair.mjs`.
Repairs reuse the startup config transformation and prediction management API;
they do not start another adapter or implement a second prediction lifecycle.
Configuration repair takes the existing lock and commits the previous-file
backup transactionally. Disabled optional features stay disabled. JSON reports
separate before checks from final repair evidence; HTTP 200 alone is not success.

Native prediction has a separate loopback transport and an isolated HTTPS agent.
The opted-in listener starts in parallel with auth/model initialization,
independently of Copilot credentials. A slow optional start cannot block core
listener setup, and fatal
startup cleanup closes any optional listener that was already started.
Only its two selected hosts use the App-specific route. Non-configuration requests
on those hosts are forwarded unchanged. The bridge does not replace Copilot or
image-provider networking, modify client program files, or install system trust.
App identity checks use system metadata and asynchronous platform verification,
without reading an App archive or renderer implementation. Only recognized live
configuration responses receive the existing prediction overlay.
Static upstream proxy routes and bypass rules are preserved. IPv4/IPv6 CIDRs
match URL IP literals, without DNS. macOS dynamic PAC/WPAD remains unsupported
and is reported rather than discarded.
The Windows adapter isolates registration, process, proxy and NTFS
interfaces in `native-prediction-windows.mjs`. The bridge, overlay, model selection
and lifecycle remain shared. Windows discovery requires verified registration
and an existing unambiguous profile; no generalized OS framework is introduced.
Windows certificate issuance is a separate one-shot helper
(`windows-prediction-certificate.mjs` / `.cs`), not part of the network worker.
Node generates RSA keys and sends them through stdin to the system .NET
`CertificateRequest` API; only public certificates return through stdout.
The existing PEM reader, App-profile trust schema and transactional activation
remain shared. Issuance requires neither external OpenSSL nor a Windows
certificate store. Valid existing credentials skip issuance; default-off startup
does not invoke it. macOS keeps the existing system OpenSSL implementation.
Windows automatic-proxy support uses an isolated native WinHTTP worker
(`windows-http-network.mjs` / `windows-prediction-network.cs`) for company routing, authentication and
TLS trust. `windows-prediction-network.mjs` preserves the existing prediction
interface. Each worker is restricted to one fixed target group: prediction hosts
or M365 Loki, never an arbitrary URL supplied by a client. Its private,
credit-based pipes stream data without transcript files.
The existing C# filename and entry class remain available for an older running
prediction bridge during package replacement; there is no duplicate worker source.
The App PAC delegates unrelated URLs to the company script; Node never executes
that script. Prediction and M365 never share a worker or its lifecycle. GitHub and
image networking are unchanged; disabled prediction does not start its worker.
M365 starts its own worker only after successful authorization when explicit
environment routing does not take precedence.
Bridge-port ownership is shared across macOS and Windows in the existing
prediction lifecycle, with locked first-start persistence and no replacement
on conflict. OS process inspection stays in the launcher/platform boundary;
it runs only for explicit prediction-enabled launch/reuse, not per model request.
macOS uses bounded system `ps` reads and Windows retains its existing registered
process checks. No process is stopped and no App-process watcher or dependency is
added. Core inference keeps its existing service port and lifecycle.

`native-prediction-recovery.mjs` supervises only the enabled optional bridge,
using a low-cost listener check, same-route restart, single-flight recovery and
a three-attempt budget. It does not watch App processes, modify proxy policy or
replay inference. `native-prediction-route.mjs` separately owns the closed-profile
preference transaction and its rollback metadata. It accepts direct environments
only, preserves company/user routing, and never treats a saved preference as
proof of a running route or visible candidate. App compatibility is rechecked only
when its recorded identity changes, before existing trust/port checks are reused.

`native-prediction-app.mjs` owns asynchronous installation identity checks. macOS
uses signed bundle metadata and executable stamps; Windows uses the official Store
registration and executable stamp. Renderer files and archive layout are not
compatibility gates. Concurrent checks share a bounded signature result cache.
Legacy identity records are reverified on first use while keeping their certificate,
port and profile. A Store update may change its install path only when the official
package family and selected profile remain the same. Known configuration schemas
remain the overlay boundary; unknown payloads retain the existing pass-through rules.
The optional TLS transport has a 64 KiB header budget for requests, replies and
upgrades, with bounded stage/target diagnostics rather than header contents.

`prediction-pac.mjs` is the pure shared format boundary for direct, static and
Windows company-PAC composition. Its stable revision URL makes a one-time old-PAC
migration observable without coupling routes to package versions. The unchanged
primary endpoint comes first; a clock-bucketed `.localhost` secondary lets
Chromium retry the same restored listener despite its per-endpoint failure cache.
The original company/direct fallback remains afterward. This adds no Node DNS
lookup, timer, listener, process or inference-path work. Browser route recovery
and the client's independently cached prediction configuration remain distinct;
neither is a visibility guarantee.

Explicit `prediction fix` uses the optional integration's serialized lifecycle,
not a second adapter or detached predictor. Startup, repair and shutdown cannot
create overlapping owned listeners. Healthy/current bridges are retained; explicit
recreation preserves the saved port and existing trust and starts one new supervised
lifecycle. The supervisor delegates health/route checks to its current bridge after
recovery, not a closed initial transport. The health endpoint advertises repair
capability only when the composition root supplies that operation.
`native-prediction-fix.mjs` is the bounded local management client; the adapter
enforces loopback/Host/Origin/method/media/body boundaries before dispatch. No new
inference-path work, watcher, runtime dependency, forced App restart or unverified
hot-attachment mechanism is introduced.

`network-bypass.mjs` compiles static host/IP/port/CIDR rules. The exact pure
address/matching functions are embedded in the PAC and called by Node, with no
DNS or system calls. Matching IP literals instead of resolving domains preserves
Chromium's manual bypass semantics and SOCKS remote DNS. Existing domain matching
and per-protocol source priority are retained; unused lower-priority static proxy
addresses do not override selected routes.

`native-prediction-environment.mjs` owns bounded, read-only discovery for the
optional feature. Only enabled startup, explicit fix and failed-listener recovery
read system policy. Private comparison hashes include effective proxy settings
and Node trust inputs; public snapshots contain source/type/counts and diagnostic
states, not addresses, credentials, file paths or hashes. Trust-file inspection is
diagnostic, not loading or modifying certificate trust. Changed trust inputs need
a service restart. A changed network snapshot reuses the port but marks a running
App for PAC reload until it is observed closed or with a different readable PID.
Failed rechecks preserve the existing bridge and return a non-success result.
There is no new watcher, global environment owner or inference/image dispatcher.

`startup-ui.mjs` is pure terminal presentation: a static A atom, aligned checks
and the common new/reused-service footer. It depends only on terminal/status
utilities, not on inference or platform probes. The CLI feeds existing lifecycle
results into it; presentation does not run doctor, call models or wait for optional
background tasks. All status tags share one fixed-width column.

Connection-ownership replay rejection is a provider-owned retry policy. It
removes only unavailable reasoning once, preserving visible history and tools.
Opaque compaction cannot be assumed equivalent to remaining plaintext. The
`0.9.28` injects a lazy, asynchronous local recovery capability
at the HTTP boundary, while preserving the synchronous provider-selector API.
`local-compaction-recovery.mjs` owns source lookup, readonly decoding and verified
reassembly; it is not a general transcript service or startup scanner. The
provider policy decides whether to retry. HTTP and pre-output SSE/JSON failures
share the single-use policy, byte admission and cancellation boundaries.
Without a complete verified local source, rejection still returns
`ccdx_history_rebuild_required`, without modifying stored history. Diagnostic
metadata cannot reconstruct unavailable encrypted memory. LAN/browser callers
and referenced/split histories do not gain filesystem recovery access.
The recovery module reuses the existing abort-aware singleflight for equivalent
source reads, not prepared requests or reservation handles. Caller validation and
admission remain independent. Only bounded snapshot-bound failure codes survive
settlement for two seconds; no successful plaintext cache or transcript index exists.

## Dashboard reads

`account-tools.mjs` is the shared explicit GitHub sign-in/check/sign-out boundary for CLI and WebUI. It reuses bounded device polling and `auth-status.mjs` access checks, isolates candidate credentials until verification, compares the original credential under the existing cross-process auth lock, and atomically commits to the CCDX-owned store. It does not own Microsoft SSO. Public snapshots project fixed stages/codes and omit token material. A cancelled or failed candidate is never persisted; the service keeps one sign-in controller and one connection-check flight, with bounded lifetimes/cooldowns. Explicit cache invalidation aborts a pending token refresh while preserving the runtime's account binding. The CLI notifies a compatible local service after changes; account changes require a restart.
The verification view starts one deferred ClipboardItem write in the explicit
sign-in gesture, resolves it only to the short public user code and retains an
explicit writeText/selectable-text fallback. Fixed-URL native link activation
retries copying without awaiting a popup-blocking task. Flow/account generations
ignore cancelled or obsolete completion; unchanged polls do not rewrite or
reannounce the clipboard feedback. No clipboard read or token projection is added.


`local-tools.mjs` reuses doctor and the existing config writer. It projects redacted local checks and a revision-bound config preview rather than wrapping arbitrary shell commands. The config writer validates the revision again inside its own lock, then preserves unmanaged settings and backs up changed originals. `dashboard-tools.mjs` owns the small strict action schema and bounded request-body transport; `optional-routes.mjs` creates these tools lazily per handler and disposes sign-in work when the listener closes. `dashboard/tools.js` owns the source-specific account view, user-triggered checks/preview and local progress polling; source selection does not change routing. `dashboard/icons.js` supplies fixed local circle SVGs and separate localized text nodes, preserving language changes without replacing the icons. No runtime dependency or per-stream instrumentation is added.

`cli-web.mjs` provides an unauthenticated management bootstrap. It opens an existing compatible listener or composes the management listener and provider controls without app writes/launch, prediction setup or automatic M365 start. It is deliberately separate from normal launcher side effects; normal app startup follows after stopping this management-only process. CLI feature pause/resume delegates to the existing preference gates; full removal/setup remains in the original integration commands.

`provider-descriptors.mjs` projects plain source/client evidence without transport, configuration writes or lifecycle ownership. `provider-runtime.mjs` supplies its existing snapshots and composes these descriptors separately from
source-selection actions. `provider-metadata.mjs` projects bounded model metadata
without transport or credential dependencies. `dashboard-api.mjs` sanitizes public
fields and keeps local credential validity separate from authorization evidence.
A requested catalog Provider must be registered; unavailable sources never fall
through to another source. The unchanged CLI model selector retains its GPT scope.

`dashboard/refresh.js` owns one visible-page timer, in-flight deduplication,
freshness, cancellation and last-good snapshots. `animation.js` owns terminal animation selection, preview timing and saving, with injected view helpers and the shared refresh controller; it does not select providers. `time.js` formats local 24-hour timestamps in both UI languages.
`ui.js` generates Provider tabs
and source filters from descriptors and retained history, with per-tab snapshots
invalidated on profile generation/account changes. It cancels obsolete reads and
prevents stale apply across tabs. `status.js` renders source-neutral authorization
and client evidence; `usage.js` renders usage and date selection. View state remains
page-local; only existing preferences and the viewed model Provider are saved in
the browser. Expanded sections read on demand. The directory and Codex selectors share the same catalog resource, freshness and single-flight read. Changing sources cancels an obsolete waiter; generation checks reject late results. Account changes clear old-source drafts and snapshots; ordinary refreshes retain pending choices. There is no Node data watcher.
The sidebar controller reads view-scoped process-local status snapshots every two seconds
while visible/automatic, and source/settings evidence every eight status ticks.
Catalog and retained-log reads retain their slower, view-scoped policy. Animation
frames still load once per page when opened.

`settings-preferences.mjs` owns the explicit settings-page allowlist, normalized
defaults, revision checks and the single private pre-reset snapshot. Reset uses the
existing file-pair transaction with the backup written first; unrelated config
keys stay in the original file and never enter the backup. `service-control.mjs`
keeps its existing serialized action boundary and applies terminal/update effects
after the saved preferences commit. It never routes this operation through client
setup, account recovery or connection migration.

`dashboard/preferences.js` owns page-local drafts, coalesced writes, manual saving,
revision conflicts and browser-local appearance backup. The existing theme and
animation views expose small explicit preview/selection hooks. Settings writes
invalidate only animation/settings evidence, without model or account refresh.
Summary and complete status have separate refresh resources. `status-summary.mjs`
projects the optional lightweight response; full status stays the default public
contract. Hidden status regions defer DOM updates, and summary rendering never
replaces the full request/history cache.

`dashboard/usage.js` owns bar/curve geometry and viewport-gated, one-shot Web Animations. The two views share retained analytics and accessible day buttons; their paths never connect unavailable history or overshoot adjacent values. View-only changes leave the calendar nodes intact. The UI lifecycle cancels motion on hidden/suspended views and reduced-motion changes; no animation timer or chart dependency is added. `usage-store.mjs` shares cache-evidence validation between retained summaries and process-local totals; runtime snapshots expose the weighted cache ratio plus a partial-evidence flag, without new persistence or log scans. The Overview renderer formats that snapshot and preserves unknown/invalid values.

`dashboard-updates.mjs` is loaded only by the protected update-information route. It projects bounded public stable-release metadata and publication dates, with process-local single-flight, five-minute success and one-minute failure caches. Its asynchronous npm network-configuration read reuses the installer's existing policy-preserving downloader; it adds no runtime dependency, credentials or synchronous child process on the service event loop. Metadata has a four-second per-request deadline and 128 KiB decoded-body bound. It never installs or restarts anything and does not alter startup's independent web-redirect lookup. `dashboard/updates.js` renders current/available/unknown states and validated, pinned installation command text; `refresh.js` owns its visible Settings refresh cadence. Failed checks preserve explicitly labeled prior metadata. No provider authentication or inference is involved.

`claude-models.mjs` owns exact ID spelling and capability-cap projection shared by
configuration and model discovery. M365 resolves both canonical and existing raw
IDs to the same catalog entry and checks explicit effort lists without modifying
signed blocks. Successful refreshes schedule a coalesced client reconciliation;
it checks current lifecycle/profile after policy inspection, preserves ownership
and does not write in the inference serialization path. The Messages gateway uses
its injected Provider ID for diagnostics/usage. App model knowledge remains under
Anthropic's signed catalog and installed-client protocol, with its existing policy.

`upstream-body.mjs` is the shared bounded response reader. The transport retains
its existing exports; live model lookup uses the same 8 MiB catalog limit as
core model discovery, without importing the request lifecycle or UI layer.
Overlapping live queries with the same credential fingerprint, home, fetch
implementation and lookup parameters share one in-flight lookup. A waiter can
cancel independently; the last cancellation aborts the lookup. Completed results
are not cached as live, and each waiter receives its own snapshot.


### Shared listener and service controls

The main adapter counts each HTTP request once. /anthropic dispatch strips only
the protocol mount prefix and preserves its query; the mounted handler retains
native authentication, admission, Messages timing and response ownership. Closing
Claude cannot close the main listener. Provider credentials/history namespaces and
protocol-specific timing stay independent; the UI names the scope rather than
summing incompatible counters. Root legacy Messages routes remain retired.

`service-control.mjs` composes explicit preference/Provider/cache/integration
actions with serialized writes and effective-state readback. It has no transport,
UI or shell dependency. `dashboard-api.mjs` supplies the local/same-origin HTTP
boundary. Client configuration migration reuses field ownership and its original
before-values, preserving foreign or edited fields. Saved allow gates are separate
from provisioning; pausing never deletes the Provider key or prediction trust.

`terminal-console.mjs` owns a bounded TTY status region and activity only.
Its region has wrapping source/Claude summaries, a responsive line-framed table,
then separate notice and activity rows. Snapshot data is read about once a second;
animation ticks reuse the table and write only changed rows. Small viewports (under 40 columns / 16 rows, or unable to fit the full region) retain plain output. Failed snapshot/preference reads preserve the last successful view with an explicit stale marker and timestamp; initial read failure is distinct. Client-originated cancellations
are informational; timeouts and actual failures remain notices and file diagnostics.
`log.mjs` routes terminal presentation independently from existing opt-in,
redacted rotating file records. Returned usage accumulates bounded process-local/source
totals in `usage-store.mjs`, without a historical-log scan or per-token callback.
`browser-launch.mjs` makes one bounded local desktop-open attempt after readiness;
no headless/SSH launch, browser dependency, generic shell or background tab watcher
is added. Neither terminal nor WebUI rendering is required for inference.

Dashboard messages have stable IDs independent of English and Chinese display text. Static HTML carries IDs and readable English; dynamic rendering uses the same catalog. Compatibility keys remain for runtime state/diagnostic messages. The synchronous catalog preserves language/theme initialization without an extra fetch.

`serviceSettingsSnapshot` projects flags, animation and the history preference from one strict file read per update; no new persistence cache hides external edits or corrupt configuration.

## Configuration ownership

`CODEX_HOME` selects Codex configuration. App profile/trust paths have their own
selection and are not inferred from that directory. CCDX writers use a shared
per-file lock, reread current contents and preserve unrelated values. Locks do
not coordinate editors or other applications that ignore them. Read-only status
and doctor commands do not write configuration.
Small local reads use one open file descriptor with byte limits: 1 MiB for
settings/auth metadata, 64 KiB for token files, and 9 MiB for cached model data
(including metadata). This does not change session/history limits or symlink
semantics. Full doctor checks credential permissions without reading secrets:
POSIX mode bits or Windows allow entries are review evidence, not a complete
effective-access calculation. It never rewrites ACLs or blocks startup.

Core inference interfaces remain unchanged. This change adds a concrete
composition boundary; it does not relocate every file or add speculative APIs.

## Evidence and verification

Prediction preference, bridge readiness and observed configuration responses are
different states. None proves that a candidate appeared in the App. The dashboard
keeps that result unknown. Integration diagnostics retain bounded, redacted
metadata, not conversation or image contents.
HTTP failures retain the original 20-entry metadata ring (`http_errors.recent`)
plus independent 20-entry inference/other and eight-entry image-MCP method rings.
Fixed categories distinguish inference, image-MCP HTTP 405, unmatched routes and
other failures without treating every 404/405 as harmless. Status, safe technical
code/type/parameter, method, allowlisted target, request IDs and numeric/enum
request options survive; body/query/prompt/tool/schema values do not. Optional
error prose requires `CCDX_HTTP_ERROR_DETAILS=1` at service creation, is redacted
and capped at 500 characters, and still needs review before sharing.
Original error responses are preserved. Per-request attempt timings retain only
the first and last two provider calls, not unbounded stream events. All data is
process-local and cleared on restart. The dashboard uses the independently
retained actionable HTTP errors rather than letting route noise erase them.
Model terminal diagnostics and HTTP counters retain their original meanings.

Tests cover module dependency direction, default-off behavior, concurrent writers,
proxy handshakes, TLS validation, streaming, history isolation and release lookup.
Performance measurements distinguish request preparation from model latency.
Actual loopback HTTP tests gate first-delta delivery before provider completion
and cancellation propagation for both native Responses and Chat translation.
Empty-stream diagnostics are additive scalar metadata, not a new retry policy.
Release reports describe a specific environment, not an SLA or a guarantee of
compatibility with every future client or corporate network policy.
CI runs Node 22.15 and 24 on Windows and macOS. The owned temporary-prefix
package smoke installs its 1.2.33 baseline (or an explicit local artifact), upgrades to the packed candidate and exercises
installed sharp without provider calls. It does not claim a live Codex UI test
or the GitHub updater's network installation; the Windows command chain has a
separate actual-process fixture. Direct runtime dependencies are exact versions;
the lockfile fixes CI transitives, not consumers' future transitive resolution.

### Source-level observations

Stream performance retains existing route totals and adds `by_route.<route>.by_provider`. Each source has started/active/finished counts, terminal totals, bounded model outcomes, request-to-first-output timing and preparation histograms. Source assignment is pinned once. There are at most 18 source labels (two built-ins and 16 APIs) plus `other`, and 32 model labels plus `other` per source. Unassigned finished requests use `unknown`; request IDs, accounts and URLs never become metric labels. Recent requests remain capped at 20. `runtime_usage.by_provider` has at most 18 labels plus `other`; unknown usage stays partial and persisted historical records retain their source.

`operation-error.mjs` distinguishes client cancellation, unspecified abort, timeout, network/TLS/proxy, authentication and access denial. HTTP 403 is not proof of credential expiry. Claude and Codex cancellations are informational; request-body timeouts use 408, upstream/idle timeouts 504, and local client cancellation diagnostics 499. Original upstream error status/body and protocol-specific stream bytes retain their existing path.

Byte-weighted request admission is not a simultaneous-stream limit. The 1.2.0 load replay exercises 16/64/128 small-body held streams, management responsiveness and downstream cancellation against 1.1.1. It does not establish a universal safe concurrency maximum. Existing defaults remain unchanged; see the release receipt for measured bounds.

## Installation and release delivery

`release-install.mjs` is a standalone helper with built-in static imports, shared by the updater
and no-Node bootstraps. It bounds downloads/decompression, verifies the exact
release package and checksum, backs up only this package/commands under an
exclusive lock, restores on failure and validates the version/sharp/broker.
The lock records its PID, timestamp and backup path; existing/legacy locks remain
explicit recovery barriers, while unrelated I/O failures keep their own cause.
It reuses the selected npm's bundled downloader with named proxy/CA/TLS/offline settings and no retries; no new download dependency is added. No network installation runs on ordinary startup or inference paths. Opted-in supervisor startup copies/verifies its current immutable runtime; its separate night scheduler is described below. `package-update.mjs` keeps
source choice, named npm-policy probes and fixed platform launch arguments;
verified filenames enter cmd.exe, while paths enter cwd. Private-runtime commands
are regenerated before committing a successful update. This provides error
rollback, not power-loss atomicity; failed restore retains a named backup/lock.

The platform scripts reuse Node/npm or verify pinned official Node 24.22.0 inside
a private prefix, without system installation or automatic Git/compiler setup.
They verify the standalone helper before execution. `scripts/release-artifacts.mjs`
builds one npm tarball plus checksummed platform scripts/helper; the npm publish
workflow and GitHub Release must deliver those same package bytes. WebUI source
selection and Auto Review remain under Codex; M365 lifecycle stays in source
management. CLI and UI share advertised effort filtering and preference writes.

## Independent appearance settings (1.2.2)

Web color (`green` / `klein` / `pink` / `mono`) and dark/light mode are browser-local presentation state applied before CSS in `dashboard/theme.js`. CSS semantic roles keep errors/warnings separate from theme accents. Terminal color (`green`, `klein`, `pink`, `mono`, `orange`) uses a distinct `terminal_color_theme` config field; animation continues to use `terminal_animation`. `terminal-colors.mjs` owns terminal color capability checks and escaping, while the existing layout runs on plain text first. The one-per-second coherent settings snapshot carries terminal color; animation frames introduce no additional settings reads. No inference, provider-routing or installer dependency is added.

The existing same-origin bounded settings action saves terminal color through the strict locked atomic writer, then applies it to the live console. Read or save failures retain existing files and controls revert to the last confirmed choice. Model-list check errors project only bounded public diagnostic fields; UI associates them with the selected source and its last successful snapshot. Existing generation checks, cancellation and deduplication prevent late results from replacing another source's data.

## Activity presentation and Messages timing (1.2.8)

The existing status payload projects `model_activity.active` from the three fixed inference route counters plus actual image-generation activity, never total HTTP activity or image MCP calls. It adds no history store, provider request or listener. `dashboard/activity.js` consumes this metadata through the existing refresh path, expires stale evidence after six seconds and pauses offscreen animation. Idle, active and unknown remain distinct; CSS owns six theme-colored dots and the idle-only halo. Terminal Cache hit reads the existing raw runtime aggregate rather than deriving a ratio from rounded display numbers.

The Claude gateway still relays original native SSE bytes. `stream-performance.mjs` classifies only nonempty text, thinking and tool-argument deltas as first output; empty and signature-only deltas remain transport metadata. Sparse/interleaved blocks are not reordered or translated. Existing provider generations, locked atomic settings writes, cancellation and route ownership remain the composition boundaries.

## Dashboard layout and information scopes (1.2.9)

The existing CSS grid reserves explicit header/body/footer tracks; the body owns spare space from the full-height sidebar. The header uses an opaque themed sticky surface, stable action slots and a deliberate compact toolbar. Scrollbar space is stable, with an always-scroll fallback for older engines. `console.js` owns route titles, scroll reset and main-content focus; refresh code does not navigate or reset scroll.

The eight existing views remain. `status.js` groups Overview clients by application using explicit selected-source evidence, retains all registered sources and projects separate Claude setup rows without inventing per-app Messages metrics. Account controls, catalog and access rows share the selected source in `ui.js`; source-management shortcuts browse without switching inference routes. Existing resource generations, cancellation, last-good snapshots and refresh cadence remain unchanged. Timestamps follow their own status/source/catalog/usage resources. Animation reads also check that Settings is visible.

HTML owns grouping: Codex buffer maintenance is separate from request performance, usage filters sit with the data they actually control, Requests prioritizes recent records and folds bounded technical fields into each row, and Checks & repairs owns runtime diagnostics. Settings owns preferences and updates. Request expansion is preserved by bounded request keys, and literal upstream values still use text nodes. Existing settings transactions, same-origin protections and confirmations remain in use; action failures target the affected controls. No framework, runtime dependency, endpoint, log scan, model call or installer policy is added.

## Catalog failure evidence and controls (1.2.10)

`providers/m365-catalog-diagnostic.mjs` classifies model-list HTTP failures using
fixed causes. The one known Entra-disabled message is recognized exactly; other
403 responses mean access denied, without inferring tenant-policy changes. Only
cause, HTTP status, check/last-success timestamps and a bounded service request ID
survive. The server body, credentials and account details are not retained in that
diagnostic. CLI and protected dashboard routes share its projection. Successful
refresh clears both source and composition failure state; delayed closed-source
results cannot clear a newer source's state. Discovery still sends no inference.

The eight WebUI views retain their scope, palettes, atom and circle status icons.
Selection uses an opaque theme fill and centered text, without a check or radio
mark; hover retains the selection. Native selects use square borders and retain a
visible square keyboard focus outline. Model names and metadata use readable text
roles rather than accent colors. The catalog's technical fields remain available
in per-model details. Usage trends and summaries are peer panels, still loaded on
demand. Saved/effective preference differences are shown only when relevant.


## Active request projection and restrained motion (1.2.11)

`stream-performance.mjs` remains the timing/outcome owner. Each metrics instance
retains at most 64 active snapshot closures; `finish` removes them idempotently.
The exact active total and omitted-detail count remain separate. Snapshots copy
only allowlisted application/source/model labels, request IDs, phase, elapsed
values and up to three attempt records. No body, headers, credentials or account
identity enters this projection. Existing recent records remain capped at 20.
`request-application.mjs` shares pure presentation-only hint normalization between
the adapter and Claude gateway. Hints are not authenticated identity or routing
inputs. Unmarked Claude traffic is not assigned to a specific Claude app.

The existing status snapshot carries this metadata; `dashboard/flow.js` adds no
poller, model call or routing controller. It groups up to 128 active detail rows
from the two metrics instances, initially shows at most 12 model groups, and
keeps counts outside name selections. Selection filters only active details;
source totals and finished records retain their scope. Rounded SVG path geometry
is rebuilt only for meaningful group/state/layout changes. CSS packets indicate
observed first output, waiting attempts are static, and idle has one breathing
lamp. Hidden views pause motion, reduced-motion stays static, and six seconds
without a fresh snapshot stops animation and labels retained data as last observed.
There is no perpetual JavaScript animation loop.

P50/P95 reuse existing fixed histograms. Estimates use the nearest-rank bucket
upper bound capped by the observed maximum; the open-ended bucket uses that
maximum. Empty histograms return null. Samples and the approximation label remain
visible; partial-output failures are included in first-output timing. No raw
sample list, new scoring, automatic failover or affinity policy is introduced.

The eight views keep their established palettes and controls. Page-opening
instructions are removed; operation scope, effect timing and privacy remain near
the relevant controls or in details. Tables retain header/interior separators;
the last row and following details use whitespace. Programmatic main-content
focus has no frame; interactive keyboard focus remains visible.


## Flow layout and client-hint correction (1.2.12)

`request-application.mjs` normalizes bounded scalar hints using an explicit map.
The map now recognizes `Codex Desktop`, observed in local desktop session metadata
and replayed through the bundled official app-server, as well as existing compact
names. A bounded, anchored, versioned Codex User-Agent is a fallback only. Generic
Codex evidence maps to a new `codex` family label; the existing `api` value remains
the unknown fallback. No raw hint is stored, and this classification does not
participate in routing, security, credentials or provider affinity.

Flow sources/status notes sit outside the name's layout height; both node columns
share the same header track. The hub shares that track offset. SVG anchors use
measured name-button centers, replacing fixed pixel assumptions. This keeps single
and shared concurrent routes straight across locale/wrapping changes. Branches
reuse the existing rounded-path geometry. Model counts are inline siblings of the
name, with reserved narrow-layout space; singleton counts and duplicate hub totals
are removed. Existing caps, freshness, pause/reduced-motion behavior, selection
scope and global summary semantics are unchanged.

The toolbar measures its longer localized on/off text with an inaccessible,
visually hidden grid sibling; only its visible label is localized dynamically.
Language controls have intrinsic width and no-wrap/no-shrink. Shared button-link
styling keeps the M365 navigation link semantically a link while matching the
existing GitHub shortcut; wording describes navigation rather than a silent check.
No new polling, framework, runtime dependency, setting or endpoint is introduced.

## Catalog transactions and default identity (1.2.20)

GitHub dashboard catalog reads use the existing `profile-model-runtime.mjs` single-flight through an injected refresh callback, rather than a second independent directory request. Successful publication updates the shared provider registry/endpoint cache, and the dashboard rereads connection candidates while preserving drafts. Explicit reads report refresh failures instead of presenting the last-good fallback as fresh success. Credential changes during a read reject publication; catalog browsing never synchronizes client files or changes selected deployments, defaults, grants or native authentication.

`api-catalog-refresh.mjs` owns bounded catalog I/O, same-source single-flight,
existing success/failure cooldowns, cancellation and deployment-version checks.
It receives source/config/commit callbacks; it does not write configuration or
client files. `connection-runtime.mjs` serializes only management changes and
result publication. A cancelled or obsolete read cannot publish; pinned source
instances drain through the existing reference tracking. The existing refresh
cycle remains the scheduler; no extra timer or background process is added.

Metadata commits merge only matching configured model IDs into the current
configuration and sync affected clients. Shared Claude capability projection
continues to consider both consumers and ownership journals. Metadata never
changes the selected model set, grants, default identity or native sign-in.

`client-model-plan.mjs` distinguishes an unspecified default from an unavailable
explicit default and indexes each source catalog once per compilation. Native
catalog projection does not depend on finding a default provider. Request
resolution still checks the selected source-qualified model before opening an
upstream call; no substitute model, cross-source fallback or auth recovery is
introduced. Builtin raw capability structures pass through normalization only;
validated manual fields belong to manual API configurations.

The existing dashboard connection controller owns one draft per client and
local operation feedback. Source browsing is one shared selection for management,
account and catalog. Presentation retains existing palettes, motion and native
controls; it adds no runtime UI dependency or protocol abstraction framework.

## Native Codex provider identity

GitHub-only managed bindings use the built-in OpenAI provider and a journal-owned
`openai_base_url`. Non-GitHub bindings retain the private keyed provider. Provider
identity is a client UI/auth boundary, not merely a transport setting; a native
app-server catalog does not establish the App's custom-provider rendering path.
The Codex reconciliation journal migrates v1 entries, records/restores root base
URLs, shares the startup configuration lock and protects user edits. Startup
leaves journal-owned base URLs to that writer. An unchanged inactive legacy
provider table remains available to sessions that recorded its ID; session files
and native authentication are not migrated or rewritten.

Codex exposes unambiguous upstream IDs and friendly metadata. Qualified defaults
and legacy route aliases stay internal and source-bound. Same-named deployments
remain distinct, with suffixes only where needed. Native replay covers a legacy
session, first model/list after cold/warm/old-cache starts, authMethod, effective
provider, model visibility and synthetic inference. Real App UI acceptance remains
separate from this RPC evidence.

A complete recognized qualified-ID model cache can be retired to a single private
backup during native reconciliation, before the config transaction commits.
Unknown/partial caches are not claimed. On config commit failure, the old cache
is restored only if the client has not created a new cache. This is a bounded
schema migration, not a periodic cache purge or a credential/session reset.


## Optional supervised nightly updates

`nightly-update.mjs` owns local-window/version eligibility, bounded public Release
lookup, policy-preserving staging and real runtime checks. It reuses
`release-install.mjs` package transactions, checksum checks and private command
writers. Rollback restores launcher symlinks by link text; it never follows a
relative symlink from its backup location. Completed rollback is idempotent and
cleanup errors do not conceal a successful restoration.

`service-supervisor.mjs` is loaded by normal `start` only after an explicit saved
opt-in and recognized/writable npm preflight. It keeps a foreground controller
and one active gateway worker, briefly warming a second candidate on an internal
loopback port. It stages beside the active immutable tree and serializes
one version transition. The controller carries no request-forwarding hot path.
Manual startup and all other commands retain their existing process model.
An unsupported copy/verification setup falls back to ordinary startup.

`service-worker.mjs` is the version-one private process protocol. It is enabled
only on an inherited IPC channel plus the worker marker, not by a WebUI request.
It exposes bounded inspect/quiesce/import/release/promote/resume/commit operations
to its parent and
forwards preference changes and notices; notices use the worker's existing
terminal sink. Source/model defaults, client files and sign-in fingerprints are
compared around the transition. Maintenance startup defers client synchronizers,
skips interactive login and client writes, checks selected GitHub discovery
without inference, and imports history before taking the original public port.
The old instance retains its provider state until the warmed replacement passes
validation; rollback resumes it rather than rebuilding a cold directory. GitHub
identity comparisons ignore refreshed verification timestamps.

`response-history.mjs` validates complete acyclic source-namespaced history and
its byte/entry budget before publication. `image-references.mjs` validates
provider-scoped image handles before importing its bounded LRU. `api-secrets.mjs` permits private transfer only of cached references still allowed
by the unchanged configuration. Those plaintext in-memory values remain confined
to inherited IPC; they are never written to a checkpoint, UI snapshot or log. The snapshot is consumed and released during
private handoff; no plaintext disk checkpoint or key-store rewrite is added.
`optional-routes.mjs` also counts pending optional requests so management/sign-in
work cannot be mistaken for an idle gateway. Ordinary shutdown drains HTTP
requests before closing providers. User stop/disconnect takes precedence over
updates; fallback is attempted once, not an unbounded restart loop.

The schema and failure limits, local schedule, install-owner checks and recovery
boundaries are normative in REFERENCE.md. Future patch releases accepted by this
channel must preserve private protocol v1 and the native client contracts.

## Incremental Web rendering and cold-start sharing

`dashboard/view-boundary.js` contains optional view failures without introducing
a plugin runtime. Only a fixed set of view methods is wrapped; a failed view
keeps the latest arguments per method for explicit retry. Shared refresh
generation checks and request cancellation remain in `refresh.js`.
`dashboard/flow.js` retains active detail rows by request ID. CSS alone rotates
the theme ring, with visibility/staleness and reduced-motion gates.

`dashboard.mjs` snapshots the static bundle lazily, checks its package version,
stamps HTML resource URLs, and computes byte-specific ETags once. Sensitive and
dynamic endpoints remain uncached. No shell/provider dependency is added to
rendering, and no content-bearing response is reused across credential scopes.

`api-secrets.mjs` joins concurrent reads of one reference and prevents late
reads from republishing after clear/set/remove. `providers/api.mjs` reuses the
existing cancellation-aware single-flight for transport initialization: one
waiter cannot abort another, while the last cancellation or provider closure
stops the shared setup. Existing native stream validation, byte admission,
connection reuse, bounded metrics/logging and pinned source semantics remain.


## Request evidence and optional counting

The existing AsyncLocalStorage request context owns safe requested model and
client evidence before model resolution. Claude keeps the outer HTTP context,
while its generation metrics stay separate from count operations. Selected
source/model, logical upstream calls and fixed resolution reasons reach HTTP
diagnostics; no alternate route is chosen to improve a diagnostic result.

`providers/api-token-count.mjs` is owned by one immutable manual-API
configuration. It joins bounded identical count operations with independent
waiter cancellation and keeps only bounded, short-lived 404 observations.
It does not implement a general circuit breaker, protocol translation,
inference fallback or tokenizer. Counts have their own diagnostics category;
generation failure totals do not include this auxiliary capability.

Flow rendering caches geometry until observed element size, topology, model
labels or language change. Phase-only updates retain SVG path/circle nodes.
Hidden pages stop the two-second status timer and refresh on visibility return;
foreground freshness and the existing CSS motion remain unchanged. Catalog
failure backoff is source-revision scoped and never holds the configuration
transaction during network work. Existing body serialization ownership is
retained: the ordinary manual Responses path serializes its final body once.


## Display evidence and native memory dependency

Manual upstream identity declarations live in `api-model-display` cache owned
by the connection runtime, separate from strict connection v2 configuration and
capability values. `apiCatalog` no longer stamps Unknown as a maker. Public API
catalog projection decorates display data; native model IDs, auth, source/key
identity and capability constraints are unchanged. Catalog publication guards
also guard display evidence; failures cannot introduce an empty successful
catalog or extra upstream permissions.

The token counter separates unknown capability coordination from identical
result sharing. The first real admitted count owns the capability operation.
Different inputs may consume a 404 observation, but never another input's
successful count. Waiter cancellation is independent. Known support restores
normal parallel counts; state is bounded and source/configuration owned.

`codex-memory-model` owns optional extraction-role evidence. It reads explicit
native config and uses a separate bounded read-only SQLite helper only when
needed. It reports configuration, observation or uncertainty; it never selects
a model for Codex. WebUI owns the dependency notice/confirmation. The runtime
continues to reject requests outside selected deployments, including native
background jobs. Optional evidence is excluded from service handoff business
contracts and never modifies the client files.

Request observations retain scalar output budgets, usage and fixed stop/network
fields across protocol adapters. Generation, explicit access restrictions,
capability absence and protocol discovery remain distinct. Dashed flow motion
uses CSS stroke offset on retained paths; model nodes share the same left edge.
Geometry and SVG identity reuse from 1.2.23 remain in place, with hidden/stale/
reduced-motion behavior and summary tables preserved.


## Model presentation and shared source impact (1.2.31)

`model-display.mjs` is a pure presentation fallback. `api-model-display.mjs` retains bounded upstream names beside maker declarations in the existing revision-bound, rebuildable cache. `providers/api.mjs` exposes that evidence to `client-model-plan.mjs`, which disambiguates presentation independently of route identity. Claude uses labelOverride for client aliases regardless of the default source. No connection-schema or routing-ID migration is introduced. Existing client-file ordering and manual ownership remain authoritative.

The connection snapshot's read-only source_impacts reports actual selected consumers, removed/remaining selection counts, and default-replacement needs. Both source-close validation and the WebUI use that result; the default source alone never represents every selected deployment. An optional impact_revision protects new WebUI confirmations while preserving existing programmatic command compatibility. Settings writes remain serialized and revision checked. Source identity changes also invalidate confirmation.

Unknown client capability adapters preserve existing shared settings and report their limitation. The presentation schema and protocol capability evidence do not share an enable gate. HTTP-200 error envelopes and native SSE errors feed the existing bounded diagnostics as model.error; transport bytes and retry policies remain unchanged.

Table disclosure metadata blocks use inline-size containment: their natural height remains, while long IDs, timestamps and diagnostics do not change the table columns' intrinsic widths. Rows with details stay top-aligned so their time/source/model text remains at its original vertical position. This shared rule covers request metadata, checks and nested capability details without adding fixed empty column space. The API capability row uses the same containment boundary. Global browser replay checks each disclosure's trigger/text x coordinate, peer-row text y position, column widths and horizontal scroll at opening, mid-animation, open and closed states.

`dashboard/disclosure.js` is optional progressive enhancement of native details/summary. It uses cancellable opacity/transform animations, CSS chevrons independent of translated DOM text, and no polling/height animation. Reduced motion and hidden documents finish immediately. A resource integration test covers every script/style referenced by the shell. Flow regression measures layout reads and DOM identity under elapsed-only updates; existing geometry caches, list limits and visibility gates remain the performance mechanism.


WebUI-only appearance remains browser-owned. The `mono` palette reuses existing
semantic CSS tokens and the light/dark toggle; it does not extend terminal or
service settings. Chinese font fallback is shared through the page's font-stack
CSS variable, without remote font I/O. Flow layout aligns application node right
edges and model node left edges; existing ResizeObserver/geometry caching and
visibility-gated dash animation retain their ownership.


### CLI state and management

`terminal-state.mjs` projects existing request/source/client evidence for the live
terminal and canonical CLI views. It does not own model selection, credentials,
provider health, files or requests. TUI snapshots stay on the one-second cadence;
animation updates only its final row. `model_activity` provides actual inference
and generation activity; tool discovery is not work. The core Codex startup writer
returns observed configured/preserved metadata, which the integration snapshot
exposes only as last-checked setup evidence. Managed binding setup keeps priority.

`cli-command-spec.mjs` defines canonical paths, validated options, nearby/deep help
and handler dispatch. `cli-management.mjs` formats bounded public
snapshots and orchestrates existing loopback actions with normal prompt/private-key
input. The CLI entry exits before service startup for these commands. The single
public grammar rejects removed command roots before startup. Shared feature
handlers keep their existing behavior. Saved configuration remains readable.

The full connection snapshot exposes a management capability and per-client
binding revision. CLI connection mutations require this capability; older running
services are not silently upgraded or mutated. Source authorization uses the same
source-impact revision as closing previews. A client access-only action retains
legacy source and deployment representation; it does not migrate a GitHub-only
binding or change Codex auth mode. Explicit one-shot client sync reuses serialized,
targeted ownership writers while retaining `auto_sync=false`. Shared Claude settings
retain existing peer/manual-support protections. Disabled, unbound APIs can be
removed; in-flight credential retirement uses the existing secret lifecycle.

CLI service-preference backups use the existing bounded validator, file lock and
atomic backup/config pair with a separate backup filename. WebUI's appearance-paired
backup and version-one format are unchanged. No new history store, daemon, client
restart controller, transport policy or production dependency is introduced.


### 1.3 scope and state orchestration

CCDX ships only for macOS and Windows (x64/ARM64). CI and complete-package builders use those four targets. The macOS bootstrap rejects unsupported systems before downloads. `ccdx` is the only package command; old CLI roots and aliases are removed without resetting accounts, keys, selected models or client-owned files.

Startup presentation classifies each formatted line independently. Normal checks are transient; mixed-message warnings and sign-in instructions remain visible. The live region labels the Web UI address and renders enabled sources once. `preserved` remains an internal configuration result and is displayed as `Unchanged`.

Source-catalog tables keep fixed column geometry while native disclosures expand, preventing metadata width from moving the disclosure control. The API editor places its capability panel below the selected model row. Neither path adds network reads or inference.

`connection-runtime.mjs` retains one serial mutation queue and its existing synchronization coalescer. Named preparation/selection handlers separate branch-specific validation/mutation from the shared credential-write, client-sync and retirement sequence. Codex sync, Claude preparation/writing and shared App/Code capability reconciliation have local boundaries. Desktop inspection remains at the existing await point; clients are not synchronized in parallel.

A full snapshot keeps a local map of compiled client plans, including reuse during source-impact projection. Public data remains cloned and contains the same revisions/route identifiers. No persistent or global cache is added. `updateAccessSettings` retains strict validation, the lock and original-byte v1 backup, then skips an atomic rewrite only when serialized bytes already match. Skipping a file write does not skip an explicit control action or client sync.

The CLI keeps only command/version/status fundamentals before its early command dispatch. Existing tool implementations are imported in their branches; startup composition loads afterward in its previous dependency order. Native account stores, source/key identity, model projections and image/prediction behavior are unchanged. The repository-only `docs/STATE_REFACTOR_PLAN.md` records included boundaries, local measurements and deferred work.

### Context observations

`context-metrics.mjs` owns a bounded, process-local numeric projection. After ordinary provider/conversation validation, request handlers observe only bounded explicit session/subagent metadata. A process-salted HMAC includes the pinned source profile; raw IDs, prompts and credentials never enter the view. Missing identity never falls back to prompt matching. The projection neither calls nor changes the conversation source guard.

`stream-performance.mjs` feeds one terminal record to this projection, separately from its unchanged ordinary status context shape. Existing Responses/Messages usage observations supply reported input and cached input; declared window observations retain unknowns. Compaction calls are separate from regular-input series. Per observer: 64 series, 64 input points and 16 compact events per series, plus 20 unassigned requests. Snapshot sorting detects overlapping requests outside the request path; it does not infer a linear branch from parallel work. No persistence or background task is introduced.

The optional read-only `/_ccdx/ui/context` endpoint reuses loopback/Host/dashboard-header checks and rejects a conflicting Origin. It combines independent Responses and Messages observer snapshots only when requested. `context.js` owns the Usage subview and consumes the existing refresh controller; hidden views issue no context reads. Ordinary status and TUI snapshots do not serialize the retained series. Existing usage/history, auth/config ownership, prediction and image paths retain their behavior.

Messages window observation belongs to `claude-gateway.mjs`, independently of the source. It consumes the resolved route's capability snapshot first; legacy paths reuse the model already selected for alias resolution or look up cached model metadata through the existing capability interpreter. An explicit unknown snapshot does not fall back to another catalog value. Provider-applied observations may still report the actual request policy, as before. Optional metadata failures do not reject inference, and count-token probes do not create context observations. No additional network call, body scan, global cache or client configuration write is introduced.

### Protected App keys and bounded control-plane work

`claude-client-config.mjs` recognizes the App's versioned encrypted representation only for an expected local key already owned by its journal. It does not decrypt, compare encrypted bytes with plaintext as authentication proof, adopt a foreign key or rewrite the encrypted field. Model operations continue through the existing per-field journal checks, preserving user edits and restore behavior. A transient `credential_state` accompanies the corresponding App sync observation, is cleared on the next targeted sync, and is shown only in the existing sync result. No storage schema or configuration template is added.

`boundedDiagnosticText` is a presentation-only boundary: a fixed input budget precedes terminal normalization/redaction, then UTF-16 surrogate boundaries are preserved at the existing output limits. `redactDiagnosticText` itself is unchanged because validators also use its exact result. Protocol bodies and retry classifiers do not consume the bounded diagnostic copy.

`usageSummaryVersion` retains its default settled-file semantics. Its explicit unsettled read mode exposes only an observed file identity for in-flight coalescing. Usage summary and analytics readers reuse the existing abort-aware singleflight and release completed flights; they do not add a persistent ledger/index. Filters and, for analytics, time zone/calendar date scope the key. Each caller still gets an isolated aggregate. HTTP usage readers forward cancellation to active-query waiters and avoid writes to cancelled responses. The underlying bounded scan may finish; it publishes no active-file cache entry.


### Live activity

`activity-events.mjs` owns a process-local presentation channel and bounded SSE subscribers. Request counters and Responses/Messages observers expose change subscriptions; they remain the sole owners of request state. The channel subscribes only while a TUI or browser is present, coalesces changes for 50 ms and takes one lightweight snapshot for the fan-out. It reads active/retained scalar metadata, outcomes and current-run usage, without provider/configuration snapshots, file reads, catalog refreshes or inference. Per-token activity publishes only its first phase transition.

`management-routes.mjs` protects `/_ccdx/activity` with loopback/Host checks and rejects conflicting Origin or cross-site browser requests. Management streams do not enter model counters, work/drain decisions or the inference data path. At most eight streams are retained. Write backpressure replaces one pending snapshot rather than accumulating events; a blocked heartbeat closes that stream. `closeHttpServer` closes owned activity streams before waiting for ordinary HTTP shutdown.

`dashboard/live.js` owns one EventSource, liveness and page/Auto refresh lifecycle. Each connection receives a current snapshot; there are no cursors, replay storage or cross-restart history claims. A 15-second heartbeat and 45-second silence deadline replace the six-second manual-snapshot expiry for push consumers. Healthy events update only activity/counters/request tables and visible context evidence. Animation frames and elapsed time stay local. `refresh.js` retains low-frequency diagnostic, account, model, retained usage and update resources. TUI consumes the same channel directly; static setup/preferences are sampled locally every ten seconds and existing callers without subscriptions keep their previous cadence.


### Compact dashboard spacing

`dashboard/ui.css` retains the existing color/type system and grid/navigation boundaries. Shared `--control-height` and `--inline-control-height` values align controls at 32/30 px, with 44 px coarse-pointer targets; multiline choice cards keep intrinsic height. Existing narrow-header rules still own reflow. Panel/header/table/form spacing is adjusted in its existing rules rather than adding a second layout mode. Request-flow geometry continues to measure actual anchors after resize and disclosure changes. Browser replays assert actual sizes and unchanged header anchors alongside bilingual themes, model details, drafts and reduced motion.

The Auto refresh button overlays its visible and width-measuring labels in one centered grid cell. Browser acceptance measures the visible text range against the button on both axes, including ON/OFF in both languages; the outer control height alone is not alignment evidence.

In 1.3.5, expected local GET/HEAD MCP discovery replies retain their HTTP counts
and a separate bounded probe history; they do not animate model activity. Unknown
paths and security failures remain inspectable. Source catalog details explain
client exclusions from current grants, interfaces, policy and selections. They
perform no inference or automatic model selection. Removing an owned Claude
source-only flag shares the existing configuration/journal rollback transaction.

Dashboard usage analytics keeps two aggregate checkpoints within 2 MiB. A passive
listener exists only while checkpoints are retained. The existing asynchronous
writer reports before/after file versions inside its rotation lock; only witnessed
non-rotating appends queue delta lines (at most 256 KiB per checkpoint). Queries
apply those records without rescanning history. Other-process writes, unknown
changes, rotation, incomplete tails, warnings and oversized results rebuild through
the original full scan. No persistent index, polling or per-token work is added.
### Local masking boundary

`local-privacy.mjs` owns explicit consent, per-request policy snapshots, a private placeholder seed and bounded shared detection metadata. It wraps provider calls after authorization/model resolution without changing the prepared request used by local history. Completed history records restore client-visible values while signed and encrypted state stays opaque. `privacy-transform.mjs` projects only supported text fields and restores complete reply events, including JSON-escaped tool arguments. It does not take ownership of credentials or select providers.

`privacy-model.mjs` owns verified, optional downloads and a stdio-only child process. The npm dependency graph is unchanged. Model files are revision/SHA256 pinned; the executable is verified against the fixed component Release's checksum manifest. The downloader reuses the selected npm's network policy. Startup warms only already-downloaded, explicitly enabled protection; opening Settings never downloads a model.

Disabled calls retain their original provider function and body. Enabled calls await a complete check. A frontend check deadline rejects without contacting the provider; shared native work is bounded and may populate the metadata cache for another waiter. Cancellation does not cancel another request's shared work. Native input, jobs, cache and reply buffers have finite budgets; no prompt or mapping database is introduced. The child inherits only required system environment fields, not API keys or sign-in tokens.

The Magpie-derived Go tokenizer/INT8 classifier is built for four macOS/Windows targets, with native CI inference on each target. macOS can use CoreML and otherwise falls back to CPU; Windows uses CPU. The model remains a separate download. The fixed component version and protocol are independent of a client's model ID and of future CCDX code-only updates.

Progress and readiness share the existing coalesced activity SSE. The settings controller only reads status while visible and uses a bounded-action fallback when event updates are absent. Main-page preference revisions are refreshed after masking choices change. Protected request details add replacement count and local-check duration; other request rows retain their current layout.

Claude passthrough now holds incomplete SSE frames and validates complete data before forwarding. Malformed tails do not precede the terminal error; valid final JSON without a newline remains deliverable. Capability restoration and replacement writes use the existing ownership journal in one transaction, preserving both files and ownership on failure.
