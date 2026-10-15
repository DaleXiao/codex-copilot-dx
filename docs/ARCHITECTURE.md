# Architecture boundaries

CCDX is one local Node service for Codex App. Client integration, image tools and
the dashboard are optional parts of that service, not a general plugin framework.

| Responsibility | Ownership | Boundary |
| --- | --- | --- |
| Core inference | `adapter.mjs`, Responses modules, model catalog, history | Copilot requests, streaming and recovery |
| Client integration | `client-integration.mjs`, Codex config, native prediction | Client setup, optional start/stop, diagnostic snapshots |
| Optional images | Image provider, CLI setup, image MCP and skill | Opt-in API access and image delivery; failures do not block core startup |
| Management | CLI, dashboard, observability, package updates | Bounded metadata and explicit user actions |
| Shared foundations | Codex paths, file locks, atomic files, network routes | No dependency on inference or dashboard rendering |

## Composition and lifecycle

The CLI composes the service. Client integration owns its `configure`, `start`,
`snapshot` and `close` operations. It does not forward inference requests or
render the dashboard. The adapter exposes integration snapshots and keeps
management/MCP routes separate from the Responses path.
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
Windows automatic-proxy support has one isolated native WinHTTP worker
(`windows-prediction-network.mjs` / `.cs`) for company routing, authentication and
TLS trust. Its private, credit-based pipes stream data without transcript files.
The App PAC delegates unrelated URLs to the company script; Node never executes
that script. This worker is not a shared inference/image network backend and is
not started for disabled predictions or static/direct configurations.
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

`dashboard/refresh.js` owns the browser-only read lifecycle: one visible-page
timer, per-group in-flight deduplication, attempt freshness, cancellation and
last-good snapshots. `ui.js` composes the controls and refresh resources;
`status.js` owns status/failure rendering, and `usage.js` owns usage rendering
and date selection. Their state stays page-local. Models, usage,
status/account and animation metadata remain independent resources; no timer
or data watcher is added to the Node service. Animation frames load once per
page when opened, and read refresh does not overwrite an unsaved choice.
`upstream-body.mjs` is the shared bounded response reader. The transport retains
its existing exports; live model lookup uses the same 8 MiB catalog limit as
core model discovery, without importing the request lifecycle or UI layer.
Overlapping live queries with the same credential fingerprint, home, fetch
implementation and lookup parameters share one in-flight lookup. A waiter can
cancel independently; the last cancellation aborts the lookup. Completed results
are not cached as live, and each waiter receives its own snapshot.

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
HTTP failures have a separate 20-entry metadata ring (`http_errors`): status,
safe technical code, model when observed, route, source and request IDs. Original
HTTP error bodies are returned unchanged but not saved in that ring. Model
terminal diagnostics and their counters retain their existing meaning. The
dashboard merges recent HTTP, model and request-timeline failures for display.

Tests cover module dependency direction, default-off behavior, concurrent writers,
proxy handshakes, TLS validation, streaming, history isolation and release lookup.
Performance measurements distinguish request preparation from model latency.
Actual loopback HTTP tests gate first-delta delivery before provider completion
and cancellation propagation for both native Responses and Chat translation.
Empty-stream diagnostics are additive scalar metadata, not a new retry policy.
Release reports describe a specific environment, not an SLA or a guarantee of
compatibility with every future client or corporate network policy.
CI runs Node 22.15 and 24 on Linux, Windows and macOS. The owned temporary-prefix
package smoke installs 0.9.31, upgrades to the packed candidate and exercises
installed sharp without provider calls. It does not claim a live Codex UI test
or the GitHub updater's network installation; the Windows command chain has a
separate actual-process fixture. Direct runtime dependencies are exact versions;
the lockfile fixes CI transitives, not consumers' future transitive resolution.
