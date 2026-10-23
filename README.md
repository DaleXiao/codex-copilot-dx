# codex-copilot-dx

CCDX connects Codex App to GitHub Copilot by default: discovery, adapted model catalogs, Responses streaming, tool calls and conversation history. Eligible Microsoft 365 environments can also use a protocol-isolated Claude gateway on the main listener and manually select M365 as a Codex backup. Default Auto-review: **GPT-6.1 Sol / low**. Image generation is **off by default**. Native predictions are also **off by default**.

## Install and run

For Codex App, use macOS or Windows and a GitHub account with access to the desired Copilot models. With Node.js **22.15+** and npm already available:

```bash
npm install -g codex-copilot-dx@latest
ccdx
```

No Node or Git? Download [install.sh](https://github.com/DaleXiao/codex-copilot-dx/releases/download/v1.2.14/install.sh) (macOS/Linux) or [install.ps1](https://github.com/DaleXiao/codex-copilot-dx/releases/download/v1.2.14/install.ps1) (Windows), then run `sh install.sh` or `./install.ps1` under your current shell policy. The bootstrap reuses compatible Node/npm or installs verified official Node 24.22.0 privately for CCDX. It adds no Git, compiler or system package manager. It keeps registry/proxy/certificate policy, verifies the Release package and installed runtime, and restores the prior CCDX package if installation fails. Dependencies still need your configured registry. See [installation limits and private command paths](docs/REFERENCE.md#install-without-node-or-git).

CCDX reuses a compatible local credential or starts GitHub Device Flow, listens on `127.0.0.1:2026`, configures Codex, and opens the App. Interactive desktop starts also open the local WebUI once; use `ccdx --no-browser` or disable this in WebUI settings. No client binary patch is needed. On Windows, open the App manually unless native prediction setup is enabled. In restricted Windows PowerShell, use `npm.cmd` to install and `ccdx.cmd` for the first launch, or run `ccdx.cmd doctor --fix`. Startup, updates and explicit repair remove only CCDX's exact npm-generated `.ps1` launchers so later calls can use `ccdx`. The npm package adds no install hook or policy change; custom launchers are preserved. npm's own script is untouched. The configured `dummy` API key is a placeholder, not a credential.

The [local control console](http://127.0.0.1:2026/) separates Overview, Codex/Claude, Model sources, Usage, Requests, Checks & repairs and Settings, with a stable sticky header. Settings owns API/client access, independent web/terminal colors (classic green, Klein blue or Soft pink), startup and updates. Accounts and model catalogs stay with Model sources; client-specific tools stay with their application. CLI remains English; WebUI supports English/Chinese. An interactive terminal shows bounded startup checks, source/client state, a usage table with approximate cache hit rate, notices and animation. Plain/NO_COLOR/narrow output remains supported; `--verbose` retains request detail.

Requests shows live app/source/model flow above existing summaries and finished records. Usage offers animated bars or curves; reduced motion stays static. Hidden pages stop scheduled reads; status refreshes about every two seconds and source/settings evidence about every 16 seconds. Catalogs and retained usage load on demand or every 30 minutes while open. The UI does not add inference calls. Ready means local service availability, not verified model access. First output uses ms, speed token/s, and partial/unknown usage remains explicit. Images/predictions stay opt-in; their first setup uses CLI. See the [control reference](docs/REFERENCE.md#control-console-and-online-settings), [1.2.14 changes and verification](https://github.com/DaleXiao/codex-copilot-dx/blob/main/docs/RELEASE_1.2.14.md) and [copy inventory](https://github.com/DaleXiao/codex-copilot-dx/blob/main/docs/UX_COPY.md).

## Commands
| Command | Purpose |
| --- | --- |
| `ccdx help` | Command help; use `ccdx help <command>` for details |
| `ccdx start` | Start/reuse the adapter, open Codex when enabled, and open WebUI on interactive desktop starts |
| `ccdx --no-browser` / `ccdx --verbose` | Skip WebUI opening once / retain detailed terminal logs |
| `ccdx status` | Runtime, limits and bounded request diagnostics |
| `ccdx doctor` | Configuration, adapter and read-only App/catalog diagnostics |
| `ccdx doctor --fix` | Repair owned launchers/config, recover existing auth and enabled prediction routing once |
| `ccdx doctor --json` | Redacted structured diagnostics; combines with `--fix` |
| `ccdx doctor config` | Read-only configuration check |
| `ccdx doctor --compat` | Online inference/continuation compatibility probes |
| `ccdx auth status` / `login` / `reauth` / `check` / `logout` | Inspect, verify or safely replace CCDX sign-in; other apps stay signed in |
| `ccdx models` | Current source models; manual APIs show configured models without an online probe |
| `ccdx usage` | Recorded tokens and upstream prompt-cache hit rate |
| `ccdx usage --provider ID` | Filter current or historical source-specific usage |
| `ccdx m365 status` / `models` | M365 authorization, Claude gateway and Claude models |
| `ccdx m365 accounts` / `account` | List local company accounts or select one; `account --id ID` supports scripts |
| `ccdx m365 switch` | Choose the Codex source; default remains GitHub |
| `ccdx m365 on` / `off` / `remove` | Enable discovery, restore owned client settings, or remove owned M365 state |
| `ccdx auto-review-model` | Select model, then reasoning effort; `0` follows client |
| `ccdx animation` | Preview and select terminal animation |
| `ccdx prediction fix` | Recheck system routing and repair enabled predictions; report required restarts |
| `ccdx cache --limit 128` | Set the history-cache budget in MiB |
| `ccdx cache --clean` | Clear the rebuildable image-transform cache |
| `ccdx limits --decoded 256` | Set the decoded request-body budget; restart to apply |
| `ccdx enable-image` | Opt in to image generation/editing with your own API |
| `ccdx image-status` / `ccdx disable-image` | Check or disable optional images |
| `ccdx prediction on` / `off` / `status` | Opt in to native predictions (macOS and Windows) |
| `ccdx update` | Update the global package |

## Add your own API

Run `ccdx web` without GitHub sign-in. In **Settings → Model sources → Add API**, enter the HTTPS address/key and declare each model's real interfaces. Save, allow clients, then choose their **Current source** under **Clients**. Claude App/Code use Messages; Codex uses Responses, all on port 2026. Reopen clients for first setup and start a new conversation after source/key changes. To use Claude alone, close Codex access. Stop management before normal `ccdx` startup for the live terminal.

Keys use system credential protection or an explicit environment reference; clients receive separate local credentials. Saving does not probe models or select routes. Disabled sources/clients leave normal views and can be restored from **Disabled**, retaining grants/configuration without selecting a source. Closing client access does not quit its app. In-use sources require explicit replacements or pauses; pinned API requests finish on their original source. Existing user/managed app settings remain protected.

There is no automatic fallback, cross-source replay or Chat-only protocol conversion. Configured models are not verified online entitlement; unknown models have conservative metadata. No runtime dependency or enterprise policy exception is added. See the [complete API, credential and client reference](docs/REFERENCE.md#manual-apis-and-client-access).

## Microsoft 365 access

Eligible macOS/Windows machines attempt silent Microsoft authorization at startup, without Copilot CLI or a browser login. MDM alone is insufficient: account, tenant,
device policy and Loki entitlement must permit access. Optional failure does not block GitHub. Saved bindings stay selected; unresolved company accounts can be chosen under **Model sources → Microsoft 365** or `ccdx m365 account` in the updated running service. Listing is local; changing accounts validates only the selected account, affects M365 in Codex/Claude and requires new conversations. See the reference for identity and history limits.

Claude clients use `http://127.0.0.1:2026/anthropic` (or the configured main port), a private local gateway key and a Claude-only catalog. No second Claude listener is opened. Existing unchanged CCDX-owned 2027 addresses migrate automatically; hand-written or managed addresses are preserved and need explicit migration. The optional prediction CONNECT/PAC bridge remains a separate transport.
Existing custom/managed settings are preserved; already-running clients may need a normal restart.
Canonical Claude IDs and advertised effort caps refresh only in unchanged CCDX-owned settings. User and managed choices are preserved; supported App versions can update model knowledge through Anthropic's signed catalog. New protocol semantics may require a client or CCDX update. See the [model reference](docs/REFERENCE.md#claude-gateway-and-client-ownership).
`ccdx m365 off` restores unchanged owned fields; `remove` also clears owned M365 state. With managed client connections, off pauses affected bindings instead of selecting another source; removal retains shared client-ownership records needed by manual APIs.

Codex stays on GitHub until `ccdx m365 switch`. Select available GPT/review models;
there is no automatic failover or missing-model substitution. Use **Standard** on M365:
Fast is unverified. Tokens, accounts and review choices are isolated; prediction and images remain independent.

The optional native broker adds a **14.6 MB download**, with no install hook. Linux retains core support without M365.
See the [M365 reference](docs/REFERENCE.md#microsoft-365-provider) for ownership, cache/experimental-feature limits and cleanup.

## Compatibility and safety

- Standard/Fast follow the exact variants advertised by Copilot; CCDX does not
  invent Fast availability. Auto-review is separate from the foreground model.
- Model discovery does not prove inference access. If a new model is absent in
  Codex, run `ccdx doctor`; fully quit the App (**Command-Q** on macOS) before reopening.
  CCDX does not claim it can verify the App's internal model cache externally.
- After a package upgrade, restart the running CCDX adapter. Choosing a model or
  effort on a current adapter takes effect on its next Auto-review request. Native prediction ports persist on macOS/Windows; an older random route may need one full App quit. A busy saved port disables only predictions.
- `0.9.28` adds verified local plaintext recovery after connection-owned compaction rejection; see the reference for strict source and safety limits. Request-body bytes, local-history bytes and the model's token window are
  different limits. Request-context figures are observed metadata, not exact
  live session occupancy. Prompts and images are not retained by that panel.
- `ccdx cache --clean --history` also clears active response history and can
  break continuations. Generated images and Codex transcripts are not deleted.
- Optional image setup/maintenance never blocks the primary service. Disabled
  users get no CCDX image skill or MCP installation.
- Missing-token discovery includes legacy OpenCode Copilot OAuth and GitHub CLI. Reads are bounded and account-matched; incomplete/network-failed or HTTP-403-blocked discovery does not start another login. The default saved credential is preserved; Copilot 401/403 alone is not proof that it expired. Other apps' credentials stay read-only.
- `doctor --fix` does not start login, enable optional features, change company policy or force-restart Apps. It backs up changed config; missing-token repair can contact GitHub. Partial repairs exit 1. See the reference for exact scope.
- Native predictions are a separate, opt-in compatibility feature. Quit Codex,
  run `ccdx prediction on`, then restart CCDX. This adds App-profile certificate
  trust and an App-only route for `chatgpt.com` and `ab.chatgpt.com`; HTTPS on those
  hosts is decrypted locally, but only prediction configuration is changed.
  Other domains and the CCDX model endpoint stay on their existing routes.
  No program files or OS trust are changed. Static HTTP/HTTPS/SOCKS5 proxies and bypass rules are retained.
  Windows supports company PAC/WPAD; macOS dynamic routing remains unsupported. Windows setup needs the official MSIX App, Windows PowerShell and .NET Framework 4.7.2+—not Git/OpenSSL. See the reference for limits.
  Bridge checks allow three same-port recovery attempts per process. The revised PAC adds a loopback retry endpoint after the unchanged primary, preserving company fallback. Quit Codex once to load this route revision; later CCDX upgrades retain it. App prediction failures can remain cached for five minutes, so network recovery is not proof of an immediate suggestion. Only closed, initialized Apps in direct environments receive an owned persistent route; missing routes in running Apps are not hot-attached.
- CCDX adds experimental local history compression only when installed App
  runtimes support it and report it off. Existing choices are preserved; an
  already-enabled default, unavailable runtime or failed check is skipped.
- Image API redirects must stay on the same HTTPS origin. Returned images must
  use public HTTPS URLs; well-known NAT64 mappings follow IPv4 address rules.
- Keep the adapter on loopback. LAN mode is only for trusted networks; do not
  expose it to the public internet. The dashboard is not an authentication wall
  for the API. Inference rejects browser Origin headers; native clients remain supported. Diagnostic errors may contain sensitive upstream text.

Open `ccdx web` for source-specific account tools and Checks & repairs without signing in first. It starts a management-only service when needed; stop it before normal app startup. Safe reauth, config preview/backup, local reports, feature pause/resume and matching circle SVG status icons are described in the [account tools reference](docs/REFERENCE.md#account-and-repair-tools). Existing themes, layout and bilingual support are preserved. Startup checks GitHub's latest-release web redirect, not npm or the anonymous REST quota, and suggests `ccdx update github`. Settings → Version & updates shows the running version, release dates and newer releases, with copyable update and macOS/Windows recovery commands. This separate, cached GitHub metadata check never installs automatically; failed checks remain unknown. See the [reference](docs/REFERENCE.md#version-and-update-information).
GitHub updates verify and install the exact Release tarball without Git; dependencies still use npm's configured registry. Lookup errors identify HTTP refusal, timeout, network failure or invalid redirects. For npm `EALLOWREMOTE`, only if policy permits and the update is trusted, use `ccdx update github --allow-remote`: explicit URL-download permission for that installation's whole dependency tree, not a hostname allowlist. Persistent npm settings stay unchanged.
Updates back up the discovered CCDX package and commands, restore them on install/runtime-check failure, and verify the installed version (exact for GitHub). Mismatched npm targets warn without changing PATH/prefix. Restart the adapter separately. Full `ccdx doctor` reports this target and readonly credential permissions; it never changes ACLs.
Recent errors separate HTTP and model failures. By default HTTP metadata retains status, source and IDs, not error bodies or prompts; original errors still reach Codex unchanged. Explicit, bounded error-excerpt collection is described in the [reference](docs/REFERENCE.md#http-error-diagnostics).

See [architecture boundaries](docs/ARCHITECTURE.md) and the [complete reference](https://github.com/DaleXiao/codex-copilot-dx/blob/main/docs/REFERENCE.md) for authentication, configuration, limits, logging, images and compatibility. It is also included as `docs/REFERENCE.md` in the npm package.

## Development

```bash
npm ci
npm run verify
node scripts/config-startup-replay.mjs
```

Verification covers unit tests, isolated HTTP/idle-stream replay, performance/resource gates and package contents—not an upstream service SLA. CI also tests Node 22.15/24 on Linux, Windows and macOS, temporary-prefix installation/upgrade and installed image processing.

License: MIT.
