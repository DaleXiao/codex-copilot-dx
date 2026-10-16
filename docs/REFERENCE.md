# CCDX command, configuration and compatibility reference

Use Codex App with GPT models available to your **GitHub Copilot** account.

CCDX is a local compatibility adapter for Codex App. It configures Codex to use an OpenAI Responses API on loopback while GitHub authentication, model discovery, and inference stay backed by GitHub Copilot.

## How it works

### Retired prediction integration

The manual prediction MCP, automatic Stop hook and dashboard panel are removed.
CCDX does not install a prediction skill or replacement predictor. Startup disables
the old `suggestion.json` preference and removes only unchanged CCDX declarations
from the active `CODEX_HOME/config.toml` (or `~/.codex/config.toml`).
`CCDX_SUGGESTION_CONFIG` still identifies the legacy settings path for cleanup.
For an immediate cleanup without starting the adapter, run `ccdx suggestion off`.
The old `suggestion on` and `suggestion model` commands cannot re-enable it.

Modified, inline and profile-specific declarations are preserved. Cleanup failures
do not block the core adapter. Saved model preferences and old candidate files are
not deleted; they are inactive. Native Codex preference settings, hook trust records,
other hooks and the optional image MCP are untouched. Two inert compatibility
entrypoints prevent user-modified registrations from invoking a removed module:
the old Hook exits with an empty result, and the old MCP exposes no tools or panel.

### Optional native predictions

Native next-message predictions are **off by default** and use no MCP, Hook, skill,
panel, renderer injection, or client-program modification. This compatibility
feature uses the App's existing composer UI and the conversation's
selected model through CCDX. Suggestions are not sent automatically. Native
eligibility rules still apply; availability is not promised for every thread type.

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
This does not remove Git from the separate `ccdx update github` installation path.
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
ccdx prediction on
# Restart the running CCDX process, then launch Codex through ccdx.
ccdx
ccdx prediction status
# Repair only an already-enabled bridge in a compatible running CCDX service:
ccdx prediction fix

# To remove the optional setup, fully quit Codex first:
ccdx prediction off
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

`ccdx prediction fix` asks the running adapter for one explicit repair, without
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

### Configuration ownership

Core setup, image setup/guidance, config doctor, optional history compression and
legacy prediction cleanup resolve the same `CODEX_HOME/config.toml`; absent
`CODEX_HOME`, they use `~/.codex/config.toml`. An explicit function-level file path
still takes precedence for embedders. App-profile trust is a separate location
selected by `CODEX_ELECTRON_USER_DATA_PATH`, not by `CODEX_HOME`.

CCDX-owned config mutations share an owner-recorded cross-process lock, reread
under the lock, and retain existing atomic replacement/rollback checks. User
settings updates use a separate lock for their shared JSON file; prediction
on/off uses its own settings lock. Readers take no lock and write no lock file.
Contention fails with a retry message instead of stealing a live lock. Other
applications do not participate in these locks, so snapshot conflict checks still
apply; the locks do not claim a global filesystem transaction.

Since `0.9.33`, local settings/auth metadata reads are capped at 1 MiB, token
files at 64 KiB, and saved model catalog files at 9 MiB including metadata.
Oversized files remain untouched. Existing strict readers reject them; optional
cache readers treat them as unusable. Conversation files, HTTP request limits
and runtime history/cache limits are unchanged.
Full `ccdx doctor` reports npm's global installation target and readonly credential
permission evidence. Windows checks existing NTFS allow entries for other
identities, without changing ACLs. This is not a full effective-access audit;
unavailable checks warn. `doctor config` performs neither npm nor ACL probes.

### Core adapter

One in-process adapter listens on `127.0.0.1:2026` by default and exposes:

- `POST /v1/responses`
- `POST /v1/responses/compact`
- `GET /v1/models`

Responses-only models and compaction use Copilot's Responses transport directly. For requests routed through Chat Completions, CCDX converts the supported text, image, and function-tool subset and rejects incompatible message content rather than turning it into JSON text. Chat `length` and `content_filter` finish reasons become incomplete Responses in both streaming and non-streaming modes. Both streaming SSE and non-streaming responses are supported.

Chat conversion maps an explicitly supplied `reasoning.effort` to `reasoning_effort`.
Known effort values are checked against the existing model catalog when it advertises
an effort array; without that metadata, upstream validation remains authoritative.
No extra model lookup is made. Malformed function tools, forced undeclared functions,
unsupported tool-choice strings and unknown text formats receive a local compatibility
error instead of being dropped. Native Responses request fields are not changed by this check.

The adapter handles response history, encrypted reasoning state, function/custom tools, images, compaction, cancellation, retries, and usage metadata within the compatibility boundaries below. Routing prefers endpoint metadata from Copilot's live or cached catalog; when metadata is unavailable, a small built-in set identifies known Responses-only GPT models.

### Local compaction recovery

`0.9.28` adds bounded local recovery; the affected user's real chat still needs
verification. After the exact decoded HTTP 400 `input item does not belong
to this connection` rejection, or its HTTP-200/pre-output Responses failure
equivalent, a request containing encrypted compaction can attempt one verified
plaintext rebuild. Healthy encrypted histories remain unchanged.

The reader is loaded only after this failure. It requires a loopback peer and
Host, no browser Origin, and LAN mode disabled. It binds a UUID from native
`thread-id` / `client_metadata.thread_id`, or an exact UUID session/cache key
when primary metadata is absent. Conflicting primary IDs are rejected. It reads
only UUID-matching rollout filenames under the service's configured
`CODEX_HOME/sessions` and `archived_sessions`; it does not search by conversation
title, similarity, arbitrary request paths or another machine's filesystem.

Supported source files are complete JSONL logs and their `.jsonl.zst` variants,
decoded with Node's built-in Zstandard support. Header identity, the exact
compaction ciphertext, retained message order and function/custom-tool pairs
must match. A history-base reference, fork reference, rollback/reset marker,
missing plaintext tool content, malformed data or multiple matching sources
stops recovery. Referenced/split histories are not assembled by this recovery;
the caller must have a complete standalone source prefix.

The request replaces the rejected compaction with recorded plaintext before it,
retains current instructions and post-compaction input, and removes unavailable
reasoning. It does not decrypt or claim to reproduce hidden encrypted reasoning.
Normal preparation, image limits and upstream model/context limits still apply.
The reader has a five-second deadline, a 4,096-entry directory lookup bound and
a 16-candidate bound. Decoded reads and the rebuilt body are bounded by the
running adapter's decoded-body limit; history admission reservations cover
recovery preparation. Requests cannot retry after visible output has begun.

Overlapping equivalent recovery readers share in-flight source discovery/decoding,
with independent cancellation and independent restored requests. Every caller retains
its admission reservation; exclusive admission can serialize reads instead of sharing.
Successful plaintext is not retained after the flight settles. Up to 32 failure-code
records last two seconds, keyed by the exact source file identity/size/timestamps,
thread, compaction digest and byte limit. Directory discovery still runs; missing
sources, cancellation, deadlines and unstable snapshots are not cached. Source changes
invalidate reuse. No transcript index, watcher or healthy-request scan is added.

Neither the original rollout nor client configuration is rewritten. Recovery
diagnostics contain type/count/status metadata, not transcript text, ciphertext
or file paths. If verification fails, `ccdx_history_rebuild_required` includes
`recovery.local_status`; "not modified" does not imply CCDX has backed up complete
plaintext. Cross-machine/LAN recovery is intentionally unavailable. A full
plaintext replay can still exceed the upstream context window; this recovery
does not silently truncate it or add chunked re-compaction.

### Reasoning usage declaration

Native Responses success replies preserve `X-Reasoning-Included: true` only
when the upstream explicitly returns a case-insensitive literal `true`.
Missing, false or other values are not forwarded: current Codex treats header
presence as a declaration that historical reasoning is already counted.
CCDX does not infer that declaration from `output_tokens_details`, invent it,
add it to Chat-converted replies or HTTP/JSON failures, or change token totals.
Streaming headers describe the upstream declaration, not a guarantee that the
stream will later complete. This is compatibility metadata, not proof of lower
context use, faster inference or fewer compactions on every client.

### Fast and Standard modes

Codex can select Standard or Fast without changing CCDX configuration. When the client requests a model with `service_tier: "priority"`, CCDX uses its exact `-fast` model only when the live Copilot catalog advertises that variant as enabled, selectable, OpenAI-owned, and Responses-only. Standard mode continues to use the base model; CCDX does not invent Fast availability when the upstream catalog does not provide it. This retains the established `gpt-5.6-sol` / `gpt-5.6-sol-fast` mapping and applies the same exact-match rule to future models.

