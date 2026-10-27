# CCDX command, configuration and compatibility reference

Use Codex App with GPT models available to your **GitHub Copilot** account by default.
The optional [Microsoft 365 provider](#microsoft-365-provider) supplies a protocol-isolated
Claude gateway and an explicitly selected Codex backup.

## Manual APIs and client access

`ccdx web` starts management without GitHub sign-in or automatic App launch.
Use **Model sources → Add API**, save the HTTPS API base address/key
(including a required prefix such as `/v1`), then reopen **Manage → Read models**.
Select the models to use and their supported interfaces, save, then choose each
client's visible models and default on **Codex** or **Claude**. Unselected catalog entries
are not saved. A selected model needs at least one interface; choosing an
interface also selects its model. Manual ID entry is an optional collapsed path
for models absent from the catalog. Only Codex on GitHub needs the default
GitHub sign-in path. To use Claude alone, disable Codex access. Stop the
management-only process before normal `ccdx` startup for the live terminal.

| Client | Local base path | Required upstream API |
| --- | --- | --- |
| Codex App / CLI | `/v1` | Responses |
| Claude App / Claude Code | `/anthropic` | Messages |

All paths share the main port, normally 2026. Manual Codex and explicitly managed
Claude clients receive distinct private local credentials; never the upstream
key. Display hints do not authorize requests. API addresses require HTTPS, no
userinfo/query/fragment, and endpoint overrides on the base address's origin.
Redirects are refused. Existing proxy/bypass/private-CA rules remain; unsupported
dynamic macOS routing fails without a direct fallback. Windows delegates system
routing to a target-pinned WinHTTP worker. Failed calls are not replayed. A
transport failure before response headers marks that transport unhealthy; a
later request creates a new transport and rereads the existing routing policy.
Other responses already using the old transport finish before it is released.
HTTP denials and deliberate cancellation do not trigger this recovery.
Network failures retain `ccdx_api_network_unavailable` and include a bounded
`error.diagnostic`: a recognized local error `code`, observed `phase`, and
`reused_socket` (boolean or unknown). Unknown codes/phases remain `unknown`.
Diagnostics omit raw error text, endpoints, headers, keys and request content.

Up to 16 uniquely named manual APIs and 500 unique models per API are supported. Model IDs are limited to 160 characters; `codex-auto-review` remains an internal alias. Custom model
IDs are not filtered by a GPT/Claude prefix. Each model declares Messages,
Responses and/or Chat Completions; optional stored `context_window` and
`reasoning_efforts` metadata remain explicit. Chat-only records are catalog
information, not converted into another client protocol. Saving automatically
reads the catalog; failure does not undo saved configuration. Startup and the
existing periodic model-refresh cycle refresh enabled APIs serially, using a
30-minute success cache and a one-minute failure cooldown. **Read models** can
refresh sooner, but shares a one-minute cache with recent reads. Directory GETs
use a 20-second total deadline, 8 MiB total body bound, 500 models and at most 25
pages. Native `has_more`/`last_id` pagination uses only a validated `after_id`
cursor on the configured catalog URL; arbitrary next URLs are never followed.
An ID-only result has unknown protocol support until reviewed. Ordinary page
reads use saved data; no discovery sends inference. `ccdx models` labels manual
models as configured, not live. New catalog entries are candidates, never
automatically granted to a client. An absent entry does not delete a saved model.

For manual Messages APIs, CCDX writes Claude App's model configuration
automatically. Standard Claude IDs keep their existing identity; other IDs use
a stable `ccdx/claude-compatible-<digits>` route with `labelOverride` set to the
real model ID. Reordering or adding models does not renumber existing routes.
The App's model catalog advertises the same routes and real display names.
Users do not need to add aliases manually. Owned configuration migrates through
the existing field journal; custom or managed settings remain protected.

Only the authenticated Claude App binding enables this translation. The gateway
resolves routes against that source's allowed Messages models, sends real IDs
upstream for Messages and token counting, and returns the requested route in
JSON messages or SSE `message_start.message.model`. Other SSE frames, tool data
and signatures are retained. Alias SSE framing is bounded by the existing event
limit and follows client backpressure. Usage and request diagnostics keep real
model IDs. Explicit multi-source bindings use source-qualified routes for Codex and both Claude clients. Unqualified legacy IDs resolve only when exactly one authorized deployment matches. Source/key history boundaries and native protocol semantics remain enforced.

Some App requests include `system` messages as well as a top-level `system`
field, including system notes after user content. For manual App connections,
CCDX appends their text blocks to the top-level field in system-message order,
retaining system priority, block metadata and the order/content of conversation
messages. Non-text system content fails locally. Other clients and providers
keep their existing payload paths.

Compatibility routes address Claude App's model-name filter. A saved connection,
successful model-list read or connection check does not prove complete App
conversation, tool or thinking support for every upstream model.

`connections.json` beside user settings (respecting `XDG_CONFIG_HOME`) stores a
strict version-two graph of provider switches, API metadata, source grants and per-client model deployments/defaults. Version one is read with its original single-source visibility; the first write preserves original bytes in `connections.json.v1-backup`. A null deployment list retains the legacy source catalog; an explicit array exposes only its selected deployments. Migration never expands an old `allowed` grant into model visibility. It stores only credential references or an environment
variable name. Keys use macOS Keychain service `codex-copilot-dx.manual-api`,
Windows CurrentUser DPAPI-protected bytes, or Linux Secret Service (`secret-tool`).
Unavailable protection fails without plaintext fallback. Headless installations
may use `key_env` under Addresses & authentication; set the variable before CCDX
starts. Its value is never returned by management or copied into client config.
Private helpers omit unrelated credentials and Node hooks. API error bodies are
replaced with stable codes; valid Retry-After metadata is retained.

An explicit empty Codex deployment array pauses CCDX access, including after a
restart or disabling the last selected source. Models, Responses and compact
requests return `503 ccdx_client_source_disabled` before checking a client key;
no upstream call, automatic model selection or login repair is attempted. Enable
the app/source and select at least one model to resume. GitHub-only selections
retain native OpenAI mode; nonempty mixed/API deployments retain private-key
authentication. With automatic sync enabled, pausing restores only owned Codex
configuration; manual sync leaves native files unchanged. Neither changes login.

`client-gateway-keys.json` holds local credentials separately. Disabled sources leave normal source lists. **Model sources** owns **Disabled sources**; application access cards own **Disabled clients**. App navigation remains available while access is closed, so its restoration control stays reachable. Each
collapsed list appears only when it has entries and provides **Enable again**.
Closing a client stops CCDX access, not the app. Disabling an in-use source
requires explicit replacements or pauses. Pinned API streams finish on their
original provider; retired transports/keys are released afterwards. Legacy M365
work is guarded before its old gateway is removed. Recovery preserves grants,
configuration and historical usage without choosing a current source. With a
managed graph, `m365 off` pauses affected bindings; `m365 remove` preserves shared
Claude ownership records still needed by APIs.

Claude's existing field-owned journal protects custom/managed edits. Manual
clients use the existing profile with generic name CCDX; M365's beta restriction
is not imposed on APIs. Only an unchanged owned restriction is restored. Adding
an API alone does not migrate existing M365 client credentials. First explicit
Claude connection management installs private client keys; reopen affected apps.
Codex reconciliation owns provider selection, the selected model, the private
provider table and, in native mode, `openai_base_url`. GitHub-only selections use
this base URL with the built-in `openai` provider; fresh native setups create no
custom provider table. The App therefore keeps its native provider branch.
An unchanged old `ccdx_gateway` table is retained inactive during migration so
existing sessions can still resume their recorded provider. New sessions use
`openai`; existing session files are never rewritten to disguise their provider.

The versioned ownership journal records exact prior/owned declarations and
supports native/private switching and restoration. Startup defers an owned base
URL to this reconciliation instead of overwriting preserved user edits. Identical
setup does not rewrite the file. A missing default keeps its identity and does
not prevent a safe native route repair. User model/base edits remain protected.
Reconciliation never writes `auth.json` or replaces native credentials.

Non-GitHub deployments retain the private provider/local-key route. Existing
native sign-in or credential-store policy keeps `requires_openai_auth = true`;
a fresh API-only profile remains usable without ChatGPT login. Native account
operations retain their own authentication. App custom-provider controls can
differ from native OpenAI controls; CLI catalogs do not prove App UI parity.
Reopen Codex after an owned provider/authentication configuration change.

GitHub-only explicit bindings preserve the legacy native loopback access contract,
including requests from a process that has not yet reloaded its configuration.
Their catalog comes from the selected deployments, not a second live Copilot read.
Adding any non-GitHub deployment requires the private Codex key for the entire
catalog and all bound inference requests. Unselected models remain refused.
A supplied non-Codex bearer receives a local 403, not a ChatGPT 401 refresh
challenge. Missing credentials still receive 401; neither denial reaches upstream.
Temporarily unavailable selected models remain visible in the application editor.
Saving them fails without changing prior settings; refresh the catalog or explicitly
clear the affected selection. A missing directory entry never means deselection.

A manual Codex provider includes an authenticated `model_catalog_url` on the same
listener. Native app-server catalogs list configured names; the App may still use
its custom-provider UI for non-GitHub selections. Unknown names
use conservative metadata without borrowed model instructions, invented context,
vision, web search or Fast claims. API-specific Auto Review uses its configured
model and advertised efforts; following the client does not synthesize low.
See the official [provider configuration](https://learn.chatgpt.com/docs/config-file/config-advanced#custom-model-providers)
and [gateway catalog requirements](https://learn.chatgpt.com/docs/enterprise/roll-out-a-gateway#use-a-model-catalog-for-custom-names).

Responses namespaces include API configuration/key identity. Managed native
histories retain at most 1,024 HMAC-only correlation/owner pairs in
`conversation-sources.json`. No prompt, raw session ID or key is stored. A known
session or first-message correlation that changes source/key returns 409 before
forwarding history. This is bounded observation, not proof of the provenance of
unseen external history. Start a new conversation after source/key changes; do
not transfer opaque reasoning, compaction or signed history between services.
There is no automatic load balancing, fallback or cross-source history replay.

`/_ccdx/ui/connections` requires loopback, the dashboard header, same-origin JSON
POSTs and a 256 KiB body bound. It returns redacted configuration and explicit
action results. Invalid/conflicting files are retained. The ordinary two-second
status returns compact source/client summaries, not all model records. Metrics
allow the two built-ins plus 16 APIs (18 labels plus bounded `other`). Aggregate
Claude observation covers all Messages sources; M365 counts keep their own scope.

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

## Microsoft 365 provider

Starting with 0.10.0, CCDX can discover authorized M365 models independently of
Copilot CLI. This is not restoration of the retired personal-GitHub Claude profile
or PM Studio patch. The core Codex provider remains GitHub until explicitly changed.

```bash
ccdx m365 status
ccdx m365 models
ccdx m365 accounts
ccdx m365 account
ccdx m365 account --id aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
ccdx m365 switch
ccdx m365 switch m365 --model gpt-6-sol --auto-review-model gpt-6-sol
ccdx m365 switch github
ccdx m365 off
ccdx m365 on
ccdx m365 remove
ccdx usage --provider m365
ccdx usage --provider github
```

The model IDs above are examples, not guaranteed entitlement. `switch` checks the
current M365 catalog before committing. Interactive mode asks for the provider,
Codex GPT model and Auto-review model; scripts must supply available IDs (or reuse
previously saved valid choices). Switching requires the running updated adapter.
It affects subsequent requests, not in-flight streams. Existing Codex threads keep
their selected model: choose an available M365 model in the App. Unavailable
models return a clear error instead of being aliased. There is no automatic
cross-provider failover, quota borrowing or organization/account substitution.

Startup uses the official optional `@azure/msal-node-runtime` 0.20.6 package in a
short-lived Node helper. It discovers OS broker accounts and calls silent token
acquisition only. It neither launches a login UI nor reads Copilot CLI tokens.
macOS requires MDM enrollment and a working Microsoft Enterprise SSO broker;
Windows uses its Microsoft account broker. Tenant policy, device compliance,
account authorization and Loki entitlement still decide access. Saved bindings remain selected, including bindings created before account selection was added. Without a binding, Windows runs its system `whoami.exe /upn` once when multiple candidates exist (2.5-second limit) and accepts only a unique exact case-insensitive match with a discovered company account. It does not use the device enrollment identity, environment username, email suffix or list order. Local sign-ins, unsupported UPN lookup and shared UPNs fall back to a single company account or explicit selection. The Node broker has no explicit current-OS-account flag; a UPN match is not a SID/object-ID or device-compliance check. Entra/hybrid enterprise environments still need their own validation.

Duplicate stable account/tenant records are merged only when their identity metadata agrees. Conflicts and multiple remaining accounts require user action. Personal Microsoft consumer-tenant accounts are excluded. Windows local sign-in with an Office company account works only when the broker can discover that account; Office's sign-in UI does not prove broker visibility or model entitlement.

Use **Model sources → Microsoft 365 → Company account** or `ccdx m365 account` to choose. `ccdx m365 accounts` performs local discovery only; its opaque IDs can be passed as `ccdx m365 account --id ID`. These commands require the updated running service. Selection rediscovers accounts, rejects stale IDs, authorizes only the selected account and fetches its catalog once before committing. Failure retains the previous binding/catalog. Active M365 requests or startup work prevent selection; new M365 requests are refused during validation, while GitHub remains independent. Account changes apply to both M365 GPT and Claude; the selected Codex provider and saved model choices are not silently changed. Models missing from the new catalog require an explicit model choice. No interactive Microsoft sign-in UI is opened automatically. Interaction requirements, policy refusal or a missing native package leave M365 unavailable. None of these invalidate GitHub credentials.
The GitHub-selected Codex path retains its existing first-run GitHub login flow.

The optional package download is approximately 14.6 MB, contains prebuilt binaries
and has no install script or runtime dependencies. It is not bundled Copilot CLI.
If this optional broker alone is unavailable, core GitHub/prediction/image behavior
remains available with the existing dependencies installed. Do not use a blanket
`--omit=optional` workaround: sharp still needs its platform-specific optional binaries.
M365 is enabled automatically only on macOS/Windows; Linux reports it
unsupported. The `CCDX_M365` environment control accepts `0` to suppress M365 startup for that process. It does not
restore existing client settings; use `m365 off` for that explicit operation.

Entra tokens are retained in memory until renewal/close, never saved in a CCDX
credential file. Renewal is silent and single-flight, with a 28-second helper
deadline and one-minute failure backoff. The provider uses only
`https://loki.delve.office.com/api/v1/llmapi`; discovery uses `/models` and
inference uses its advertised native Responses or Messages endpoints. This is a
private service, not a promised public SLA. Its fixed origin is shared by the Node and Windows target policies; authentication resources and company network policy are unchanged. No request is redirected to another
origin. Model caches and replay namespaces are bound to this service origin and account. A legacy cache with no origin, or one from the prior dogfood origin, is preserved on disk but is not published as this environment’s catalog; a successful discovery replaces it. Disabled sources and saved client/model selections are not automatically changed. Explicit proxy/trust settings are preserved. Windows delegates system
PAC/WPAD and integrated authentication to its own isolated WinHTTP worker;
unsupported macOS dynamic PAC is reported rather than bypassed.

System `ExceptionsList` entries such as `169.254/16`, `10/8`, `172.16/12` and `192.168.1/24` are normalized to full four-octet IPv4 CIDRs before the existing shared Node/PAC matcher. Missing octets become zero only when the supplied octets cover the prefix; invalid octets, ambiguous leading zeros, out-of-range or underspecified prefixes remain errors. User-supplied `NO_PROXY` retains its existing strict syntax. No system setting, proxy bypass policy, DNS lookup or network probe is added. The shared system-input correction also applies to prediction environment parsing.

M365 proxy-setup failures retain their existing outer category (`m365_proxy_settings_unsupported`, `m365_proxy_discovery_failed`, or the existing environment-failure category `m365_network_error`) and add an optional `network_diagnostic`: fixed `source` (`system`/`environment`), `stage` (`proxy_discovery`/`proxy_config`) and `cause_code`. Causes distinguish discovery, dynamic PAC/WPAD, invalid bypass rules, invalid static settings and invalid/unsupported proxy addresses; unknown causes stay generic. CLI/startup explain the specific cause without suggesting a new sign-in for a known network setup failure. WebUI shows the bilingual reason in source status (codes in its tooltip) and the existing model-check details, with source/stage/cause fields. Proxy URLs, credentials, raw settings and raw nested errors are never projected. These local setup failures happen before the model HTTP request; a local 502/503 does not establish a model-service denial. Successful transport setup or a later unrelated refresh failure clears the previous setup diagnostic. Failed catalog reads still remain failures and preserve last-good data; they are not successful empty catalogs. No automatic route substitution or extra polling is added.

The M365 profile under `~/.local/share/codex-copilot-dx/profiles/m365/` contains
`settings.json`, nonsecret `account.json`, account-bound `models.json`, a private
local `gateway.json` key, and `client-config.json` field ownership. JSON reads are
bounded at 4 MiB and regular files only; new owned files use private permissions.
Codex source and M365 review choices live separately in
`~/.config/codex-copilot-dx/providers.json` (or under `XDG_CONFIG_HOME`). Existing
GitHub auth/cache/preferences, Codex auth, prediction trust and image keys are not
copied into the M365 profile. The system's Microsoft SSO account is never deleted.

M365 catalogs refresh at startup and on explicit lookups. Existing model-list
reads and Claude Messages traffic start a background refresh after two hours;
disk caches older than seven days are rejected. `ccdx models` and Auto-review's
selector follow the selected Codex source. Dashboard tabs query a registered
Provider independently of that selection; M365 uses a fresh provider catalog
lookup and labels the returned catalog timestamp. Its disabled/hidden or
ineligible models remain visible as directory metadata, with no eligible client.
Client discovery and request validation still exclude wrong publishers/protocols
and disabled/hidden models. A listing does not prove inference access or quota.
M365 Fast is unverified and `priority` requests fail explicitly; choose Standard.
GitHub Fast behavior is unchanged.

M365 Auto-review has its own required model choice and defaults to low reasoning.
`ccdx auto-review-model` changes that provider's model/effort without touching the
GitHub preference or falling back to its cached catalog. Native prediction still
uses the conversation's selected model through the normal Codex endpoint. The
optional image MCP/skill/API remains separately configured and off by default.

### Claude gateway and client ownership

Company-account history is isolated. `conversations.json` stores at most 1024 hashes of conversation identifiers (or the first user item when no native identifier exists) and their account fingerprints; no messages, raw session IDs or tokens are stored there. Each new conversation writes its ownership once; known conversations use memory. After changing accounts, known foreign conversations are refused before forwarding. Unknown requests containing old history are also refused, including after restart; use a new conversation. Clients without stable conversation IDs can collide when their first user item is identical, so supply a unique native session ID. Evicted/unrecognized history fails closed after a switch. The history-isolation marker is saved with the binding and survives token renewal. Removing the M365 profile clears this ownership file, but never removes system sign-in or usage history.

Account selection stages the new authorization/catalog before replacing the old provider. Catalog and binding writes use the existing locked atomic writer with restoration on failure; this is not a crash/power-loss transaction. Client configuration remains a separate readiness state: its failure does not claim that account authorization failed or overwrite custom/managed fields. Previously saved model preferences are not substituted when the new account lacks those models.

Since 1.1.0, Claude mounts under the main HTTP listener at
`http://127.0.0.1:<ADAPTER_PORT>/anthropic` (default main port 2026).
It exposes `GET /anthropic/v1/models`, `POST /anthropic/v1/messages` and
`POST /anthropic/v1/messages/count_tokens`. The Claude Base URL excludes the final `/v1`.
The local socket, loopback Host, native-client Origin rejection and private Bearer
or `x-api-key` checks remain independent of any main-listener LAN opt-in.
Messages tools, thinking, signatures, image blocks, beta headers and SSE retain
their native protocol and backpressure/cancellation handling. Provider-specific
cache policy is described below; the local gateway key is never forwarded upstream.

The protocol handler owns only its responses, never the shared server. Codex,
WebUI and Claude share the main port; native prediction keeps its CONNECT/PAC
transport and saved port. Root `/v1/messages` remains retired, including on a
custom main port. Claude requests never reach GitHub. M365 GPT-only catalogs do
not configure Claude. Optional Claude setup failure leaves the Codex backup independent.

Unchanged CCDX-owned Code/App addresses migrate from 2027 to the shared prefix,
with the original restoration values preserved. User-edited fields, managed
settings and explicit environment routes remain preserved. CCDX does not keep
a permanent 2027 compatibility listener; migrate hand-written old URLs explicitly.
Already-running clients may need a normal restart to reload their base URL.
Disabling/removing M365 is rejected while its Codex or Claude inference is active,
so an accepted disable does not cut off those requests.

Loki explicitly rejects one-hour prompt-cache retention. M365's request policy
caps standard `cache_control: {type: "ephemeral", ttl: "1h"}` fields to `5m`,
logs that limitation once and counts adjustments in its status. Prompt bytes,
breakpoint positions, tool input, thinking and approval settings do not change.
This is a retention/cost limitation of the new M365 path, not an equivalent
one-hour cache guarantee. GitHub caching is unchanged.

The gateway publishes canonical Claude version IDs such as `claude-opus-5-5`,
while M365 receives its exact `claude-opus-5.5` ID. Existing raw IDs are still
accepted. Only exact supported family/version spellings are normalized; alias
collisions fail explicitly. Bodies, thinking signatures and native response bytes
remain intact apart from the existing cache-TTL policy and the upstream model ID.

`capabilities.supports.reasoning_effort` supplies deployment-specific effort
metadata. App `inferenceModels` entries receive the highest recognized advertised
`maxEffort`; Code discovery receives canonical IDs. A successful catalog refresh
reconciles unchanged owned fields outside inference serialization. An owned legacy
Code default can migrate to its matching canonical ID; valid user model/effort
preferences are preserved. Reads after a profile change invalidate page catalogs.
Unknown metadata stays unknown. Unknown effort names remain visible as upstream
metadata and are not invented as App caps. When an explicit effort list exists,
requests for absent efforts fail before inference, without dropping the field or
substituting a lower level. Missing metadata leaves the upstream authoritative.

App effort controls also depend on its model knowledge. Supported versions can
read Anthropic's signed catalog under the App's existing network and management
policy; CCDX neither replaces that signed document nor changes its URL/policy.
`maxEffort` is a ceiling, not an arbitrary discrete allowlist: client-visible
options may differ from an upstream's sparse list, while exact request validation
remains authoritative. Unknown model identities or new protocol semantics can
still need a client or CCDX update. A displayed control alone is not an inference
verification. See [Claude model configuration](https://claude.com/docs/third-party/claude-desktop/configuration)
and [gateway behavior](https://code.claude.com/docs/en/llm-gateway-protocol).

For Claude Code, CCDX owns only its gateway environment fields in
`CLAUDE_CONFIG_DIR/settings.json` or `~/.claude/settings.json`. For Claude App it
uses the installed client's third-party config library, with one named
`CCDX Microsoft 365` profile and the normal third-party deployment setting.
macOS stores the owned App configuration below `~/Library/Application Support/Claude-3p`;
Windows uses `%LOCALAPPDATA%/Claude-3p`. First-party Claude configuration is not modified.
See the [official desktop configuration contract](https://claude.com/docs/third-party/claude-desktop/configuration).
Existing foreign gateways,
cloud-provider choices, other selected App profiles and detected managed desktop
policies are preserved. No binary patch, system certificate, execution-policy
change or forced App restart is performed. An already-running client can require
its normal restart to read the saved settings; “configured” is not proof of a
visible chat or successful reply.

Claude Code 2.1.295 emits experimental fields that this Loki API rejects with
`invalid_body`. Owned gateway setup therefore supplies the documented
`CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` compatibility option when no explicit
environment override exists. Existing user values are preserved. This leaves
standard tools, thinking and prompt-cache fields available; first-party-only beta
features are not promised. CCDX does not silently delete conversation content,
disable approval checks, or retry inference with reduced semantics. See the
[official variable reference](https://code.claude.com/docs/en/env-vars).
For Codex, both verified providers reject native image-generation declarations;
their explicit request policy retains CCDX image function/MCP tools instead.

`off` selects GitHub, stops M365 and restores only unchanged owned Claude fields.
`remove` additionally removes CCDX's account/catalog/gateway/ownership files,
while retaining the disabled preference and historical usage. Active M365 requests
block removal; user-modified fields block full cleanup and are reported, not
deleted. Neither operation clears Codex transcripts or shared image output.

### Isolation and measurements

Each request is pinned to its provider. Response IDs/history are namespaced by
provider and account inside the existing shared history-byte limit; this is not a
second unbounded history cache. Explicit switching can replay complete visible
history. Foreign encrypted reasoning is not forwarded; opaque tool/compaction
state requires verified local plaintext recovery, otherwise the request fails
without discarding earlier context. No automatic cross-source retry is performed.

CLI usage and WebUI include source filtering; historical records without a source
are treated as GitHub. Claude's cache-read/cache-write input is included in its
normalized total input, with raw reported usage retained. Missing counts remain
unknown. Combined totals are labeled; identical model names across providers can
be separated with the filter. The M365 status card separates auth/catalog state,
gateway availability, client configuration and selected Codex source. Observed
client requests are not claimed to prove the App's UI state. `doctor --online`
checks the selected provider; `doctor --fix` does not reimport inactive GitHub auth.
Claude gateway outcomes are displayed separately; core HTTP totals retain their
existing main-listener meaning rather than mixing in another protocol's counts.

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

CCDX 0.7.0 retired the former personal-GitHub Claude App, Claude Code, Anthropic Messages API, isolated Claude account, and PM Studio patch integrations. Their old setup, status, restore, profile, and routing commands remain unsupported. Version 0.10.0 adds a separate M365-only Claude gateway; it does not reactivate these old routes or PM Studio support.

If PM Studio is still patched by an older CCDX release, update or reinstall PM Studio to restore its official application bundle. CCDX 0.7.0 does not patch PM Studio and does not provide a restore workflow.

The upgrade intentionally does not delete or rewrite retired Claude or PM Studio configuration, historical patch backups, or isolated credentials created by older versions. Normal Codex configuration updates continue as documented above. Review and remove obsolete retired-integration state yourself only if you no longer need it.

## Commands

Run `ccdx <command> --help` for command-specific behavior and side-effect details.
Startup uses aligned status/project/result columns and a left-aligned Ready footer
with the Web UI URL and `ccdx help`. Ctrl+C is shown only for the foreground-owned
service, never a short-lived command reusing another service. A static, favicon-style
atom uses the saved terminal color (green by default) and half-block characters only on interactive color terminals
at least 72 columns wide; narrow terminals, `NO_COLOR`, `TERM=dumb` and redirected
output keep a plain title. No new graphics/font/runtime dependency is installed.
Credentials found are not labeled online-authorized, cached model lists are not
labeled fresh upstream data, and image configuration is not a provider test.
Ready reports core readiness independently of optional prediction/image warnings.
Model refresh logs show counts; `ccdx models` retains the complete live list.
After Ready, the default foreground display becomes a fixed status region;
request and background-refresh detail is available with `--verbose` or explicit file logging. Status messages remove terminal controls and collapse newlines;
the static banner and multiline interactive prompts retain their own presentation.
VS Code compatibility-version details remain available in debug logging. Startup
does not wait for optional update/compression work or add online doctor/model probes.

### Live models

```bash
ccdx models
```

With GitHub selected, this performs a fresh, read-only GitHub Copilot model-directory lookup without starting the adapter, opening Device Flow, reading the local model cache, or consuming an inference request. It lists selectable GPT model IDs, providers, advertised APIs, and preview status. With M365 selected it reads the running provider's isolated GPT catalog. Catalog availability does not guarantee that a later inference request will avoid quota, rate-limit, or policy enforcement.

Concurrent identical live lookups share only the active request. Caller
cancellation is independent; results are not retained as a fresh catalog after
completion. The dashboard cancels its waiter when the read is abandoned.

Interactive terminals use aligned tables for `models`, `auth status`, and `usage`. Redirected or piped output retains the plain-text layout for scripts; use `--format table` or `--format plain` when a command offers an explicit format override.

`ccdx usage` and the dashboard Model Usage table show token cache hit rate for each model and the aggregate: recorded cached input tokens divided by recorded input tokens, weighted by token count rather than averaging request percentages. This describes the upstream prompt cache; the local history and image-transform caches are separate. Incomplete historical records do not hide a computable ratio: `~` marks a rate derived from incomplete counts. A rate is `—` when input tokens are zero, usable totals are missing, or token counts are invalid. Older logs may omit explicit zero cache counts; new Responses usage records retain reported zeros. CLI tables keep existing token columns on narrow terminals and show rates below the table when the extra column does not fit.

### Auto-review model

```bash
ccdx auto-review-model
```

With GitHub selected, the selector first queries the running adapter, including its last-known-good model list when live refresh is unavailable, then falls back to a local model cache no older than seven days. It offers model IDs that advertise a Responses endpoint and are not explicitly hidden from the model picker. M365 selection uses only that running provider's catalog and separate saved preference, with no GitHub cache fallback. This selection does not itself verify policy or inference access.

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

Plain `--clean` clears only completed image transforms; the next matching request may recompute them. Adding `--history` also invalidates all process-local `previous_response_id` chains and can make a task's next continuation fail, so it requires interactive confirmation or `--yes`. Cleanup refuses active cache users; retry after current requests finish. It never deletes Codex transcripts, generated image files, provider credentials, image edit handles, model catalogs, or usage/debug logs. A stopped or older adapter must be restarted before runtime cleanup; a saved limit applies on the next start.

### Request-body limits

```bash
ccdx limits
ccdx limits --decoded 256
ccdx limits -256
ccdx limits --decoded default
```

`ccdx limits` distinguishes the saved decoded request-body limit from the running adapter's active limit. The default is 128 MiB; the opt-in saved limit accepts 128–512 MiB. Changes take effect only after restarting the adapter, never restart it automatically, and do not clear conversations or caches. `CCDX_MAX_DECODED_BODY_BYTES` overrides the saved setting; unset it before changing the saved limit. The separate 64 MiB raw/compressed-body limit is not changed. Larger decoded requests can use substantially more process memory during JSON parsing and image preparation; raising this limit may enable a large thread to compact, but does not guarantee successful inference or compaction. Return to `default` after temporary use.

### Control console and online settings

The sidebar separates Overview, indented Codex/Claude Apps, Model sources, Usage, Requests, and Settings. Codex owns optional image generation, native
prediction adaptation and the temporary Responses conversation buffer. That
buffer supports continuation; it is not a chat archive. Shared HTTP traffic and
per-protocol model outcomes are distinct. Claude Messages metrics are not labeled
as all Microsoft 365 traffic. Saved credentials, authorization, catalog discovery,
client configuration and successful requests are separate evidence.

Interactive desktop starts open the default browser once after core readiness.
`--no-browser` skips this for one invocation; `open_webui:false` in
`~/.config/codex-copilot-dx/config.json` disables subsequent automatic opening.
Query commands do not open it. Headless/CI/SSH or noninteractive starts skip it;
a browser-launch failure does not stop the service. This is an opening attempt,
not a guarantee that every browser will reuse an existing tab.

The default TTY display uses wrapping source/Claude summaries, a line-framed usage/inference table, and separate notice/activity rows, without an alternate screen or raw keyboard input. It shows usage returned since this process began; pending
usage is excluded, missing usage stays partial, and this is not an invoice.
Business requests drive terminal activity; status/catalog polling does not. The live table fills its existing last usage row with Cache hit, using the same process-local cache_hit_rate and partial marker as Overview. Unknown/invalid rates display —; a known zero displays 0.0%. Existing nine
animation styles retain their timing and cycle pauses; the default green retains its original palette. `--verbose`,
`--show-request-id` or `CCDX_LOG_LEVEL=debug` restore detailed terminal output.
Failed reads show previous-data status and the last successful update time, or that no data has been received. Narrow summaries wrap rather than hiding Claude App/Code state. Non-TTY/CI/dumb/too-small terminals use plain output; repeated identical notices
are coalesced. File logging retains its existing explicit opt-in and redaction.
In-memory usage still updates when `CCDX_DISABLE_USAGE=1` disables persistence. `runtime_usage.by_provider` separates returned process-local usage by source. The Requests view contains live Request flow, Requests by source, recent failures and request context; `ccdx status` also lists source/protocol outcomes. Unknown outcomes and partial usage remain distinct. CLI remains English; WebUI keeps English/Chinese.

The Clear conversation buffer action clears all process-local conversation continuation data. If image optimization or conversation history is active, cleanup is refused; retry after current requests finish. Old chats may fail to continue; saved Codex transcripts remain. It invokes the existing image-transform/history cleanup operation, rather than an inactive-only selector.

The source page groups account/access checks and the model list under the selected
source. Selecting a source tab only browses it; application routing is changed from
the application page. Model names remain in the main table; maker, protocol,
reasoning levels, listing state and context limit are in each model's details.
The Codex choices and source table share one catalog read with freshness,
cancellation and account-generation checks. Explicit Refresh still checks again.

Selection uses a solid theme fill with centered text, without a preceding check.
Model-list text uses the normal text color. Selects have square borders and a
visible keyboard focus indicator. Settings groups webpage appearance, independent
terminal color/animation, startup and updates. The terminal preview is expandable;
choosing an animation previews it, while Save applies it to the running terminal.
Usage trends are separate from the model summary and remain on demand. Request
rows show an observed HTTP failure separately from the model's terminal result;
request IDs and attempt counts are available in the same bounded details. List
timestamps use local 24-hour time in both UI languages.

M365 catalog refusals expose a fixed reason, HTTP status, check/last-success time
and service request ID when available. `entra_access_disabled` means the server
reported that Copilot CLI Entra access is not enabled for that account; a generic
403 does not establish why access changed. Sign-in, discovery and successful
inference remain separate evidence. Failed discovery keeps the account-bound
last-good list. A successful refresh clears old failure evidence. No automatic
relogin, model call, source switch or policy exception is added.

The settings API is local, requires the dashboard header, bounded JSON and
same-origin POST. It invokes the same Provider, cache and integration operations;
it does not spawn a CLI or generic shell command. Settings reads do not reveal
upstream keys. Each operation reads back saved and effective state. Corrupt saved
service preferences fail closed for optional calls rather than reopening them.

| Control | Effective scope |
| --- | --- |
| Webpage color | Current browser, immediately; independent of the existing dark/light choice |
| Terminal color | Live supported status table and animation; startup logo on the next launch |
| Terminal animation | Live supported status terminal; plain/verbose/environment-disabled modes are reported separately |
| Open WebUI | Next interactive desktop start |
| Image calls | New local MCP calls; keeps provider credentials and allows an already-started call to finish |
| Prediction adaptation | Subsequent configuration traffic on an already-provisioned bridge; keeps trust/route, and App caches can remain |
| Model source | Explicit validated selection for subsequent Codex requests; existing requests retain their binding |
| Conversation buffer | Live validated limit; cleanup refuses pinned/active data, then clears all buffered continuation IDs |

Boolean allow preferences `terminal_animation_enabled`, `image_enabled` and
`prediction_enabled` default to true, preserving already configured features;
they do not provision or enable the default-off image/prediction integrations.
The existing explicit CLI enable commands resume the corresponding paused gate.
`disable-image` and `prediction off` retain their documented full cleanup
semantics, distinct from a WebUI pause. First-time setup and client trust/routing
changes still use existing compatibility checks and may require a normal App
relaunch. Environment-controlled limits cannot be overridden through the page.

Visible auto-refresh reads the in-memory status approximately every two seconds,
and Provider/settings evidence approximately every 16 seconds. Hidden pages stop
scheduled reads. Catalogs and retained usage are fetched only for their open view
or an explicit lookup; their normal refresh interval remains 30 minutes. Paused
auto-refresh still permits manual refresh/settings retry. No history-log scan is
performed at the status cadence. The atom moves on load/manual refresh only and
respects reduced motion. Client attribution absent from older records stays unknown.

### Overview activity

Overview reserves a fixed-height row below its status summary. Six 4px theme-colored dots appear and retract in order while the status snapshot reports active Responses, compaction, Claude Messages or actual image generation. Catalog reads, token counting, image MCP discovery and management calls are excluded; retries do not add another logical request. Active dots have no halo. Idle shows one small dot with a breathing halo. Invalid/missing status or a read older than six seconds shows Activity unknown, without a halo. This reuses the existing two-second status polling; short requests between snapshots may not be shown. No model probing, stream connection or extra polling is added. Hidden pages/views pause motion; reduced motion shows static corresponding states.

### Color themes

Settings separates Web appearance and Terminal appearance. Each offers Classic green (default), Klein blue and Soft pink. Green preserves the previous palette and terminal table's original text colors. Blue and pink color the terminal logo, full table and activity animation without changing glyphs, timing or metric definitions. Webpage color is independent of terminal color, and of the page header's dark/light switch.

Web choices use `ccdx.dashboard.palette` (`green` / `klein` / `pink`) and the existing `ccdx.dashboard.theme` (`dark` / `light`) in browser local storage. They are applied before the stylesheet, including the atom favicon. Same-origin tabs receive storage updates; other browsers retain their own choices. If storage is blocked, the current tab still changes and explicitly reports that the choice was not saved. No service request is needed to change webpage colors.

Terminal color uses `terminal_color_theme: "klein"` or `"pink"` in the normal CCDX user config. An absent value means `green`; choosing green removes the override. It does not change `terminal_animation` or any capability flag. The same bounded, strict settings read, file lock and atomic writer are reused. Invalid/unreadable existing config is not overwritten with defaults. A successful save applies to the supported live status table; the startup logo uses the saved choice next time. Previously printed terminal lines are not rewritten. Color codes are added after width calculation and clipping. Truecolor, 256-color and ordinary ANSI fallbacks are supported; `NO_COLOR`, dumb terminals and redirected output preserve plain output. A terminal's own palette and background affect the displayed color. Pink uses a darker tone when COLORFGBG explicitly identifies a light background (7 or 15); otherwise its default tone is pale pink. CCDX does not query or change the terminal background.

The terminal sample in Settings is labeled Preview and uses sample numbers, not current usage. Existing nine animation previews and their save operation remain available beneath the color choice. Red errors and amber warnings keep their meaning across webpage themes.

### Version and update information

Settings ends with Version & updates. The current version belongs to the running service, which can differ from a newly installed package until CCDX restarts. Dates are GitHub Release publication dates, not local installation dates; an unavailable date is explicitly unknown. A verified newer stable release shows its version/date and `ccdx update github`. Copying a command never executes it. No background installation or service restart is added.

Opening Settings reads `GET /_ccdx/ui/updates`, protected by the existing loopback/Host/dashboard-header checks. It reads public GitHub REST release metadata without credentials, accepting stable, non-draft releases only. The first successful check needs at most two serial metadata requests: latest, and the exact current tag when different. The current publication date is retained in memory. Concurrent reads share one lookup; successful results are cached for five minutes and failures for one minute. The page reuses the visible-view 30-minute refresh controller, so the two-second status timer never polls GitHub. Manual checks also respect the service cache. Network configuration discovery is asynchronous and reads only npm's named proxy/CA/TLS/offline settings; no registry or policy is rewritten. Each metadata request has a four-second deadline and a 128 KiB decoded-body limit, with no automatic retry.

Failed/rate-limited checks never claim that the installed version is latest. Last-known release details remain labeled as such, separate from the latest check attempt. A failed current-tag date lookup does not hide an otherwise verified available update. The startup web-redirect check remains unchanged and independent of this REST check. If npm/network settings cannot be read or company policy blocks GitHub, the version card reports the check as unavailable.

Expand the recovery instructions to choose macOS Terminal or Windows PowerShell. Commands download the version-pinned Release installer into a unique temporary directory and remove that directory afterward. They use the newer of the running version and last-known stable release, falling back to the running version if no release is known; stale metadata cannot select a downgrade. Installers retain the documented no-Git, minimum-runtime, rollback and configured-registry behavior. Windows instructions keep the current execution policy; if company policy blocks scripts, use its approved installation method. Dependencies still require the configured npm registry.

Model-list failures name the selected source, retain its last successful list when available, and distinguish that list's timestamp from the failed check. Expand Check details for the bounded public reason, source, available HTTP status and check time. A retry time is shown only when the source supplies an actual retry delay; no new retry or automatic provider failover is added. Existing diagnostic redaction and size limits remain.

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

Running 1.1.0+ services pick up a changed saved theme without restarting. The WebUI applies it directly; the CLI gallery save is picked up by the status renderer within about one second. Older services still need a restart after upgrade. `CCDX_TERMINAL_ANIMATION=0` (also `false`, `no`, or `off`) remains the boolean gate that disables terminal animation regardless of the selected theme.

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

Since 1.2.1, the GitHub channel resolves the latest stable Release, downloads
`codex-copilot-dx-VERSION.tgz` and `SHA256SUMS` from that exact release, checks
SHA-256 and the packed package name/version, and gives the verified local file
to npm. **Git is not required.** It never installs `main`, falls back to another
channel or automatically grants remote-download permission. Each asset has a
60-second download deadline and bounded size (64 KiB manifest, 16 MiB package,
64 MiB decompressed metadata scan). The checksum comes from the same HTTPS
release; it detects corrupt/mismatched files and is not a separate signature.
Dependencies still use npm's configured registry, including a company mirror.
This is not a fully offline or registry-free distribution.

Windows runs `npm.cmd` through system `cmd.exe` with AutoRun and delayed expansion
disabled. Its fixed tarball basename is passed separately from the temporary
working directory, including when that path has spaces or shell metacharacters.
Use `ccdx.cmd` if PowerShell blocks npm's `.ps1` entry. No PowerShell policy,
registry, proxy, certificate setting or persistent npm permission is changed.
macOS/Linux keep direct npm execution with separate argument arrays.

Before npm changes a discovered global target, CCDX backs up only its package
and two command entries and acquires an exclusive install lock. A linked target
is preserved and refused. Installer or runtime-verification failure restores the
old package/commands; successful installation removes the backup. A failed restore
reports the retained backup and lock for manual recovery. New lock records include
the installer PID, creation time and backup directory. Existing-lock errors name
the exact file; other lock-creation failures retain their actual I/O error rather
than claiming another install. Old empty locks remain owner-unknown. A lock left
by a killed installer requires checking that no installation is running and
inspecting its retained backup before recovery. Locks are not removed merely
because they are old; an incomplete restore must be completed first.
There is no promise of crash/power-loss atomicity. Other apps, credentials,
settings, caches and the running service are not replaced. Readonly/busy Windows
files can prevent installation; finish use of that installation and retry.

The selected target must have the correct name/stable version (exact version for
GitHub), a working version command and working sharp. A previously installed
native M365 broker must remain loadable. A mismatched npm prefix warns and retains
the caller's choice; if the target cannot be discovered, verification/rollback
cannot be guaranteed and the command explicitly says so. Restart CCDX separately.

Normal startup still checks GitHub's `releases/latest` web redirect once in the
background, with a two-second deadline and no npm/REST/PAT access. It validates
only the redirect header, cancels the body and silently skips errors; it never
installs, polls or retries. Explicit GitHub updates use a ten-second lookup.
`ccdx update gh` is shorthand. `ccdx update npm` keeps the configured registry and
installs `codex-copilot-dx@latest`; it never silently switches to GitHub.

npm policy is read using bounded named global fields, without printing credentials.
An unrelated project's `.npmrc` cannot grant permission. npm 12's
`allow-remote=none` can reject a mirror's cross-origin dependency URL with
`EALLOWREMOTE`. Only if company policy permits and you trust this entire package
tree, use the explicit one-install exception:

```sh
ccdx update github --allow-remote
ccdx update npm --allow-remote
```

This grants URL downloads throughout that installation's dependency tree, not a
hostname allowlist. It does not change `.npmrc`, add a retry, allow every script
or override other administrator policy. Older npm receives no unsupported flag.
Unknown support prevents an explicitly requested exception from starting.

For an older updater that still requires Git, install the Release tarball directly:

```sh
npm install -g https://github.com/DaleXiao/codex-copilot-dx/releases/download/v1.2.26/codex-copilot-dx-1.2.26.tgz
# Windows PowerShell: use npm.cmd instead of npm.
```

This manual npm URL command relies on npm/HTTPS and does not perform CCDX's
separate SHA-256 check. Under strict remote policy, use the verified bootstrap or
an administrator-approved local package/cache; do not automatically broaden policy.
A failed old `github:owner/repo#tag` install with `spawn git ENOENT` means npm
could not launch Git, often because Git was absent from the terminal's PATH.
It is unrelated to Wave styling; unknown-option warnings are separate.

### Install without Node or Git

The Release also contains `install.sh`, `install.ps1`, `ccdx-install.mjs` and
`SHA256SUMS`. Download the platform script from the intended release and run it
with the current shell policy. The scripts reuse compatible Node/npm and the
configured global prefix. If unavailable, they download **only official Node
24.22.0 LTS** for the current platform, verify the pinned official SHA-256,
and keep it inside CCDX's private directory. macOS arm64/x64, Windows arm64/x64
and glibc Linux arm64/x64 archives are selected explicitly. Linux musl users can
reuse an existing approved compatible Node; this bootstrap does not add libc.
Unsupported platforms fail before installing a system runtime.

Default private prefixes are `${XDG_DATA_HOME:-~/.local/share}/ccdx` and
`%LOCALAPPDATA%\CCDX`; an explicit `npm_config_prefix` takes precedence. No global
Node, Git, Python, compiler, Build Tools or package manager is installed. Native
packages use prebuilt dependencies with install scripts disabled. The bootstrap
verifies sharp and the native broker on macOS/Windows; a missing required prebuilt
component fails and restores the old CCDX package. The private Node remains
available for a retry if a later package download is blocked.

The helper and package are verified against the release checksum list. The
bootstrap script itself is initially trusted through the selected HTTPS release;
review it or compare its checksum through an independent trusted copy if needed.
The helper reuses the selected npm's bundled `make-fetch-happen` downloader and
bounded named proxy/no-proxy/CA/TLS/offline settings, with no automatic retries.
It adds no downloader dependency, forwards no registry credentials and refuses
network downloads in npm offline mode. A nonstandard npm missing that component
fails with local-package guidance. Outer platform-script downloads use curl or
Windows' download tool under their existing network/certificate policy; managed
PAC-only/offline environments may require administrator-provided Release files.
The bootstrap keeps user/global npm configuration, proxy and certificate choices.
Unavailable downloads or restrictive policy stop with no channel fallback.
It still needs approved access to GitHub Release assets, Node downloads when
needed, and the configured registry for dependencies. For offline/managed devices,
ask the administrator to pre-stage these exact files and dependency cache or use
an approved existing Node/npm distribution; CCDX does not bypass network policy.

Private launchers bind the chosen Node and set `CCDX_PRIVATE_INSTALL_PREFIX` for
future updates. Windows bootstrap uses these validated commands even with an
existing Node, so spaces and shell metacharacters in the prefix do not break npm's generated batch commands. Exact npm-owned PowerShell launchers are removed; custom scripts and script policy stay unchanged. They supply a private `npm_config_prefix` only when the caller has
not set one. Updates preserve those launchers. PATH and shell profiles are not
rewritten: the installer prints the full command path and the directory to add
for `ccdx` shorthand. Compatible POSIX installations keep npm's normal commands. Windows PowerShell
expands percent signs in batch command filenames, before CCDX can run. The
Windows bootstrap refuses an install prefix containing `%` before modifying it;
choose a writable prefix without `%` using `npm_config_prefix`. Unicode, spaces,
`&` and `!` are covered, including a legacy console code page. This avoids shipping
an additional native executable just to bypass the shell's path parsing.
No install hook is added to the npm package.

The scripts accept only `sh install.sh [--allow-remote]` or
`./install.ps1 [-AllowRemote]`; the permission is explicit and applies to that
one installation, with the same whole-tree meaning described above. Do not use
it when company policy forbids it. Interrupted runtime downloads stay in a cleaned
temporary directory; installed private runtime cleanup is a separate user choice.

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

Interactive desktop starts open [http://127.0.0.1:2026/](http://127.0.0.1:2026/)
once by default, using the configured main port when customized. See
[control console and online settings](#control-console-and-online-settings) for
startup preferences, output modes and effective-state rules. Assets require both
a loopback connection and loopback Host, including when the main listener uses LAN mode.

The sidebar separates Overview, indented Codex/Claude Apps, Model sources, Usage, Requests, Checks & repairs, and Settings. Desktop header rows have explicit heights, the header sticks when it reaches the viewport top, and stable scrollbar space prevents horizontal movement between long and short pages. Narrow screens keep compact navigation and a two-row toolbar. Page switches reset scroll and move keyboard focus to the main content; background/manual data refreshes preserve scroll. Each page has its own purpose description, and data groups carry their own update times rather than a shared page-wide freshness claim. Codex-specific images, prediction integration
and conversation buffering stay under Codex. Buffer controls and request performance have separate groups. HTTP traffic counts include model
catalogs and route errors; model outcomes and timing are named by protocol.
Microsoft 365's Claude Messages summary is not a Provider-wide request total.

The source access table uses bounded local credential metadata and Provider snapshots, showing only the selected source. Switching source tabs also changes the account controls and catalog, never application routing. Overview groups client rows by app and uses an explicitly selected source; it does not substitute a configured but unselected source when the selected source is unavailable. The source card still lists every registered source. Claude App and Claude Code have separate setup/local-service rows, while Messages performance stays combined and is labeled accordingly. A running local service does not prove the app is open.
A locally saved GitHub credential is not online entitlement. Account names with
underscores retain their exact display value; identity, keys and environment
values are not inferred from model names. Client configuration, gateway state,
recent requests and actual inference are separate observations. The top summary
describes source/application status without mapping arrows. The source card counts and lists every discovered registered source, including disabled sources; availability and account evidence remain in the detailed tables. Each sidebar tab has a decorative inline SVG icon, with application entries indented. Terminal appearance has one Settings entry, and the animation selector has one separating rule. Settings contains webpage/terminal appearance, startup preferences and version updates. Local memory, queues, notices, raw HTTP traffic and request-size caps live under Checks & repairs → Runtime details. Account-check links identify the source and lead to its existing account tools. Save failures appear beside the affected controls; configuration repair previews and destructive-action confirmations remain in place.

Catalog tabs browse registered Provider directories without changing routing.
Rows retain protocol, eligible clients, reasoning metadata and directory state.
Unknown metadata stays unknown; listings are not verified inference access.
The source form lives under Codex and explicitly applies subsequent routing. GitHub conversation models are selected in Codex, so its conversation-model field is hidden rather than empty. Auto Review has its own model/effort form under Codex, for either source; choices use the same advertised-effort policy and preference storage as the CLI. First source setup initializes the review choices atomically; later conversation-model saves preserve the saved review choice, and review changes use their own Save button. The GitHub model environment override is shown and locked. Microsoft 365 enable/disable stays under Model sources; disabling confirms that Claude local access stops, unchanged CCDX-owned settings are restored and Codex returns to GitHub. Active requests still block disabling.
Existing active streams keep their Provider binding. User/organization client
configuration is not overwritten by browsing or by a pause operation.

Top Refresh updates local evidence and open data groups, plus current-page settings.
Auto-refresh defaults on and is browser-local. Small status snapshots update about
every two seconds; source/settings evidence updates every eight status ticks.
Catalogs and retained usage load only on demand or in their open view, with the
existing 30-minute cadence and short freshness gate. Hidden pages stop scheduled
reads. Catalog requests are deduplicated, stale tab reads are cancelled and late
results rejected. Failed reads preserve last-good data and label it as stale.
Service-setting errors are visible on the current page and can be retried manually.

### Settings saving and restore

Settings → **Save & restore**, after Version & updates, controls only this page’s
preferences. **Save changes automatically** defaults on. Terminal palette,
animation, animation enablement, opening the webpage at startup and overnight-update
preferences save after a short coalescing delay. Webpage appearance stays in the
current browser. Turning automatic saving off reveals Save changes and Discard
changes; enabling it with a draft asks before saving that draft. Invalid or failed
saves keep the draft. Polls do not overwrite drafts, old responses do not replace
newer edits, and a conflicting settings revision requires reviewing the current
settings. Ordinary appearance saves do not enumerate accounts, authenticate or
refresh provider catalogs. Overnight updates remain off by default and enabling
them confirms the existing restart risk; saving the preference never installs an update.

Restore defaults confirms the scope, backs up the saved preferences first, then
writes the settings-page fields in one locked atomic transaction. Defaults are:
green webpage and terminal palettes, dark webpage appearance, Comet animation,
terminal animation on, open webpage on startup, overnight updates off and automatic
saving on. Language, model/source selections, API keys, native sign-in and client
configuration, review/memory choices, image/prediction access, history, usage and
network/environment policy are preserved. Environment-controlled effective values
remain controlled. Pending drafts are explicitly discarded only after confirmation.

The private `settings-preferences-backup.json` beside the settings file contains
only the six allowlisted service preferences, version, ID and creation time; it
contains no credentials or provider settings. Restore backup uses the latest
pre-reset snapshot. Backup failure aborts reset; a failed settings write restores
the prior settings and prior backup. A repeated reset with its same operation ID
cannot overwrite the original snapshot after a lost response. Unreadable settings
or backups are preserved and reported.

Browser appearance has its own origin-local backup linked to the operation ID.
At most two entries are held while a reset result is uncertain, reducing to the
matching latest backup after a confirmed settings read. Service and browser storage
are not one atomic transaction: a browser-storage failure after the service save is
reported as partial completion and can be retried. Another browser without the
matching appearance backup reports that limitation rather than claiming a complete
restore. No periodic backup service, credential export or full configuration reset
is added.

The full `/_ccdx/status` response remains the default CLI/diagnostic contract.
Overview and Settings use an explicit `?scope=summary` projection containing service
identity, uptime, model activity and current-run usage. The browser keeps summary
and full reads in separate resource entries; summary data cannot replace request
history or turn missing full fields into zero values. Other pages request full
status when opened. Hidden data regions skip DOM work, retaining their last data
until a visible full read; native inference and the selected model are unaffected.

The usage selector retains current and historical sources. Combined model rows
and daily analytics preserve source identity; old records without a client label
are not guessed into one. Legacy untagged Provider records retain their historical
GitHub attribution. Cache-read tokens are included in input, not added twice.
The separate current-run summary updates from returned usage in memory, without
rescanning retained logs at the status cadence.
Overview adds an approximate token cache hit rate: returned reused input tokens divided by returned input tokens, weighted by tokens rather than request percentages. Missing evidence is distinct from an explicit zero; all-unknown cache evidence, zero input and invalid counts display `—`. Mixed complete/incomplete cache evidence displays `~` before the recorded aggregate ratio. This describes recorded input reuse, not a request success ratio, invoice or whole-account cache statistic. Missing output alone does not invalidate usable input/cache evidence.

The usage source selector applies to the whole page. Model selection controls both daily trends and the calendar; 7/30/90-day range and bar/line view belong to daily trends, and request/Token measure belongs to the fixed annual calendar. These controls do not redefine the all-history model table; selecting a known day narrows the table and Show all restores retained-history totals.

Usage analytics remains collapsed until opened: 7/30/90-day charts and a bounded
365-day calendar in the browser time zone. Model/range/day selection reuses its
snapshot. Days outside retained history are distinct from zero recorded activity.
Filters, chart nodes and unsaved animation selection survive unrelated refreshes.
Dark/light, English/Chinese and reduced motion remain supported. Language changes
translate page labels in place without fetching models or rebuilding charts;
commands, identifiers and upstream error text retain their original values.
Chart view defaults to Bar chart on each page load; its dropdown switches to Line chart without another request or log scan. Both views retain the same input/output values, scale, model/source/range filters and date selection. Lines show separate input/output series, pass through each known day's value, stay between neighboring values and break across unavailable history; a lone known day is a point. The calendar is unchanged by view switching.

Visible bar stacks rise from the baseline once over 450 ms; curves draw left to right over 600 ms (a lone point fades in over 200 ms). Opening/revealing a chart and changing its data, filters or view can replay the entrance. Selecting a day, changing calendar measure and unchanged background refreshes do not replay it. Hidden/collapsed views, page suspension and reduced-motion preferences cancel active chart motion; reduced-motion or unsupported animation APIs retain the complete static chart. Chart motion adds no polling loop, chart library or runtime dependency.

The atom logo stays in the sidebar brand (compact top navigation on narrow screens).
It rotates once on load and manual Refresh, never on scheduled reads, and respects
reduced motion. Terminal animation settings are independent of the WebUI logo.

Startup lists the number of discovered cached/live Provider catalogs, their model
counts and source, and separate Claude Code/App configuration states. Checking,
unavailable, preserved custom settings and uninspected configurations remain
distinct. Background discovery does not delay core readiness; its latest state
appears in the running terminal region. These observations do not prove inference
access. Normal prediction startup uses one line; exceptions retain reasons and
required restart guidance. `ccdx prediction status` retains environment/recovery
details, including routing, CA and TLS verification state.

After Ready, a supported TTY has a bounded region: uptime, source/Claude state,
a line-framed usage/inference table, one notice row and one activity row below it.
Input includes reused input; partial usage counts returned records with missing fields.
Inference HTTP calls exclude catalog/count-tokens requests; model outcomes are
separate protocol observations, not an HTTP-success total. Activity motion includes
image MCP traffic; inference counters exclude it. Usage is process-local returned
data, not a bill or pending estimate. Counts/tokens use compact display.
Data refreshes about once a second; animation ticks reuse the table and redraw only
changed rows. Historical notices do not turn a running service into a health verdict.
Client cancellations remain in verbose/file diagnostics as informational records;
timeouts and actual failures remain notices. Non-TTY, CI, dumb and terminals under
40 columns or 16 rows retain plain output. At 40×16 the compact table keeps all metrics and short source/Code/App states. Larger terminals wrap full state descriptions. No runtime terminal dependency is added.

Terminal appearance lives only in Settings. Preview frames load on opening; closing, hiding the view/page or reduced
motion stops preview timers. Saving changes the running supported status terminal.

The recent-failure view merges bounded Responses events, main-listener HTTP
failures and recent Responses/compact/Messages request timelines, with at most ten
visible entries. Request IDs correlate final outcomes; a retry alone is not proof
of recovery. It is diagnostic metadata, not a session archive. Original error
responses remain unchanged. Review upstream diagnostic prose before sharing.

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

The dashboard's **RECENT REQUESTS** section opens by default and reuses the same
status snapshot. It shows at most 20 finished request observations: time, source, model, outcome and returned input tokens, with serialized
upstream payload bytes, image count, reported input tokens, the advertised model
window and terminal outcome, plus process-local compaction outcome counts. Missing
fields are unknown, not zero; input/window is a reference ratio, not an exact live
session measurement. No prompts, image bytes, files, tool results or extra session
scan are retained. Technical fields are folded into each row. Expanded fields survive unchanged reads and retained matching request observations; closed/hidden request groups defer row rebuilding without another API call.

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

## Account and repair tools

`ccdx auth` defaults to local status. `auth check` is the explicit online alias: it checks GitHub identity, Copilot authorization and a bounded model directory without inference. `auth status --online` remains available. A saved file is not proof of online access. Copilot denial and network failures do not recommend reauthentication merely because access failed.

`ccdx auth login` starts GitHub device authorization when no sign-in is saved. `ccdx auth reauth` / `ccdx reauth` explicitly replaces an existing sign-in. `auth login --reauth` is also accepted. The existing account binding is required by default; `--login ACCOUNT` explicitly requests a different account, which needs a service restart before it can become the running inference account. The device request has a 30-second deadline, GitHub's interval/slow-down responses govern polling, and the device lifetime is limited to 15 minutes. Candidate identity, entitlement and directory validation has a 15-second deadline. No candidate is saved before all checks pass. A final cross-process lock and comparison prevent overwriting a concurrently changed credential. Cancellation, denial, mismatch, expiration or validation failure preserves the prior sign-in. One WebUI flow runs per service, with a 30-second minimum between starts; connection checks coalesce and retain a same-credential result for 10 seconds.

New explicit-tool sign-ins use `~/.local/share/ccdx/github_token` and fingerprint-bound `.account.json` metadata, with private permissions and the existing atomic paired writer. When present, this owned store takes precedence over `~/.local/share/copilot-api/github_token`; existing startup/discovery compatibility remains supported. `auth logout` requires interactive confirmation or `--yes`, writes an empty owned credential, and does not delete or revoke other apps' legacy credentials. This intentionally blocks inference's legacy fallback. New login or normal startup can perform the existing explicit discovery/sign-in process again. CLI changes notify a compatible running local service; if notification is unavailable, the CLI asks for a service restart. In-flight model requests are not replayed or forcibly stopped. A token cache invalidation preserves its running account binding, so switching accounts still requires a restart.

Model sources uses one source selector for the selected source controls, account and catalog. Disabled sources remain under its collapsed list; there is no second list of enabled source cards. Selecting a tab is browsing only. GitHub offers sign-in, independent connection checks and cancellation; sign-out is under More actions. The browser opens only the fixed GitHub device authorization URL after the user chooses Open GitHub. No token or password entry field is added. Microsoft 365 retains local account discovery/selection and source controls; its corporate SSO is not replaced with a GitHub-style login. Raw codes remain under details and last-good model lists retain their previous timestamp after failures.

`ccdx web` opens an existing compatible dashboard or starts a management-only local listener without sign-in, app configuration, app launch, prediction setup or automatic M365 startup. It does not claim normal startup integrations are active. Stop that management listener with Ctrl+C before running normal `ccdx` for application routing and optional integrations. Opening the dashboard does not initiate a GitHub Device Flow or model inference.

Checks & repairs performs the existing local doctor checks without adapter/client online checks. Configuration repair uses the existing owned-key writer: the preview lists scope and backup filename, a revision check rejects changes since preview, and the writer rechecks that revision under its existing config lock. It preserves unowned TOML and refuses invalid/unsafe configurations. A changed existing file is backed up as `config.toml.ccdx-doctor.bak`; an unchanged file or a missing original has no previous file to back up. The page does not expose arbitrary commands, forced restarts, certificate setup or an automatic repair loop. Compatibility probes remain the explicitly displayed `ccdx doctor --compat` command and consume usage.

`ccdx doctor network` and the page's Network settings read proxy/trust summaries without external HTTP requests or policy edits. Linux reports environment routing; Windows/macOS also inspect their supported system settings. `ccdx doctor report` prints the local report as JSON; Export report downloads the same bounded redacted projection. Home paths and account email addresses are replaced, and credentials, arbitrary check fields, chats and request bodies are omitted. Reports include only local checks, not a full network trace or proof of provider entitlement.

`ccdx image pause|resume` and `ccdx prediction pause|resume` use the existing service preference gates. They keep credentials, trust and routes and cannot provision a feature that has not been configured. Running image requests may finish. Offline changes apply on service startup; online prediction adaptation uses the running service's settings action. The existing full `disable-image` / `prediction off` cleanup semantics are unchanged. `ccdx source` is an alias for `ccdx m365 switch`, with the same model validation and explicit selection rules.

The protected `/_ccdx/ui/account` and `/_ccdx/ui/checks` APIs require loopback, a local Host and `X-CCDX-Dashboard: 1`. POST actions additionally require the matching Origin and JSON content type; bodies are capped at 4 KiB with a five-second body deadline, and unknown actions/fields are rejected. GET reads only local/process state. Sign-in polling GETs read in-memory operation state and do not trigger extra GitHub polling. Device-flow controllers are cancelled when the owning listener closes. SVG state icons are shipped locally and load no external icon library; an empty circle means unknown/not checked, a circle-minus means unavailable, and running uses circle-play rather than the success check.

## HTTP error diagnostics

`http_errors.recent` keeps its 20-record rolling view. Independent
`actionable_recent` (20 generation/other failures and actionable count errors),
`capability_recent` (20 count/explicit-access notices), `route_recent` (eight path errors)
and `protocol_recent` (eight image-MCP HTTP 405 records) prevent route/method noise from erasing inference
evidence. `by_category` counts inference, capability, protocol, route and other HTTP failures;
classification does not discard errors, grant access or retry requests.
The WebUI defaults to reply issues and provides separate capability/access and connection/path views. Explicitly unselected models and turned-off access remain refused with their original HTTP status, but are notices rather than model-generation failures. Client disconnects remain in recent requests rather than being promoted to the issue list. Known non-model HTTP paths show Not applicable in the UI; unknown paths are retained, not assumed harmless. Repeated capability/path notices are grouped within the bounded retained records, with their occurrence count and latest request details; raw HTTP counters remain visible. A count-endpoint 404 is not a failed generation. Count authentication, rate-limit and server failures remain actionable.

Before model resolution, safe requested model IDs and the client hint are retained even for local rejection. Known binding failures include a specific reason: model not selected, ambiguous name, unavailable catalog entry or disabled access. These diagnostics never authorize a model or replace it with a default. Claude records propagate the actual model/source and distinguish a cached capability result from an upstream HTTP failure. Upstream attempts count logical calls; shared counts are marked `shared_upstream`, and cached 404s report zero calls. No prompt or key is retained.

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
- Explicit auth tools store GitHub OAuth credentials at `~/.local/share/ccdx/github_token`, with precedence over the compatible legacy `~/.local/share/copilot-api/github_token` store. Short-lived Copilot service tokens remain in process memory and are refreshed as needed. See Account and repair tools for safe replacement/sign-out behavior.
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


### Live request flow and timing estimates

Request flow is a read-only view of active Responses, Responses compaction and
Claude Messages requests observed by CCDX; it excludes image-MCP, token counting,
catalog and management calls. It groups
apps and source/model pairs; a model used through two sources stays separate.
`X-CCDX-Client` recognizes `codex-app`, `codex-cli`, `claude-app`, `claude-code`;
known Codex `originator` values also provide labels, including the actual
`Codex Desktop` spelling. Explicit client hints take precedence, followed by known
originators, then known versioned Codex User-Agent prefixes. A generic `codex`
prefix identifies only the Codex family, not App versus CLI. Unknown clients are
shown as Unidentified app (the existing `api` metadata ID is retained); unmarked
Messages requests remain Claude (app unspecified). These are client-reported
presentation hints, never verified identities, authorization or routing inputs.
Only bounded scalar strings are inspected; no User-Agent/header text is retained.
An unrelated agent containing the word Codex does not match.

Only observed first output starts moving dots. A started attempt without output
is waiting, a subsequent attempt is retrying, and terminal evidence awaiting
connection completion is finishing. No fresh status for six seconds means unknown,
not idle or successful. Auto refresh off therefore expires the view. Hidden pages
pause animation; reduced-motion uses static dots. Idle retains bounded last-known
nodes with zero counts; unknown retained counts are dashes. Initially up to 12
model groups are visible, with an explicit show-more control. Snapshots retain up
to 64 details per metrics instance; exact active totals may be higher and omitted
details are reported. With omitted details, observed group counts use ≥; retained
nodes with no current detail use dashes, even while the exact total is active. Short requests between two status reads can appear only in
the finished table; the diagram does not fabricate or replay them.

A single app/source-model route has aligned name/hub anchors and straight paths,
even when multiple requests share that route. Branches alone use rounded curves.
Known singleton and idle-zero node counts are hidden. Concurrent counts read
“2 requests” beside the name and outside its selected area; lower bounds retain ≥
and missing/stale counts remain dashes. The exact active total appears once in
the flow header, not again below the logo.

Clicking an app or model name filters only active details. Counts, source totals,
all five terminal outcomes (including unknown), last 20 finished requests and
issues remain available. No prompt/image/credential is added to active telemetry.
The existing local-dashboard host/origin protections apply to the new flow asset.

Codex and Claude request-performance panels show approximate first-output P50/P95
in milliseconds with sample counts. Values come from existing histogram buckets,
not raw samples; the highest bucket uses the observed maximum. These are the
upstream first-output observations already used for the mean, include failures
after partial output, and do not measure user-perceived completion or promise a
routing improvement. No samples displays a dash.


### Account shortcuts and compact toolbar (1.2.12)

Checks & repairs offers equal-height GitHub account / M365 account shortcuts.
Both open the corresponding model-source page; neither starts a connection check,
account enumeration, login or model call. Actual checks stay on that source page.
The M365 shortcut retains link semantics and the shared button appearance.

Auto refresh has content-based width, sized for the longer localized on/off label
so toggling it does not shift nearby controls. The language control has a 40px
minimum width, cannot flex-shrink and keeps 中文 / EN on one line. Compact toolbars
wrap when required rather than compressing text; header position remains stable
between modules in the same language and viewport.

### Application editing and keyboard behavior (1.2.20)

Codex, Claude App and Claude Code keep separate page-local model/default/sync
drafts. Switching clients, navigating within the dashboard or reading current
settings preserves unsaved drafts. Save and Discard changes affect that client
only; reloading the browser discards page-local drafts. Model selection restores
focus to the corresponding checkbox/default button. Add API focuses its first
field; Cancel restores the entry control. Narrow layouts stack source, context
and reasoning below each model while retaining the same table semantics.

Reading a catalog marks only its Read models button busy and offers Cancel.
Cancelling leaves the editor and its draft intact. No inference is sent. Source
saves report persistence separately from subsequent metadata refresh. Background
read failures retain existing messages; key read/save states use polite live
announcements. Account labels and values stay paired, and request summaries use
configured source names. Technical IDs remain available in request details.

### Codex App updates and model selection

After an App update, completely quit and reopen the App once if the model list is
empty, then inspect `ccdx doctor`. On macOS, doctor reads bundled CLI package
metadata and the optional model-cache version without executing a binary or
altering the cache. A version mismatch is a diagnostic hint; it does not prove
that the cache caused a failed catalog. HTTP catalog `models` and app-server RPC
`model/list.data` are different layers, not evidence by themselves of a format
regression between client versions.

The Responses WebSocket protocol is not implemented by CCDX. Upgrade requests
are refused promptly so supported native clients can fall back to HTTP/SSE.
This is tested separately from model-directory and provider-identity behavior;
SSE events are not relabeled as a WebSocket protocol.


### Nightly updates (opt-in)

Available from 1.2.22 after one manual upgrade. Settings → Version & updates →
Update overnight writes the boolean `nightly_updates`, false when absent. Enabling
it requires a normal CCDX restart; disabling it cancels pending automatic work in
a supervised service. Management-only `ccdx web` never installs updates. The risk
text explains that automatic installation/restart can affect conversation
continuation. The feature does not promise zero downtime or infallible rollback.

Only an owned, writable npm installation with recognized command launchers can
use the supervisor. Standard execution stays unchanged when disabled. When enabled,
a foreground parent runs the gateway from an immutable private package tree;
Ctrl+C stops both, and no launchd/systemd/Windows service or boot task is installed.
Stopping CCDX, sleeping or powering off does not start a separate updater. After
a long observation gap, a new ten-minute idle interval is required.

The parent observes bounded local state once a minute. A release check occurs at
most once per local calendar day, within 00:00–04:00, after ten observed idle
minutes. The new version must be a stable patch in the same major/minor series
and have been published at least 24 hours earlier. No prerelease or automatic
minor/major migration is accepted. Active inference, image work, configuration
operations, discovery or sign-in defer the update. New work during preparation
also defers it. Checks do not invoke models.

Preparation uses the official pinned GitHub Release tarball and checksum, an
independent npm prefix, the configured registry/proxy/CA/TLS/offline policy and
ignored lifecycle scripts. Existing private-runtime launchers are regenerated;
custom launchers are not silently claimed. No Git, new Node installation,
permission override, certificate change or public-registry fallback is added.
A policy refusal, unavailable dependency or runtime check failure leaves the
current service running. The supported native broker is checked when already
present in the original installation.

Before switching, the parent compares client/configuration fingerprints and
authorized model/default selections, backs up the global package and commands,
and validates the candidate on an internal loopback-only ephemeral listener while
the current instance continues serving. Previously healthy selected sources must remain healthy, every previously
published model must remain available, and defaults/credential scopes must match.
Additional upstream models are allowed. API discovery publication and client
writers are paused during this warmup. Only then is the old gateway quiesced.
A bounded private IPC message transfers Responses
history, source-scoped parent links/opaque items, image-edit references and
already-cached API keys limited to unchanged configured references.
Conversation payloads, image references and cached keys are never written to a
handoff file or diagnostics. Ordinary process-local counters begin a new run;
retained usage files remain available.
The combined serialized state is limited to 64 MiB; oversized/busy state defers
the update without eviction. New requests during the brief switching interval
can receive a temporary failure with `Retry-After: 1`.

The warmed replacement imports state before taking over the same main port. Its
maintenance startup preserves client configuration, skips interactive GitHub
login, and opens neither browser nor client. Model/default selections and
configuration fingerprints must match before it accepts normal traffic. Failed
startup, discovery or a mismatched candidate leaves the original instance
alive. A failed port/prediction handover attempts package rollback and resumes
that same instance with its original caches. Cleanup of a retired runtime is
best-effort; pending cleanup suspends further automatic transitions. The old
process is retired only
after the replacement has acknowledged acceptance. A deliberate Ctrl+C
never starts another worker. Unexpected later worker exits are reported once;
this is not a general crash-respawn mechanism.

The private `nightly-update-state.json` beside settings stores only the attempted
local day and paused version. Installed candidates that fail verification are
not repeatedly attempted; a newer version or explicit manual update is needed.
Unreadable records pause automatic updates without stopping the gateway. A
failed package rollback or failed restoration can require manual recovery;
Settings retains the full platform installation commands.

### Web resilience and resource versions

Optional status/usage/animation views contain local initialization/render errors,
retain the surrounding shell and expose a local retry. Retry replays only the
latest bounded call state per view method. Network errors retain their existing
last-successful snapshots and explicit unknown/error status. Request-flow detail
rows are keyed and updated in place, retaining selection and DOM identity.

The flow atom's thin ring is static while idle and rotates once per five seconds
while fresh active requests are observed, including waits/retries. The atom itself
does not rotate; counts do not accelerate the ring. Hidden/stale views stop it,
and reduced motion disables rotation. Existing curves, tables, palettes,
client identification and authorization remain unchanged.

Static dashboard bytes are snapshotted together on first use and reused by the
process. HTML remains `no-store` and stamps script/style URLs with the service
version. Other assets use content-derived ETags and `no-cache` revalidation;
matching validators return 304. A mismatched version query returns 409 rather
than mixing resources, requiring a page reload. If the installed package changed
before a coherent bundle could be loaded, the optional page fails explicitly;
inference remains separate. Protected JSON/account/settings routes stay
`no-store`. No API-body caching, compression worker or new dependency is added.

`CCDX_SUPERVISED_SERVICE` is an internal inherited worker marker. It is used only
with a private parent IPC channel; do not set it as a user preference. It grants
no network action and is not a replacement for the saved nightly-update opt-in.


### Manual API token counting

Messages support does not establish support for `POST /v1/messages/count_tokens`.
CCDX forwards the configured Messages endpoint plus `/count_tokens`. A manual
API's observed HTTP 404 is remembered in memory for 60 seconds, separately for
each model and Anthropic version/beta-header scope. This is an observed endpoint
failure, not a declaration that the model source is down. Cached and initial
results return HTTP 404 with `ccdx_api_count_tokens_unavailable`; no estimated
or synthetic count is returned. Changing the source configuration/key creates
a new scope. Other statuses, including 401/403/405/429/5xx, are not cached by
this compatibility mechanism; status and safe Retry-After metadata survive.

Identical concurrent count requests share one bounded upstream operation.
Each caller cancels independently; the last cancelled waiter aborts shared
work. Before a model/header scope has a capability observation, distinct inputs
wait for its first real admitted count request. An observed 404 is reused by
those waiters; success is reused only for identical inputs. Distinct inputs
then run their own counts. Capability waiting has at most 16 in-flight scopes
and remains under normal gateway body/queue admission. Capability waiting and
the caller's own count share its existing upstream timeout budget. Identical-result sharing
is limited to bodies up to 1 MiB, 16 operations and 4 MiB of shared request text.
Larger supported inputs and overflow use their normal admitted path. Count responses are capped at 64 KiB. At most 128 capability observations are retained. A 404 expires after one
minute; a positive observation permits normal concurrency and a later 404 can
replace it. Successful results and request bodies are not retained
after the operation. Counts neither invoke generation nor fail over to another
source. This does not supply a missing tokenizer or guarantee every Claude App
context-management feature on a third-party model.

Background manual-API catalog failures back off for 1, 5, 30 and then 120
minutes; successful publication resets the sequence. Explicit refresh retains
the existing one-minute minimum interval rather than the longer background
backoff. A valid upstream Retry-After also applies, bounded to 24 hours. These
are read eligibility gates, not added background retry timers. Revision changes
invalidate prior eligibility and obsolete results never publish.

Claude Code's validated `x-claude-code-agent-id` separates a child task's local
source guard from its parent's guard when a session is identified. Parent keys
without that header remain unchanged. This header is correlation only: model
access and the company's account/history checks remain authoritative.


### Upstream maker metadata

Manual API discovery accepts bounded text from publisher, vendor and owned_by.
The model maker shown in lists/details prefers publisher, then vendor; owned_by
is shown separately as ownership and is not treated as the maker. Absent maker
information is Not provided; no name-based inference is performed. These are
upstream declarations, not proof of backend identity.

Rebuildable per-source files under `api-model-display/` beside settings are
scoped by source ID and deployment revision. They preserve at most 500 models,
512 KiB per file and 16 in-memory sources. They contain only model IDs and
identity declarations, no key or response body. Old versions ignore them;
connection v2 metadata remains readable during rollback. The new read-only
`model_display` source field and per-discovery `display` field are ignored if
round-tripped into Save API; unknown configuration fields still fail validation. Missing display
evidence triggers the existing normal catalog read rather than requiring key
entry or model reselection. Failed discovery retains valid prior evidence for
the same revision; invalid optional display cache does not block inference.

### Memory-extraction dependency notices

The Codex model editor reads [`memories.extract_model`](https://learn.chatgpt.com/docs/customization/memories#configure-local-memories) when explicitly configured
in the native Codex config. Otherwise, it may show a recently observed extraction
model from a bounded read-only correlation of native Phase 1 task failures and
one unambiguous local HTTP 400 model. No prompt, memory text or model-name
heuristic is used. Explicit configuration is labelled Configured in Codex;
observations are Recently observed. The current client does not expose its
compiled default in the queried interface, so CCDX does not label a guessed
model as Codex default. With memory generation explicitly enabled but no model
evidence, the editor shows Chosen by Codex and Default model ID not available;
this does not infer a model from the checked model list or claim a successful
memory write. With generation explicitly disabled it shows Memory generation is
off. Unknown generation state and no model evidence remain Not detected.

The optional native log helper runs only on startup/connection-view reads (including an explicit WebUI refresh),
coalesced and at least one minute apart, with a 2.5-second limit. It reads up to
eight task records and sixteen candidate HTTP records each, clipped to 8 KiB,
from the prior 24 hours. It uses the bundled Node SQLite API in a separate
read-only process; missing/locked/unsupported stores remain optional. Only a
model ID and observation time can enter `codex-memory-observed.json`, scoped by
the Codex profile, with a 24-hour freshness bound. No periodic log scanner,
account lookup, native Codex process or inference is started by this helper.

Closing a known extraction model or its source in WebUI prompts about new-memory
generation and preserves your explicit decision. The draft is separate from the
saved selection. Existing memories are not deleted. Native memory generation
settings, model aliases, defaults, authentication and authorization are not
changed to satisfy a dependency. Confirmations are WebUI guidance, not a new
requirement on existing CLI/API operations. A notice does not identify every
background task or prove that memory generation succeeded.

### Messages stop and network evidence

Recent Messages records retain declared context size, requested and forwarded
output budgets, normalized returned input/output usage, and an allowlisted stop
reason when supplied. Missing values remain unknown. `max_tokens` is shown as
output-limit termination; CCDX does not raise an undeclared GLM output limit or
use context length as an output ceiling. HTTP success and complete generation
remain distinct.

API transport errors retain fixed safe code, DNS/connect/TLS/request/response
phase and reused-socket state in HTTP diagnostics. They do not retain raw
exceptions or URLs, and do not trigger automatic POST or cross-source retries.
