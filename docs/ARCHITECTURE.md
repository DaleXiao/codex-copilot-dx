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

Native prediction has a separate loopback transport and an isolated HTTPS agent.
Only its two selected hosts use the App-specific route. Non-configuration requests
on those hosts are forwarded unchanged. The bridge does not replace Copilot or
image-provider networking, modify client program files, or install system trust.
Static upstream proxy routes and bypass rules are preserved. macOS dynamic
PAC/WPAD and static CIDR bypass rules are reported as unsupported, not discarded.
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
Windows bridge-port ownership and App launch-route checks also stay in this
optional boundary. Core inference keeps its existing service port and lifecycle.

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

## Dashboard reads

`dashboard/refresh.js` owns the browser-only read lifecycle: one visible-page
timer, per-group in-flight deduplication, attempt freshness, cancellation and
last-good snapshots. `ui.js` owns rendering and user selections. Models, usage,
status/account and animation metadata remain independent resources; no timer
or data watcher is added to the Node service. Animation frames load once per
page when opened, and read refresh does not overwrite an unsaved choice.
`upstream-body.mjs` is the shared bounded response reader. The transport retains
its existing exports; live model lookup uses the same 8 MiB catalog limit as
core model discovery, without importing the request lifecycle or UI layer.

## Configuration ownership

`CODEX_HOME` selects Codex configuration. App profile/trust paths have their own
selection and are not inferred from that directory. CCDX writers use a shared
per-file lock, reread current contents and preserve unrelated values. Locks do
not coordinate editors or other applications that ignore them. Read-only status
and doctor commands do not write configuration.

Core inference interfaces remain unchanged. This change adds a concrete
composition boundary; it does not relocate every file or add speculative APIs.

## Evidence and verification

Prediction preference, bridge readiness and observed configuration responses are
different states. None proves that a candidate appeared in the App. The dashboard
keeps that result unknown. Integration diagnostics retain bounded, redacted
metadata, not conversation or image contents.

Tests cover module dependency direction, default-off behavior, concurrent writers,
proxy handshakes, TLS validation, streaming, history isolation and release lookup.
Performance measurements distinguish request preparation from model latency.
Release reports describe a specific environment, not an SLA or a guarantee of
compatibility with every future client or corporate network policy.