Codex Auto-review uses the hidden `codex-auto-review` model ID. CCDX maps it to Copilot's `gpt-6.1-sol` Responses model by default, independently of the interactive Fast/Standard selection, and logs both model IDs when the mapping is used. Without a saved reasoning override, an omitted Auto-review effort defaults to `low`; explicit client efforts are preserved. A saved override changes only review effort, preserving other reasoning fields. The review target and effort can be changed interactively without reinstalling or restarting a current CCDX adapter.

### GPT-6 model catalog

Codex App requests a versioned, capability-rich model catalog that is different from Copilot's raw model list. CCDX reads the complete catalog bundled with the installed Codex App and preserves every other model entry and capability. It exposes each managed GPT-6 entry only when Copilot advertises that exact model as enabled, selectable, OpenAI-owned, and Responses-capable.

When an installed 0.155.x catalog does not yet contain `gpt-6-sol` or `gpt-6-luna`, CCDX derives their client-compatible entries from that catalog's GPT-6 Astra schema and the published OpenAI Codex model definitions at commit `0a2eb4696c26ac33204bcd255721ab30220a4774`. When an installed 0.158+ catalog contains `gpt-6-sol` but not `gpt-6.1-sol`, CCDX derives only the missing 6.1 entry from that client's Sol schema and OpenAI Codex model identity/defaults at commit `ab84d71f5767e4a565ce81c2c426287cb48c7918`. Fallback reasoning controls are intersected with Copilot's advertised efforts; every other bundled entry retains its established behavior. A newer client-provided entry supplies its schema and future fields while CCDX still gates its visibility, speed tiers, and 6.1 Sol reasoning controls against Copilot.

CCDX exposes GPT-6 Standard paths and removes unverified speed-tier metadata. Existing GPT-6 bundled reasoning-effort options remain unchanged; 6.1 Sol is limited to efforts advertised by Copilot. Fast follows the exact upstream-variant rule above. Versioned model discovery matches the bundled catalog to the client's `client_version`, including the nested Codex CLI binary in current macOS App bundles, caches it by application binary identity, and reloads it after an App update. If a matching usable catalog cannot be loaded, the versioned models request returns `503`; an unversioned request returns the Copilot-style list.

`/v1/models` still attempts live discovery first. With a usable in-process catalog, it limits that upstream wait to 1.5 seconds (or a shorter configured upstream timeout) before falling back to last-known-good data. Without a catalog it retains the regular upstream timeout. Received HTTP `401`/`403` responses remain errors, not cached successes; fallback does not grant inference access. This does not change the explicitly live `ccdx models` command.

## Prerequisites

- A GitHub account with Copilot access to the desired models
- Node.js 22.15 or newer, for built-in Zstandard request decompression
- Codex App on macOS

## Install and start

```bash
npm install -g codex-copilot-dx@latest
ccdx
```

`ccdx` is the primary launcher. The old `codex-copilot-dx` executable remains temporarily as a compatibility shim: it prints a deprecation warning at most once every seven days in interactive terminals, runs `ccdx`, and remains silent in scripts. The warning timestamp is stored under `XDG_CACHE_HOME` or `~/.cache`; `doctor config` bypasses that warning cache to remain read-only. The alias will be removed in a future breaking release.

For a one-off run without a global install:

```bash
npm exec --yes --package=codex-copilot-dx@latest -- ccdx
```

On a normal launch, CCDX:

1. Prints the installed package version and checks GitHub's latest stable release in the background (not npm).
2. Reuses a compatible running adapter when available; otherwise it reuses a compatible local Copilot credential or starts GitHub Device Flow when authentication is required.
3. Loads a usable model cache or attempts a live refresh, then starts listening. A cache older than two hours refreshes in the background; a fresh cache can be used immediately. A failed refresh retains the last-known-good list when one is available.
4. Checks the startup-managed settings in `CODEX_HOME/config.toml` (default `~/.codex/config.toml`), including the local `/v1` endpoint.
5. Attempts to open Codex App on macOS unless `CCDX_AUTO_LAUNCH` disables it.

The `OPENAI_API_KEY=dummy` value used in the Codex shell environment is only a client-side placeholder. It is not a GitHub credential. CCDX exchanges the saved GitHub OAuth credential for short-lived Copilot service tokens internally.

On startup, CCDX also adds `context_management = true` under `[features]` when the key is missing, creating the section if needed. Existing values, including `false`, are preserved. Existing inline or dotted `features` declarations and nested context-management settings are left intact to avoid conflicting TOML definitions. This opts unconfigured users into Codex context management; support and behavior depend on the installed Codex version. A configuration that already matches is not rewritten.

Startup and adapter reuse also attempt an optional `local_thread_store_compression = true` default under `[features]`. CCDX probes installed macOS App runtimes with `features list`, using an empty temporary Codex directory, no inherited credentials/provider overrides, a 1.5-second timeout per runtime and a 128 KiB output limit. All discovered App readers must advertise a supported, disabled feature; missing/removed/unknown/default-on features or failed probes skip setup. Existing user settings (including `false`, inline/dotted forms and legacy profile overrides) are preserved without probing. Alternative feature-table declarations that cannot be safely extended are left intact. The shared config is reread after probing, and only this key can change. Temporary probe directories are removed; no user transcript is read or compressed by CCDX itself, and no upstream or npm lookup is added. Ready and core requests do not wait for this optional task; its failures never abort the main service. On a first launch, the App may read the config before this background task finishes; the setting is available on its next config load/restart.

This remains an experimental Codex storage feature. Current Codex compresses cold local transcript files, including shared histories, with Zstandard; every external reader of that Codex directory must also support the format. It does not reduce model context, request-body limits or CCDX's in-memory history cache, and CCDX does not promise faster inference. Existing third-party transcript readers are not detected. `ccdx doctor config` remains a config-only preview of essential startup settings; it does not spawn runtimes or predict this optional compatibility-gated default.

If a compatible adapter is already running, a later launch reuses it and checks the local Codex configuration. Reuse requires the same package version, protocol version, and required capabilities. After updating the package, stop the old adapter before starting the new version. Installing or updating the package alone does not restart the adapter or update Codex configuration.

### Codex configuration writes

Normal startup and reuse of an existing adapter check `CODEX_HOME/config.toml` (default `~/.codex/config.toml`) once, after startup prerequisites succeed. There is no file watcher or periodic configuration rewrite. Startup, image setup, config doctor, compression and legacy prediction cleanup share this path. CCDX does not edit project-level Codex files.

| Setting | Existing file | New file |
| --- | --- | --- |
| Top-level `openai_base_url` | Add or update to the adapter's `/v1` address | Set to the adapter address |
| `model_context_window` | Add `1000000` only when missing | `1000000` |
| `model_auto_compact_token_limit` | Add `900000` only when missing | `900000` |
| `[shell_environment_policy.set]` OpenAI URL/key | Update `OPENAI_BASE_URL` and set `OPENAI_API_KEY="dummy"` when this section is recognized; leave an absent section absent | Create the section and set both keys; set `shell_environment_policy.inherit="core"` |
| `[features]` `context_management` | Add `true` when missing; preserve explicit values and alternative declarations as described above | `true` |
| `[features]` `local_thread_store_compression` | Optional compatibility-gated default; preserve existing values, skip already-on/unsupported/unavailable runtimes | `true` only after a successful probe |
| `[mcp_servers.ccdx_image]` | Added in a marked CCDX-owned block only after `ccdx enable-image`; removed by `ccdx disable-image` | Absent by default |

The two token limits are fixed defaults, not detected model capabilities. Existing custom values are retained. Writes target the listed keys with format-preserving edits and atomic replacement; this is not a general TOML formatter. Quoted keys, quoted table headers, and explicit dotted shell-environment declarations are recognized; inline shell-environment tables are left intact. Startup and image configuration commands validate UTF-8/TOML and verify that unrelated settings retain their values before writing. An unsafe edit leaves the original file unchanged. Use `ccdx doctor config` to inspect parsed values and preview what this writer would do with the current file. No actual change means no file rewrite.

Interactive image setup rereads the shared config after prompts and network validation, so unrelated changes made during setup are preserved. It checks the snapshot again before committing and rejects conflicting image declarations. Identical configuration bytes are not replaced; private file permissions may still be corrected. These checks reduce lost-update risks but are not a filesystem-wide transaction with other applications that do not share a lock.

## Version 0.7.0 migration

