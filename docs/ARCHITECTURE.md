# Architecture boundaries

CCDX is one local Node service with client-specific protocol surfaces and isolated
upstream providers. GitHub is the default Codex provider; Microsoft 365 is optional.
Client integration, image tools and the dashboard are not a general plugin framework.

| Responsibility | Ownership | Boundary |
| --- | --- | --- |
| Core inference | `adapter.mjs`, Responses modules, model catalog, history | Codex wire contracts, streaming and recovery |
| Providers | `providers/github.mjs`, `providers/m365*.mjs` | Source-owned auth, discovery, routing, capabilities and transport |
| Provider composition | `provider-runtime.mjs`, `provider-registry.mjs`, `provider-settings.mjs` | Explicit selection, lifecycle, history namespaces and snapshots |
| Claude clients | `claude-gateway.mjs`, `claude-client-lifecycle.mjs`, `claude-client-config.mjs`, `claude-models.mjs` | Native Messages relay and field-owned reversible client setup |
| Client integration | `client-integration.mjs`, Codex config, native prediction | Client setup, optional start/stop, diagnostic snapshots |
| Optional images | Image provider, CLI setup, image MCP and skill | Opt-in API access and image delivery; failures do not block core startup |
| Management | CLI, dashboard, observability, package updates | Bounded metadata and explicit user actions |
| Shared foundations | Codex paths, file locks, atomic files, network routes | No dependency on inference or dashboard rendering |

## Composition and lifecycle

### Provider boundary

Each provider supplies its client, model registry, route plan, model/request policy
and compatibility opener. The existing GitHub implementation remains the default;
its Fast mapping, retries and recovery are not applied blindly to M365. Protocol
adaptation belongs to the client boundary. There is no generic intermediate message
format that would erase native Responses or Anthropic semantics.

`provider-registry.mjs` declares the bounded internal source metadata used by selection validation and dashboard source choices. It loads no external code; GitHub and M365 are the two production sources. Source-specific selection/model rules remain with composition. A third source is only a contract test fixture.

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

`providers/m365-network-diagnostic.mjs` is a small pure projection of fixed proxy failure codes, source and stage, shared by transport, provider state, protected dashboard routes and CLI. Raw error chains/settings never cross that boundary. M365 retains existing outer error categories; the source runtime forwards the bounded diagnostic, and existing bilingual renderers expose a readable explanation with technical details. Startup uses the same fixed English explanation. Refresh failures retain last-good catalogs and never change the selected provider; successful transport creation clears the setup diagnostic. No new service, storage, dependency, route fallback or provider retry is introduced.

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

Package installation is an explicit management operation in `package-update.mjs`,
not part of inference or optional client integration. Windows uses the system
command interpreter only for the fixed `npm.cmd` installer command; stable-tag
validation remains upstream of launch. macOS/Linux use direct npm argv. There
is no generic shell runner or package-manager framework, and npm's configured
registry/proxy environment remains owned by the user.
Readonly npm policy discovery is update-only and uses the same global context as
the installer, not an unrelated working project's `.npmrc`. It queries version,
`allow-remote` and registry only, never the complete credential-bearing config.
Default installer argv preserves the saved download policy. The boolean
`--allow-remote` opt-in adds one fixed permission argument only when supported;
it applies to that installation's entire dependency tree, not selected hosts.
Unknown support fails before an explicitly requested override. Installation
streams remain inherited; conditional failure guidance is not an assertion that
every nonzero exit is a policy error. There is no automatic retry or policy write.
The source lock retains exact versions/integrities without binding smol-toml to a
developer's corporate feed; omitted registry resolution is delegated to npm.
Readonly update preflight reports Node/npm, the running package and npm's selected
global target. A different target warns, but never changes PATH or prefix. Its
bounded npm probe is limited to explicit update and full doctor commands.
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

`native-prediction-protocol.mjs` owns bounded archive recognition only, independent
of certificates, networking and the CLI. It accepts multiple named hashed chunks
without assuming the first general-settings chunk is the implementation. Signature
and profile checks remain in the existing platform boundary.

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
The sidebar controller reads small process-local status snapshots every two seconds
while visible/automatic, and source/settings evidence every eight status ticks.
Catalog and retained-log reads retain their slower, view-scoped policy. Animation
frames still load once per page when opened.

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
CI runs Node 22.15 and 24 on Linux, Windows and macOS. The owned temporary-prefix
package smoke installs its 0.9.41 baseline (or an explicit local artifact), upgrades to the packed candidate and exercises
installed sharp without provider calls. It does not claim a live Codex UI test
or the GitHub updater's network installation; the Windows command chain has a
separate actual-process fixture. Direct runtime dependencies are exact versions;
the lockfile fixes CI transitives, not consumers' future transitive resolution.

### Source-level observations

Stream performance retains existing route totals and adds `by_route.<route>.by_provider`. Each source has started/active/finished counts, terminal totals, bounded model outcomes, request-to-first-output timing and preparation histograms. Source assignment is pinned once. There are at most 16 source labels plus `other`, and 32 model labels plus `other` per source. Unassigned finished requests use `unknown`; request IDs, accounts and URLs never become metric labels. Recent requests remain capped at 20. `runtime_usage.by_provider` has at most 16 labels plus `other`; unknown usage stays partial and persisted historical records retain their source.

`operation-error.mjs` distinguishes client cancellation, unspecified abort, timeout, network/TLS/proxy, authentication and access denial. HTTP 403 is not proof of credential expiry. Claude and Codex cancellations are informational; request-body timeouts use 408, upstream/idle timeouts 504, and local client cancellation diagnostics 499. Original upstream error status/body and protocol-specific stream bytes retain their existing path.

Byte-weighted request admission is not a simultaneous-stream limit. The 1.2.0 load replay exercises 16/64/128 small-body held streams, management responsiveness and downstream cancellation against 1.1.1. It does not establish a universal safe concurrency maximum. Existing defaults remain unchanged; see the release receipt for measured bounds.

## Installation and release delivery

`release-install.mjs` is a standalone helper with built-in static imports, shared by the updater
and no-Node bootstraps. It bounds downloads/decompression, verifies the exact
release package and checksum, backs up only this package/commands under an
exclusive lock, restores on failure and validates the version/sharp/broker.
It reuses the selected npm's bundled downloader with named proxy/CA/TLS/offline settings and no retries; no new download dependency is added. No installer work runs on startup or inference paths. `package-update.mjs` keeps
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

Web color (`green` / `klein` / `pink`) and dark/light mode are browser-local presentation state applied before CSS in `dashboard/theme.js`. CSS semantic roles keep errors/warnings separate from theme accents. Terminal color uses a distinct `terminal_color_theme` config field; animation continues to use `terminal_animation`. `terminal-colors.mjs` owns terminal color capability checks and escaping, while the existing layout runs on plain text first. The one-per-second coherent settings snapshot carries terminal color; animation frames introduce no additional settings reads. No inference, provider-routing or installer dependency is added.

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