CCDX 0.7.0 retires the former Claude App, Claude Code, Anthropic Messages API, isolated Claude account, and PM Studio patch integrations. Their setup, status, restore, profile, and routing commands are no longer supported.

If PM Studio is still patched by an older CCDX release, update or reinstall PM Studio to restore its official application bundle. CCDX 0.7.0 does not patch PM Studio and does not provide a restore workflow.

The upgrade intentionally does not delete or rewrite retired Claude or PM Studio configuration, historical patch backups, or isolated credentials created by older versions. Normal Codex configuration updates continue as documented above. Review and remove obsolete retired-integration state yourself only if you no longer need it.

## Commands

Run `ccdx <command> --help` for command-specific behavior and side-effect details.
Startup uses aligned status/project/result columns and a left-aligned Ready footer
with the Web UI URL and `ccdx help`. Ctrl+C is shown only for the foreground-owned
service, never a short-lived command reusing another service. A static, favicon-style
atom uses ANSI green and half-block characters only on interactive color terminals
at least 72 columns wide; narrow terminals, `NO_COLOR`, `TERM=dumb` and redirected
output keep a plain title. No new graphics/font/runtime dependency is installed.
Credentials found are not labeled online-authorized, cached model lists are not
labeled fresh upstream data, and image configuration is not a provider test.
Ready reports core readiness independently of optional prediction/image warnings.
Model refresh logs show counts; `ccdx models` retains the complete live list.
After Ready, background refresh uses the same two-column status/message layout as
other runtime logs. Status messages remove terminal controls and collapse newlines;
the static banner and multiline interactive prompts retain their own presentation.
VS Code compatibility-version details remain available in debug logging. Startup
does not wait for optional update/compression work or add online doctor/model probes.

### Live models

```bash
ccdx models
```

This performs a fresh, read-only GitHub Copilot model-directory lookup without starting the adapter, opening Device Flow, reading the local model cache, or consuming an inference request. It lists selectable GPT model IDs, providers, advertised APIs, and preview status. Catalog availability does not guarantee that a later inference request will avoid quota, rate-limit, or policy enforcement.

Concurrent identical live lookups share only the active request. Caller
cancellation is independent; results are not retained as a fresh catalog after
completion. The dashboard cancels its waiter when the read is abandoned.

Interactive terminals use aligned tables for `models`, `auth status`, and `usage`. Redirected or piped output retains the plain-text layout for scripts; use `--format table` or `--format plain` when a command offers an explicit format override.

`ccdx usage` and the dashboard Model Usage table show token cache hit rate for each model and the aggregate: recorded cached input tokens divided by recorded input tokens, weighted by token count rather than averaging request percentages. This describes the upstream prompt cache; the local history and image-transform caches are separate. Incomplete historical records do not hide a computable ratio: `~` marks a rate derived from incomplete counts. A rate is `—` when input tokens are zero, usable totals are missing, or token counts are invalid. Older logs may omit explicit zero cache counts; new Responses usage records retain reported zeros. CLI tables keep existing token columns on narrow terminals and show rates below the table when the extra column does not fit.

### Auto-review model

```bash
ccdx auto-review-model
```

The selector first queries the running adapter, including its last-known-good model list when live refresh is unavailable, then falls back to a local model cache no older than seven days. It offers model IDs that advertise a Responses endpoint and are not explicitly hidden from the model picker. This selection does not itself verify policy or inference access.

Enter a model number, then a reasoning-effort number. The second menu reuses the same model-directory lookup and lists only advertised efforts. GPT-6.1 Sol excludes `none` and `minimal`, even if upstream metadata incorrectly lists them. Enter keeps the current valid effort or selects `low` for a new selection when advertised; `0` follows the client (or `low` if the request omits effort). If effort metadata is absent, only `0` is offered. Enter `q` at either step to cancel without saving either choice.

Both choices are saved together in `~/.config/codex-copilot-dx/config.json`, or under `XDG_CONFIG_HOME` when set. Choosing `gpt-6.1-sol` clears the model override and restores the package default. A selected effort is saved as `auto_review_reasoning: { "model": "gpt-6.1-sol", "effort": "medium" }` and applies only when its model matches the effective review target. Existing saved models, including `gpt-5.5`, and environment model overrides retain their precedence; changing the model via an environment variable does not transfer another model's effort. Choose `0` to clear the effort override; its `null` marker remembers client-following so Enter preserves that choice next time. Users who do not configure effort retain their existing behavior. Adapters running 0.9.13 or newer read both settings on the next Auto-review request; older adapters must first be upgraded and restarted. No client patch, foreground-model change, Fast mapping, permission or approval-policy change is involved.

### Runtime caches

```bash
ccdx cache
ccdx cache --limit 128
ccdx cache --limit default
ccdx cache --clean
ccdx cache --clean --history
```

`ccdx cache` separates the shared in-memory Responses history from the rebuildable input-image transform cache. The history limit accepts 16–1024 MiB, is saved in the normal CCDX settings file, and applies immediately to a compatible running adapter. `CCDX_RESPONSE_HISTORY_MAX_BYTES` remains the higher-precedence environment override. Lowering the limit below current usage is rejected rather than evicting tasks silently. `ccdx cache -128` is a short alias for `--limit 128`; `-clean` aliases `--clean`.

Plain `--clean` clears only completed image transforms; the next matching request may recompute them. Adding `--history` also invalidates all process-local `previous_response_id` chains and can make a task's next continuation fail, so it requires interactive confirmation or `--yes`. Cleanup waits for active cache users to finish and never deletes Codex transcripts, generated image files, provider credentials, image edit handles, model catalogs, or usage/debug logs. A stopped or older adapter must be restarted before runtime cleanup; a saved limit applies on the next start.

### Request-body limits

```bash
ccdx limits
ccdx limits --decoded 256
ccdx limits -256
ccdx limits --decoded default
```

`ccdx limits` distinguishes the saved decoded request-body limit from the running adapter's active limit. The default is 128 MiB; the opt-in saved limit accepts 128–512 MiB. Changes take effect only after restarting the adapter, never restart it automatically, and do not clear conversations or caches. `CCDX_MAX_DECODED_BODY_BYTES` overrides the saved setting; unset it before changing the saved limit. The separate 64 MiB raw/compressed-body limit is not changed. Larger decoded requests can use substantially more process memory during JSON parsing and image preparation; raising this limit may enable a large thread to compact, but does not guarantee successful inference or compaction. Return to `default` after temporary use.

### Terminal animation

Choose the terminal activity animation interactively:

```bash
ccdx animation
```

The selector is ordered numerically:

1. Comet (default)
2. Twin
3. Shuttle
4. Chase
5. Mirror
6. Pulse
7. Stack — short light trails arrive, accumulate, then leave as one bundle
8. Relay — fixed nodes receive and pass a short light trail
9. Split — one incoming light trail divides into two outgoing trails

All nine rows preview their animations together while you enter a number to select one. The live previews keep each theme's original timing and leave the input cursor in place; selection ends them immediately. Small terminals, disabled animation, CI and dumb terminals retain static previews. Resizing or clearing the terminal pauses the live gallery so input stays usable. When the gallery cannot run, CCDX retains the selected animation's one-cycle confirmation when supported. The setting is saved in `~/.config/codex-copilot-dx/config.json`, or under `XDG_CONFIG_HOME` when set.

All nine animations use the same 20-column colon track and cyan/blue palette. They indicate activity, not completion percentage. Braille was removed in 0.7.7. A saved `terminal_animation: "braille"` falls back to Comet without rewriting the settings file; choosing another animation replaces it, and explicitly choosing Comet clears it. Other settings remain intact.

The selected theme is loaded once when a new adapter starts, so changing it does not restart or alter an adapter that is already running. Stop and start CCDX to apply the new theme. `CCDX_TERMINAL_ANIMATION=0` (also `false`, `no`, or `off`) remains the boolean gate that disables terminal animation regardless of the selected theme.

### Optional image generation

Image generation is disabled by default. Configure it interactively only when you want Codex App to receive the local CCDX image tool:

```bash
ccdx enable-image
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
ccdx image-status
ccdx disable-image
```

`image-status` never prints the API key and performs only a local, non-generating tool-readiness check. It lists generation and editing separately based on the local tools/list response; a configured model name alone does not prove editing is available. Disabling removes the stored provider credential, the CCDX-owned MCP block, and unmodified skill, reference, and helper files; user-modified files are preserved. Cached tool calls then fail closed. The Node helper creates a new file under the task's `output/imagegen` directory by default and reports its absolute path; it never overwrites an existing file or automatically repeats a failed generation. The image endpoint is contacted only by `enable-image` validation and by explicit `generate_image` or `edit_image` tool calls. Ordinary Responses, models, authentication, Fast, Auto-review, compaction, and image-input paths remain on their existing routes.

Generated image downloads must use public HTTPS addresses, do not follow redirects, are DNS-checked against private and reserved addresses, and are capped at 32 MiB. Well-known NAT64 `64:ff9b::/96` addresses apply the same IPv4 public/private rules to the embedded address, without rejecting legitimate public translations. DNS resolution and downloading share one deadline and respond to cancellation; a late DNS result cannot start a cancelled download. The local MCP route accepts calls only from the same device and permits at most two concurrent image operations. Host must name loopback, the actual local socket address (including equivalent IPv6/IPv4-mapped forms), or the explicitly configured bind hostname. Missing Host remains compatible with HTTP/1.0 and in-process clients. It requires `application/json` and rejects browser `Origin` headers; native Codex and Node clients do not send an Origin. The tool supports new-image generation at `1024x1024`, `1536x1024`, or `1024x1536`.

Image API generation/editing requests retain same-origin HTTPS redirects, with Fetch's existing POST/GET rules, a 20-hop limit and one shared timeout/cancellation signal. Cross-origin, HTTPS-to-HTTP, credential-bearing or invalid redirect targets are refused before another request is sent. Use the final API base URL when a service redirects to another origin. Redirect bodies are cancelled; generation failures are not automatically retried. The provider's returned image-download URLs still never follow redirects.

The Chat compatibility bridge ignores repeated complete tool names only when the name is declared and concatenation cannot be a fragment of another declared name. Overlapping fragments, delayed names and ambiguous/undeclared streams retain their existing assembly rules; argument deltas and tool-call IDs are not deduplicated. Native Responses routing and payloads are unchanged.

`ccdx usage` reports genuine log-read failures with the normal error line and exit code 1, without an uncaught exception dump. Missing logs remain a successful empty summary; malformed records are skipped with a warning rather than making usage unavailable.

With `qwen-image-3.0-pro` or `qwen-image-3.0` using either supported protocol, CCDX also exposes `edit_image`. Ask Codex to modify a specific CCDX-generated image; it passes that image's returned `image_id` and the edit instruction to the same configured provider. Each edit returns a new image and ID while preserving the original; omitting `size` retains the source's requested dimensions. The Qwen request contains the source image again on every edit, as required by its [single-turn image editing API](https://help.aliyun.com/zh/model-studio/qwen-image-generation-and-editing-api-reference).

Editing references are opaque IDs bound to the provider configuration, not paths or URLs. Source images up to 10 MiB are kept in a 64 MiB byte-bounded in-memory LRU. IDs expire on eviction, provider/credential changes, or adapter restart; restarting Codex App alone does not clear them. A missing or expired ID fails before upstream dispatch. This feature does not import arbitrary local images or provide masks, transparent output, or an `/images/edits` endpoint. Other providers retain their existing generation behavior. The helper accepts `--image-id` for the same edit operation; its stdout remains the saved absolute file path and stderr reports the new ID. Normal host approvals still apply, and failed edits are never replaced with an automatic new generation.

### Update

Choose a source interactively:

```bash
ccdx update
```

Or choose directly:

```bash
ccdx update npm
ccdx update github
```

In Windows PowerShell, use `ccdx.cmd update github` (or `ccdx.cmd update npm`)
when script policy blocks npm's `.ps1` shim. Since `0.9.31`, the updater runs
`npm.cmd` through the system `cmd.exe`, with AutoRun and delayed expansion
disabled, fixed installer arguments and a validated stable release tag.
It does not enable Node's generic `shell` option, change PowerShell policy,
rewrite npm configuration or add an external dependency. The caller's PATH,
registry, proxy, prefix/cache settings and terminal streams are preserved.
macOS/Linux retain direct `npm` execution and separate argument arrays.

Versions through `0.9.30` can fail with `spawn EINVAL` before the Windows
installer starts. To bootstrap this fix, run the installer directly:

```powershell
npm.cmd install -g --allow-git=all 'github:DaleXiao/codex-copilot-dx#v0.9.33'
ccdx.cmd version
```

This GitHub installation still requires Git on PATH. Stop/restart the running
adapter after installation; installation alone does not update a running process.
Installer errors and nonzero exits fail the update without a success message or
automatic retry. Missing Git, blocked dependency downloads or npm cache-only
settings remain npm/environment errors, not fixed by changing the launcher.

After a zero installer exit, CCDX reads bounded metadata from npm's selected global
target and verifies the package name and stable version. GitHub requires the exact
selected release version. A missing/mismatched target fails verification without
retrying installation; if the global target could not be discovered, the command
explicitly reports that the installed version is unverified rather than announcing
an update. This check neither changes PATH/prefix/registry nor restarts a running
adapter, and it does not verify package-file integrity or npm's current latest tag.

Normal startup checks the official GitHub `releases/latest` web endpoint once in
the background, without accessing the npm registry or REST API. The anonymous
check requires no PAT or Copilot credentials, has a two-second deadline, validates
only the redirect header, cancels the response body without reading HTML, and
silently skips errors. Redirects must use HTTPS, the exact GitHub repository and
a stable version tag with no credentials, query or fragment. It never follows
the redirect, retries, polls, installs or restarts. On adapter reuse, Ready is
displayed before waiting for any remaining check budget.

`ccdx update gh` is accepted as shorthand for the GitHub source. The npm source installs `codex-copilot-dx@latest` through the registry already configured for npm, including a company mirror. The GitHub source queries the latest stable published Release (ten-second deadline), validates its version tag, and installs that exact tag from `DaleXiao/codex-copilot-dx`, not `main`. Lookup failure stops before installation, without an npm fallback. It opts in to Git fetching only for that command and does not change npm's persistent `allow-git` setting.

GitHub is the package source, not a replacement for the npm installer. Dependencies such as `sharp` may still need the configured npm registry during an explicit update; use a company-approved mirror/cache where required. GitHub updates do not promise an entirely registry-free installation.

Since `0.9.38`, update reads the npm version and named global `allow-remote` and
registry settings using bounded probes. It never reads the full configuration or
prints registry credentials. The global context matches `npm install --global`;
an unrelated project's `.npmrc` cannot silently grant update permission. Old npm
versions without this restriction do not receive an unsupported option. Failed
policy discovery does not block an ordinary installation; explicitly requesting
an override with unknown support fails before installation.

npm 12 normally sets `allow-remote=none`. A company registry may return a tarball
URL on a different origin/path, which can trigger `EALLOWREMOTE` even for a named
dependency such as sharp. The default update does not weaken this policy. When
the installation fails under a restrictive policy, CCDX gives conditional guidance
to check npm's actual error; it does not label every failure a remote-policy error.

Only if permitted by company policy and you trust the package/dependency tree,
grant URL downloads for one explicit update:

```sh
ccdx update github --allow-remote
# Or, for the configured npm registry:
ccdx update npm --allow-remote
```

The option permits URL dependencies throughout that one installation, including
transitive dependencies. It is **not** an allowlist for one registry or tarball
host. It neither changes `.npmrc`/registry/proxy/prefix nor automatically retries
the failed install. npm still enforces package integrity and its other policies;
this is not permission to run every package script. Windows uses the same fixed
system `cmd.exe` launch; use `ccdx.cmd` if PowerShell blocks `.ps1` shims.

An older CCDX executable cannot gain this option before it is upgraded. To
bootstrap `0.9.38` from a version that fails with `EALLOWREMOTE`, the equivalent
explicit per-install command is, only with the same policy/trust approval:

```sh
npm install -g --allow-git=all --allow-remote=all 'github:DaleXiao/codex-copilot-dx#v0.9.38'
# Windows PowerShell: use npm.cmd instead of npm.
```

Check `ccdx version`, then restart CCDX. This does not guarantee access through
every company mirror: authentication, offline/cache-only rules, unsynchronized
packages and administrator-enforced policies still apply. If URL permission
cannot be granted, the registry must expose compatible allowed tarball URLs;
CCDX does not bypass that boundary. The source lock pins versions and integrity
without a developer-specific corporate smol-toml URL.

If a configured npm mirror has not synchronized the current release yet, use the GitHub source. A running adapter keeps its loaded version until it is stopped and restarted.

## Diagnostics

`ccdx doctor` is read-only by default and makes no inference request. It checks
local credentials/configuration, Node/platform, installation target, Windows
command launchers, enabled optional feature settings and the running adapter.
Disabled image/prediction features do not trigger provider or routing setup.
`--online` checks GitHub/Copilot access and a nonempty model directory; `--compat`
explicitly consumes model usage and requires completed Responses/SSE, not just
HTTP 200. Probe bodies are bounded to 4 MiB.

`ccdx doctor --fix` makes one repair attempt per supported area and verifies its
result: exact owned Windows command shims, startup-managed Codex settings, a
verified existing GitHub credential when none is saved, and the already-enabled
prediction bridge through its existing management API. Credential recovery can
contact GitHub without `--online`, but never starts Device Flow. Existing tokens,
user-modified/invalid configuration, unrelated MCPs/hooks and company routing or
security policy are not replaced. Existing changed config is transactionally
backed up to `config.toml.ccdx-doctor.bak` (the latest repair backup only). Repairs
do not install optional image tools, enable prediction, renew certificates or
force-restart Apps. A required normal App/service restart remains an explicit
partial result. Partial repairs exit 1; no automatic retry loop is added.

`ccdx doctor --json` emits one redacted JSON report; combine with `--fix` to
include `before_checks` and final per-operation repair results. Inspect these
results rather than equating a configured bridge with a visible gray suggestion.

Windows adds no install-time lifecycle script, so npm 12's script-approval policy
is not expanded. In restricted PowerShell, install with `npm.cmd`, then first run
`ccdx.cmd` or `ccdx.cmd doctor --fix`. Startup recognizes only the exact npm
PowerShell shims for the two CCDX commands, checks their matching `.cmd` targets
and package identity, then removes those `.ps1` shims. Subsequent calls can use
bare `ccdx` without changing policy or profiles. The updater applies the same
check only after verifying its installed target/version. Customized, symlinked,
unexpected or unreadable shims are preserved; optional setup failures do not
block core startup or turn a verified update into failure. Direct npm reinstalls
can recreate the shims; a first `.cmd` invocation repairs them again. Read-only
commands such as version/help/status do not repair them. Aliases/functions and
another installation earlier in PATH can still override resolution. npm's own
`.ps1` shim is untouched, so `npm.cmd` may still be needed. macOS/Linux and source
checkouts are no-ops.

`ccdx status` and the dashboard show the sample count beside each timing. First
output is observed at the gateway from generated deltas, hidden-reasoning/tool
announcements or content snapshots; a runtime-only result is marked separately.
Empty message/envelope frames, client tool results and compaction are excluded.
`first_output_sources` and each recent request's `first_output_source` describe
that evidence, not internal model decode or prefill timing. First output is
displayed in ms, and output speed in token/s. The additive
`output_tokens_per_second` metric divides the sum of reported output-token
intervals (`output_tokens - 1`) by their summed first-output-to-finish durations.
It is a time-weighted per-request estimate, not the inverse of average TPOT, an
unweighted average of request speeds, or concurrent system throughput. At least
two integral output tokens and a positive duration are required; missing usage
is unknown, not zero speed. The existing TPOT histogram remains unchanged for
API consumers, including its partial-failure samples. Both estimates can
include hosted-tool and downstream delays. The new
timing classifier does not change stream forwarding or the existing output
commitment that gates compatibility retries.

The adapted Codex model catalog preserves valid multi-agent reasoning mappings.
Only a mapping no longer supported by the final advertised effort options is
repaired to the last available non-Ultra effort; no model switch or forced
highest-effort policy is introduced. Client-provided defaults, option order,
instructions and multi-agent version stay intact.

CI additionally provisions the latest official Codex on its runner and uses an
isolated app-server to verify configuration, its model list and synthetic direct
and proxied Responses message delivery. It logs the tested runtime version,
does not skip installed-version mismatches and does not install clients on user
machines or use live credentials/models.

`ccdx doctor` also inspects installed macOS App version metadata and running
Codex/ChatGPT App executable identities, without reading command arguments,
changing client files or killing processes. It shows the running adapter version,
upstream model-directory source, and the last client-version/bundled-directory
match observed by that adapter. These are observations, not proof of the App's
internal model cache. Fully quit the named App with Command-Q before reopening;
closing its window alone may leave its App server running. `doctor config` stays
configuration-only, with no process inspection or adapter request.

The default streaming path sends small downstream SSE comments after 15 seconds
of silence only once valid stream headers have been sent. Comments do not count
as model output/TTFT, extend upstream/idle deadlines, start another upstream call,
or release a held compatibility-retry prelude. They stop on completion, failure
or cancellation and are skipped while the downstream is backpressured. A valid
JSON reply to a streaming request is still not silently converted to SSE.

### Local dashboard

After starting `ccdx`, open [http://127.0.0.1:2026/](http://127.0.0.1:2026/) in a browser. If `ADAPTER_PORT` is customized, use that port instead. The dashboard shares the existing adapter listener; CCDX does not open a browser automatically or start another service. The page and its assets require both a loopback connection and a loopback Host header, even when LAN binding is enabled.

The dashboard loads local status, a live GitHub Copilot model directory, and a summary of local usage metadata once when opened. The top Refresh updates status/account and expanded data groups; model and usage sections retain their own Refresh controls. Auto refresh is on by default, saved only in this browser, and updates status/account plus expanded groups every 30 minutes while the page is visible. Opening a data section updates its group unless it was attempted within 30 seconds. Hidden pages pause; returning after 30 minutes catches up once, without replaying missed intervals. Turning automatic updates off retains manual and open-section refresh. No server background task is added. In-flight reads are shared per group; failures retain the prior snapshot and success timestamp. Unchanged model rows and charts are retained rather than rebuilt. The appearance button switches between the default dark terminal theme (sun icon) and a light theme (moon icon); the choice is stored only in that browser. The Requests card shows the running adapter's active raw and decoded per-request body limits, not request-body usage; Local History shows its in-memory Responses history use and active limit. Limit changes remain CLI-only (`ccdx limits` and `ccdx cache`). The live model table uses the same fresh account validation and selectable GPT filtering as `ccdx models`, never labels cached fallback data as online, and makes no inference request. A catalog listing does not guarantee inference access. The Model Usage table combines the current and rotated local usage logs, shows totals and up to 100 model rows, and contains no prompt, response body, or credential fields. The animation selector previews the existing themes and saves through the same settings writer as `ccdx animation`; changes take effect on the next adapter start, and `CCDX_TERMINAL_ANIMATION=off` still disables terminal motion. Dashboard data requests require a custom header that cross-site simple requests cannot send; animation writes also require a matching same-origin `Origin`. The dashboard does not initialize the optional image handler. The overview's known-model count is the adapter's current in-memory catalog, not the live table. A missing image-generation status does not prove the feature is disabled: use `ccdx image-status` to check setup. Recent upstream error prose may contain sensitive details, so review the page before sharing screenshots.

The dashboard labels the upstream token cache hit metric **Reuse Rate** and cached input **Reused Input**, separate from **Local History**. Chinese uses short functional names such as “对话暂存”, “重用输入” and “重用比例”. English and Chinese preserve model IDs, commands, units, HTTP status codes and raw diagnostic values. Animation display names translate in place; theme IDs and CLI parameters do not change.

The transparent, single-color atom-orbit favicon follows the dashboard's saved light/dark choice without a separate network request.

The saved GitHub Copilot account appears immediately to the left of the Status updated time. It uses the same local credentials and fingerprint-bound identity metadata as `ccdx auth status`, with username (or numeric ID fallback) and a `SAVED` label; this is not an online entitlement check. Missing, invalid, unidentified, or unreadable credentials are shown explicitly. The account read runs on page load, top Refresh and visible-page automatic updates, independently of adapter status and without upstream authentication calls. Its timestamp is in the account tooltip; failed updates retain the prior account and explicitly label the failure. Its loopback-only, custom-header-protected API exposes no token, fingerprint, credential path, or raw metadata. The general status endpoint retains its existing identity-free contract.

Account names containing underscores are supported, including `dingxiao_microsoft`. A numeric ID is a fallback, not a replacement for an available, safely displayable username; the existing length bounds and credential-shaped text suppression still apply.

The language button immediately right of the appearance button switches between English and Simplified Chinese. English remains the default; the choice is saved only in the current browser, separately from light/dark mode. Switching translates the existing page in place: it does not fetch API data, rebuild charts, change selected filters, discard unsaved animation choices, or reset expanded failure details. Static labels, live status text, chart tooltips and accessibility labels follow the selected language. Model IDs, account names, dates, numeric values and upstream diagnostic prose stay unchanged; copied diagnostic fields retain their original names and values. The local translation asset adds no dependency, external service, polling or inference-path work.

Usage Trends is collapsed by default. Opening it adds daily input/output token bars (7/30/90 days) and a 365-day calendar of recorded usage calls or tokens, grouped in the browser's time zone. Cache-read tokens are already part of input and are not added again. Model and range filters use the current snapshot without additional requests; selecting a day shows its filtered model totals in the Model Usage table, and Show all restores the original table. Analytics shares the existing current/rotated-log scan and exposes only bounded metadata (365 days, up to 100 model filters). Days before retained history are hatched, not presented as zero; the oldest retained day may be partial. Counts describe retained usage records, not messages, session time, or all HTTP requests. Open-section, manual and visible-page automatic refresh update the snapshot. Analytics are requested only while expanded inside the open usage section or while a day filter needs them. Filters and selected dates survive refresh; a closed unfiltered chart reuses its displayed data until reopened. There is no server background collection.

Terminal Animation is collapsed at the bottom of the page, with an Animation shortcut in the header. Preview frames load only when opened; closing it, hiding the page, or requesting reduced motion stops the preview timer. Unsaved choices survive folding and reopening. Recent response failures expand to diagnostic fields (time, model, code, message, response/request IDs, and retry policy) with a Copy details control. The view combines the last 10 retained `response.failed` events with failures from the 20 most recently finished Responses/compact requests, showing at most 10 entries. Matching local request IDs attach the final outcome and timing metadata, so a recovered event can show `completed`; an uncorrelated retry attempt does not prove recovery. Transport failures and incomplete/cancelled requests can appear without a `response.failed` event. These are bounded runtime observations, not complete session histories. Diagnostic prose is redacted by the existing recorder but can still contain sensitive context: review before copying or sharing.

Inspect only the local Codex configuration:

```bash
ccdx doctor config
```

This command reads `~/.codex/config.toml` and checks UTF-8/TOML syntax, correctly scoped CCDX-managed URL/environment settings, positive integer context limits, their relative ordering, and `features.context_management`. Explicit `false` is valid. A missing optional shell environment section is valid for an existing file. Structured context-management settings are retained and reported as unverified for the installed Codex version.

It also runs the existing startup writer in memory and lists the managed keys that would change. A missing file produces a creation preview. A preview that yields invalid TOML or changes unowned settings is reported as an error rather than applied. No files are written, including debug logs; it does not read credentials, contact the adapter or upstream, start Device Flow, or open Codex App. It uses `ADAPTER_HOST` and `ADAPTER_PORT` for the expected URL. Unrelated startup/probe timeout settings do not affect this config-only command.

The syntax check uses a TOML 1.1 parser and validates only the listed managed fields, not the full installed Codex schema. It does not merge project files, profiles, environment overrides, or command-line overrides into an effective Codex configuration. Syntax errors report line/column without source snippets; configured URL and key values are not printed. The command accepts no `--online`, `--compat`, or write/fix options.

For the broader credential/configuration/adapter diagnostic:

```bash
ccdx doctor
```

The ordinary doctor reuses the same configuration checks, inspects the saved GitHub credential, and probes the local adapter. It does not start the adapter or modify credentials or Codex configuration; when `CCDX_LOG_PATH` is set, this broader command can write its diagnostics to that log. Both doctor modes exit `1` when any check is an error, and `0` for OK/warning-only results, including missing configuration or an explicit feature opt-out. Unsupported arguments or invalid relevant CLI options exit `2`.

To verify the saved GitHub token, Copilot entitlement, and live models endpoint without starting Device Flow or changing the credential:

```bash
ccdx doctor --online
```

To exercise the protocol through an already-running adapter:

```bash
ccdx doctor --compat
```

The compatibility doctor sends a few minimal Copilot requests covering Auto-review, native Responses, streaming history, and compaction. It consumes a small amount of Copilot usage, never starts the adapter or Device Flow, and does not change client configuration. Combine it with `--online` when both checks are needed.

For a concise summary of the running adapter:

```bash
ccdx status
```

For the complete machine-readable status payload:

```bash
curl -s http://127.0.0.1:2026/_ccdx/status | jq
```

The status endpoint is restricted to the socket's real loopback address even when LAN binding is explicitly enabled. It reports fixed-size HTTP request counters separately from bounded `completed` / `incomplete` / `failed` / `cancelled` response outcomes by model and origin, plus bounded incomplete-reason counts, TTFT/TPOT histograms, admission pressure, memory use, response-history size/tree concentration/lookup misses, image queue/cache and adaptive-history state, model-cache counts, token expiry state, and the ten most recent upstream `response.failed` diagnostics retained by the running process. HTTP errors without a model terminal remain "without terminal" and retain their known origin; they are not counted as model failures. History eviction markers are not failed-request counts; `ccdx status` warns near the cache limit without deleting or compressing history. Failure diagnostics include the event type, model, error code/message, response/request IDs when supplied upstream, and retry outcome. Common credential forms, long opaque encrypted values, and explicitly labelled input/prompt/tool-content echoes are redacted. They are cleared when the adapter restarts. Whole request/response bodies, credential fields, and account profiles are not archived in status. Explicit HTTP diagnostic mode can retain a bounded error excerpt; see HTTP error diagnostics below. Arbitrary upstream prose cannot be guaranteed free of sensitive content; review diagnostics before sharing them.

`stream_performance.by_route.*.empty_stream_completions` counts completed streams
with no observed output and an explicit zero output-token count. The recent request's
`empty_stream_completion` flag records the same condition. Missing usage is not zero;
non-streaming replies and observed tool/refusal output are excluded. This diagnostic
does not change completion status, trigger a retry or reject legitimate empty replies.

`image_mcp` has its own HTTP route counter. After the image handler has been used, `image_generation` separately reports active, succeeded, failed, busy, cancelled, and chat-file delivery-failure counts, including tool errors returned with HTTP 200. A delivery failure can accompany a successful generation; it never causes another generation. Before handler initialization this field is `null`, meaning not observed, not necessarily disabled. Status never initializes that handler, reads its provider credential, installs guidance, or probes the provider. Input-image optimization metrics remain separate. `logging` reports pending records/bytes, queue caps, overflow drops, and write failures for usage and enabled debug-file logging.

`stream_performance.by_route` also reports `request_ttft_ms`, measured from adapter entry to the first observed output delta, including local preparation. The existing `ttft_ms` continues to start at upstream dispatch. Neither timestamp means the client has drained or displayed the output. `preparation_ms` contains bounded histograms for admission (including history reservations), body reading/decompression/JSON parsing, history materialization/compact preparation, image optimization, and request serialization. Each sample measures one operation, including failed operations; retries can add samples. These are diagnostic intervals rather than a complete breakdown of request time: body reading includes internal decoded-body admission waits; authentication, routing, and other preparation are not individually timed. Non-streaming requests contribute preparation samples without inventing a first-token measurement.

`stream_performance.recent_requests` retains at most 20 finished Responses/compact requests. Each entry contains a CCDX-owned request ID, start timestamp, bounded model/route labels, HTTP status, final model outcome, known error origin, last observed phase and provider-call count. `timings_ms` includes cumulative preparation durations and offsets from adapter entry for the first upstream dispatch, latest upstream headers, first output, latest observed upstream activity, terminal and finish. Null means not observed, not zero. Stage durations can overlap and should not be added into a total. Provider-call counts include compatibility attempts but exclude OAuth exchanges and low-level connection retries. Streams update a single activity timestamp per read; no content, headers, opaque state or unbounded event list is retained. Entries are process-local and reset on restart; normal status refresh reads them without new upstream calls or background polling.

`http_errors` separately counts HTTP failures on tracked API routes and retains
the latest 20. Entries contain HTTP status, technical code when safe, observed
model, route/source and request IDs; the message is a fixed local explanation.
They never retain the original body, prompt, URL query or headers. Original
errors are still returned unchanged. Management/dashboard reads are excluded.
The recent-error panel merges these entries with model failures and request
timelines, retaining at most ten visible items. HTTP counts do not change model
terminal counts; unknown sources/models remain unknown.

Every API response includes a safe `X-Request-Id` for correlation. To include the same ID in related terminal and file log lines, start with:

```bash
ccdx --show-request-id
```

### Authentication recovery

The dashboard's collapsed **RECENT REQUESTS** section reuses the same
status snapshot. It shows at most 20 finished request observations: serialized
upstream payload bytes, image count, reported input tokens, the advertised model
window and terminal outcome, plus process-local compaction outcome counts. Missing
fields are unknown, not zero; input/window is a reference ratio, not an exact live
session measurement. No prompts, image bytes, files, tool results or extra session
scan are retained. Rows render when opened, without another API call.

When the saved token is missing, `ccdx` looks for compatible local Copilot GitHub tokens, validates them with GitHub and Copilot, and imports a valid one before starting Device Flow. It checks explicit token sources (`CCDX_GITHUB_TOKEN`, `CCDX_GITHUB_TOKEN_PATH`, and `CCDX_GITHUB_TOKEN_PATHS`) plus common local `auth.json` layouts. Generic discovery refuses to choose silently when valid credentials for multiple GitHub accounts are found.

Discovery also reads legacy OpenCode's `$XDG_DATA_HOME/opencode/auth.json`
(otherwise `~/.local/share/opencode/auth.json`), specifically `github-copilot`
OAuth `refresh`, and an installed GitHub CLI's noninteractive
`gh auth token --hostname github.com`. It does not import unrelated API keys,
enterprise-host OAuth, browser cookies, subscription credentials or a newer
OpenCode database format. `APPDATA` and `LOCALAPPDATA` auth.json roots are included
where present. GitHub CLI is optional, not a runtime dependency; its output/time
are bounded and no login prompt is started. Other apps' files remain read-only.
Source reads are bounded, discovery validates at most 24 distinct tokens within
a 12-second overall validation budget, and each candidate has a 4-second budget.
Directory/profile scans have explicit caps; hitting a cap or a network failure
reports incomplete discovery rather than silently selecting an account or
starting another login. Set an explicit source/account to resolve ambiguity.
An existing saved-token startup path performs no extra discovery/network calls.
Package reinstallation does not clear that user-owned credential. Copilot's short-lived
access token is obtained again when needed; it is not the saved GitHub credential.
For the default credential store, Copilot HTTP 403 preserves the credential and
reports access/network policy rather than recommending deletion. Copilot HTTP 401
performs a bounded GitHub identity check only if compatible local recovery did not
succeed. Only an identity HTTP 401 permits reauthorization guidance; an unavailable
check does not establish expiry. Neither case automatically deletes the credential
or starts Device Flow. Denials are not hidden by a cached Copilot token. A discovery
HTTP 403 also stops before Device Flow, preserving external sources and account
selection. Isolated/custom credential clients retain their own recovery contract.

After an account is selected, automatic `401`/`403` recovery and in-process token rotation accept only that same GitHub account. Concurrent callers share token refresh work without sharing cancellation, and a still-valid Copilot token may be used briefly after a transient refresh failure. Explicit token variables remain the intentional way to select another account.

If refresh still fails with Copilot `401` or `403`, preserve the saved credential.
Run `ccdx auth status --online` only when you explicitly want an online diagnosis;
check account entitlement and company routing policy separately. Reauthorization
is appropriate only after independent GitHub identity rejection or an explicit
account-change decision, not merely a Copilot denial, package update, or failed
network probe. Existing same-account recovery and explicit source selection are
unchanged.

## HTTP error diagnostics

`http_errors.recent` keeps its 20-record rolling view. Independent
`actionable_recent` (20 inference/other failures) and `protocol_recent` (eight
image-MCP HTTP 405 records) prevent route/method noise from erasing inference
evidence. `by_category` counts inference, protocol, route and other HTTP failures;
classification does not discard errors, grant access or retry requests.
The WebUI prioritizes actionable records; raw HTTP counters remain visible.

New records retain safe error code/type/parameter paths, method, an allowlisted
endpoint without a query, and upstream attempt count. Requested/served model
IDs are distinct; only the explicit Auto-review alias identifies that request
purpose. Other purposes remain unknown, not guessed from a model name.
Known enum/numeric options
include reasoning effort, service tier, output format, max output tokens and
input/tool counts; no prompt, schema or tool values are kept. `error_body` says
whether the upstream provided empty, structured or unstructured error details.
Recent request `attempts` and HTTP `attempt_timings` retain the first and last two
provider dispatch/header offsets and statuses; these are not TCP-retry counts.

By default arbitrary upstream error prose is not copied into HTTP diagnostics.
For a specific investigation, start a **new** service with
`CCDX_HTTP_ERROR_DETAILS=1` to retain a redacted error-message excerpt, capped at
500 characters, in those bounded in-memory records. In Windows PowerShell set
`$env:CCDX_HTTP_ERROR_DETAILS='1'` before `ccdx.cmd`. This does not reconfigure an
already-running service, enable file logging, retain whole requests, or guarantee
that arbitrary upstream prose contains no private context. Review before sharing;
unset the variable after the investigation. Records disappear on service exit.

## Security

- CCDX binds to loopback by default. Non-loopback hosts are rejected unless `CCDX_ALLOW_LAN=1` is set explicitly.
- Enabling LAN binding exposes a Copilot-backed API to other reachable machines. Provide your own host firewall and network isolation; do not expose the listener to an untrusted network.
- Inference POSTs reject any browser `Origin` header before reading the body or contacting upstream, including simple `text/plain` requests. Native Codex/Node requests without Origin and deliberately enabled native LAN clients keep their existing access. This is not authentication or protection against untrusted local native programs.
- The GitHub OAuth credential is stored locally at `~/.local/share/copilot-api/github_token`. Short-lived Copilot service tokens remain in process memory and are refreshed as needed.
- The optional image API credential is stored separately with mode `0600` only after `ccdx enable-image`; it is never placed in Codex configuration or diagnostic output.
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
| `CCDX_UPSTREAM_TIMEOUT_MS` | `120000` | Per-phase timeout for Responses preparation and non-streaming upstream requests |
| `CCDX_STREAM_HANDSHAKE_TIMEOUT_MS` | `120000` | Timeout while waiting for upstream streaming response headers |
| `CCDX_STREAM_IDLE_TIMEOUT_MS` | `120000` | Maximum idle time between upstream streaming body chunks |
| `CCDX_UPSTREAM_RETRIES` | `2` | Retries for safe requests and clearly pre-connect POST failures; capped at `5` |
| `CCDX_UPSTREAM_RETRY_DELAY_MS` | `300` | Initial upstream retry backoff in milliseconds; capped at `5000` |
| `CCDX_AUTO_REVIEW_MODEL` | saved selection or `gpt-6.1-sol` | Copilot Responses model used for Codex Auto-review; overrides the interactive selection |
| `CCDX_LOG_PATH` | unset | Mirror terminal logs to a file; set to `1` for `~/.local/share/codex-copilot-dx/debug.log` |
| `CCDX_LOG_LEVEL` | `info` | Set to `debug` for upstream attempts, status codes, retry causes, and timings |
| `CCDX_HTTP_ERROR_DETAILS` | unset | Set to `1` on a new service to retain redacted HTTP error excerpts (500 characters) in bounded memory; review before sharing, no file logging is enabled |
| `CCDX_LOG_MAX_BYTES` | `16777216` | Rotate the debug log at this size and retain one `.1` backup; set to `0` to disable rotation |
| `CCDX_TERMINAL_ANIMATION` | auto | Show the selected transient animation while an interactive terminal has active requests and no output for 800 ms; set to `0`, `false`, `no`, or `off` to disable |
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
| `CCDX_GITHUB_TOKEN_PATHS` | unset | Multiple token files separated by the platform path delimiter (`:` on macOS/Linux, `;` on Windows) |
| `CCDX_GITHUB_LOGIN` | saved account | Require automatic discovery and recovery to use this GitHub login |
| `CCDX_DISABLE_TOKEN_DISCOVERY` | unset | Set to `1` to skip local token discovery and use the saved token or Device Flow |
| `CCDX_TOKEN_LOCK_TIMEOUT_MS` | `600000` | Maximum time to wait for another process to finish GitHub token login or import |
| `CCDX_TOKEN_LOCK_STALE_MS` | `900000` | Minimum age for stale-lock recovery; a lock with a live owner is not removed |
| `CCDX_EXISTING_ADAPTER_TIMEOUT_MS` | `500` | Timeout for detecting an already-running local adapter during startup |
| `CCDX_MODEL_REFRESH_TIMEOUT_MS` | `5000` | Timeout for Copilot model refresh or live Auto-review model lookup |
| `CCDX_MODEL_REFRESH_INTERVAL_MS` | `7200000` | Periodic model refresh interval; `0` disables periodic refresh, while startup cache/refresh behavior still applies |
| `CCDX_RESPONSE_HISTORY_MAX_BYTES` | `67108864` | Higher-precedence total in-memory byte budget for locally expanded Responses history; `ccdx cache --limit` provides a persistent 16–1024 MiB setting when this is unset |
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

Repeated plain usage summaries in the same process reuse one bounded cache entry when both retained log files are unchanged. File identity, size, modification/change timestamps and a two-second recent-write guard control reuse; concurrent settled-file queries share one scan. The serialized summary budget is 256 KiB and at most 128 model groups; larger results remain complete but uncached. Warnings, unstable reads, metadata errors and scans with changed files are not retained. Each caller receives an independent result. Analytics record callbacks and custom-warning reads keep the original streaming path. There is no persistent index, background polling, cross-process cache or change to usage writes; the first analytics read still scans the retained records. Dashboard analytics then reuses up to two settled aggregate snapshots within a combined 2 MiB serialized budget, keyed by file identity/version, time zone and local date. Concurrent identical reads share one scan; writes, rotation, truncation, replacement, warnings, future/undated records and oversized results prevent reuse. Returned data is cloned, and custom callbacks/warnings keep the uncached path.

Diagnostic redaction removes Basic authorization payloads and URL userinfo, and consumes escaped quotes inside sensitive JSON fields. Ordinary Basic-related prose, safe host/path information and error codes are retained. These protections apply to existing failure/status/debug diagnostics, not forwarded requests or upstream response bodies. They do not make arbitrary upstream prose guaranteed safe to share.

## Debug logging

Set `CCDX_LOG_PATH=1` to mirror terminal logs to `~/.local/share/codex-copilot-dx/debug.log`, or provide a custom path. Add `CCDX_LOG_LEVEL=debug` for upstream attempts, retry causes, status codes, and timings. The adapter does not deliberately dump request/response bodies or authorization headers. File diagnostics redact common credential forms and labelled content echoes, but this cannot identify every secret in arbitrary external prose; review logs before sharing them. File writes are asynchronous and batched with a 4096-record / 2 MiB pending-and-in-flight ceiling. Overflow drops excess file records with one warning and a status counter; terminal output continues. CLI exit paths flush for at most 1.5 seconds. `ccdx doctor config` bypasses file logging entirely.

## Large histories and images

Long computer-use sessions can accumulate screenshots that are sent again on later turns. This can increase local preparation time, upstream handshake latency, and the chance of a `413 Payload Too Large` response.

The response-history cache is process-local and byte/entry bounded. Restarting the adapter discards it; a `previous_response_id` stored only in that process becomes unavailable. CCDX does not persist conversation history to disk. Near-limit status diagnostics report the largest tree and actual lookup misses, but do not recover an already evicted ID or change the cache budget. Clients can still submit explicit history in the request body, subject to the same limits.

CCDX attempts to downsample inline base64 images to model-appropriate pixel bounds, with a 2048 px long-edge fallback, and initially encodes them as WebP quality 82. It never replaces an image with a larger encoding and uses one global concurrency limit across direct images and function/custom-tool outputs. GIFs and non-inline references are not re-encoded. An encoding/decode failure keeps the original image; the final request-byte limit still applies.

The final serialized UTF-8 body is measured before forwarding. Above the configured limit, unique source images are processed largest-first from their originals at quality 75 / 1600 px and then quality 65 / 1280 px, stopping when the body fits. If necessary, the forwarded view omits older duplicate images, historical tool images, other historical images, and finally old tool outputs while preserving current input and tool-call skeletons. Requests that still do not fit receive a structured local `413`.

Completed image transforms are reused from a byte-bounded process-local LRU cache, and concurrent requests for the same transform share one encode. Failures are not cached and request cancellation remains isolated.

The visual-history pressure pass does not omit images while there are at most 24 historical images and the expanded body is at most 18 MiB; normal image encoding and other limits still apply. Above either threshold, this pass preserves current-turn images and keeps up to 16 recent historical images, targeting 16 MiB. The separate 50-image and total-body limits remain in force. After an eligible large-visual-history preparation, handshake, upstream timeout, or HTTP `408`, the next retry uses an 8-image, 10 MiB recovery window for ten minutes. Two successful requests or a successful compaction clear recovery mode. CCDX never transparently repeats an ambiguous timed-out POST, and it does not delete local history.

When expanded history exceeds Copilot's 50-image request limit, CCDX removes older duplicate occurrences first and then keeps the 50 most recent images. This affects only the forwarded request; local history remains complete and current images are preferred.

For `/v1/responses/compact`, CCDX sends one terminal `compaction_trigger`, validates completed compaction state, and preserves the complete returned window as the canonical next context. Only a validated window becomes a new local history root. Existing older branches remain available until normal history eviction.

Changing the model or transport of a continuation can require removing incompatible encrypted history from the forwarded request. A specific upstream encrypted-state verification failure can also trigger one sanitized retry, including when a nominally successful HTTP response ends with `response.failed`. CCDX withholds only the pre-output prelude of an encrypted continuation while evaluating that terminal event; it never retries after visible model output, so it cannot duplicate an already-started answer. Unrelated failures pass through unchanged. CCDX does not decrypt that state locally.

Native Responses forwards Codex `agent_message` items unchanged. When a model requires Chat Completions, CCDX frames them as messages from another agent, not human input or approval, retaining author/recipient, typed text/refusal/reasoning and representable image/screenshot content. Content unsupported by Chat, including file, audio or opaque encrypted parts, receives an explicit compatibility error instead of being serialized into ordinary text. This projection does not introduce another model request or change native Responses, Fast, Auto-review or compaction routing.

After the stream handshake succeeds, stream liveness uses the idle timeout rather than the expired handshake deadline. Eligible HTTP-200 failure recovery acquires a bounded preparation budget and history admission before rebuilding its payload, then releases those reservations when the retry opens upstream or fails. Normal streams still release preparation admission after their response headers arrive.

Downstream backpressure waits also observe cancellation and the stream deadline. A client that stops reading cannot retain the pending stream indefinitely after timeout; CCDX closes that connection without retrying its request. Final error-frame delivery has a separate one-second maximum drain wait.

Successful streaming responses are accepted only when the upstream body is SSE and reaches its protocol terminal event. Unexpected EOF becomes a protocol-native stream error, and repeated blank tool-argument deltas are stopped per tool call. Allowlisted rate-limit, retry, model, trace, and upstream request-ID metadata are forwarded; cookies, authorization, body-length, and encoding headers are not.

CCDX keeps each native Responses message on its first upstream ID when Copilot changes that ID during streaming. Message deltas, completion events, and cached history stay consistent, addressing this cause of duplicate live messages in Codex App. Tool identities, reasoning/encrypted content, message phases, and speed-tier routing are unchanged by this ID normalization. Stable events retain their original SSE bytes; changed events are rewritten with bounded, backpressured streaming.

Newer Codex App builds can advertise an `image_gen` namespace that already exists upstream. CCDX removes that exact conflicting client tool before forwarding and retries once only when Copilot explicitly reports an image namespace collision. Image input and screenshot optimization remain enabled.

## Development

```bash
npm ci
npm run verify
npm run bench:payload
```

`bench:check` covers both SSE parsers, including native Responses identity rewriting, 1/4/8 MiB fragmented events, write batching, and slow-client backpressure. It also repeats four concurrent image preparations across six rounds using a desktop-sized synthetic screenshot and a public-domain photograph. Checks enforce content preservation, single-pass JSON parsing, bounded copying, cache reuse, settled work, and bounded retained heap/ArrayBuffers after warm-up and GC. Sampled RSS and absolute timings remain report-only because allocators, runtimes, and machines differ; the fixtures do not establish production latency or visual model accuracy.

`npm test` runs unit, handler, CLI, and documentation-contract tests. `npm run test:smoke` starts a real local adapter with fully injected offline upstreams. `npm run bench:check` enforces linear SSE scanning, image/tool processing, and request-admission resource limits. `npm run pack:check` verifies npm tarball contents without publishing. `npm run bench:payload` is a report-only isolated-process benchmark for 5–60 MiB synthetic padded-image payloads and does not contact Copilot. CI runs the complete `verify` gate on Node 22.15.0 and 24.x.

The [documentation index](https://github.com/DaleXiao/codex-copilot-dx/blob/main/docs/README.md) distinguishes current guidance from historical release evidence. Release reports retain the measurements and limits of their specific versions; they do not establish current live-provider compatibility.

From a source checkout, `node scripts/codex-message-id-replay.mjs --codex /absolute/path/to/codex` checks message identity against an installed Codex runtime using only synthetic SSE, a local mock server, and automatically cleaned temporary Codex directories. It does not use the real client configuration or call Copilot.

## License

MIT
