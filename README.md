# codex-copilot-dx

CCDX connects Codex App to GitHub Copilot by default: discovery, adapted model catalogs, Responses streaming, tool calls and conversation history. Eligible Microsoft 365 environments can also use a protocol-isolated Claude gateway on the main listener and manually select M365 as a Codex backup. Default Auto-review: **GPT-6.1 Sol / low**. Image generation is **off by default**. Native predictions and nightly software updates are also **off by default**.

## Install and run

For Codex App, use macOS or Windows and a GitHub account with access to the desired Copilot models. With Node.js **22.15+** and npm already available:

```bash
npm install -g codex-copilot-dx@latest
ccdx
```

No Node or Git? Download [install.sh](https://github.com/DaleXiao/codex-copilot-dx/releases/download/v1.2.33/install.sh) (macOS/Linux) or [install.ps1](https://github.com/DaleXiao/codex-copilot-dx/releases/download/v1.2.33/install.ps1) (Windows), then run `sh install.sh` or `./install.ps1` under your current shell policy. The bootstrap reuses compatible Node/npm or installs verified official Node 24.22.0 privately for CCDX. It adds no Git, compiler or system package manager. It keeps registry/proxy/certificate policy, verifies the Release package and installed runtime, and restores the prior CCDX package if installation fails. Manifest-listed complete packages install their bundled dependencies offline; older source-only releases need the configured registry. See [installation limits and private command paths](docs/REFERENCE.md#install-without-node-or-git).

CCDX reuses a compatible local credential or starts GitHub Device Flow, listens on `127.0.0.1:2026`, configures Codex, and opens the App. Interactive desktop starts also open the local WebUI once; use `ccdx --no-browser` or disable this in WebUI settings. No client binary patch is needed. On Windows, open the App manually unless native prediction setup is enabled. In restricted Windows PowerShell, use `npm.cmd` to install and `ccdx.cmd` for the first launch, or run `ccdx.cmd doctor --fix`. Startup, updates and explicit repair remove only CCDX's exact npm-generated `.ps1` launchers so later calls can use `ccdx`. The npm package adds no install hook or policy change; custom launchers are preserved. npm's own script is untouched. The configured `dummy` API key is a placeholder, not a credential.

The [local control console](http://127.0.0.1:2026/) separates Overview, Codex/Claude, Model sources, Usage, Requests, Checks & repairs and Settings, with a stable sticky header. Model sources owns API accounts, keys and model capabilities; application pages own visible models and defaults. Settings owns independent web/terminal colors (classic green, Klein blue or Soft pink), plus a WebUI-only Pure white palette with an inverted black night mode, startup and updates. Accounts and model catalogs stay with Model sources; client-specific tools stay with their application. CLI remains English; WebUI supports English/Chinese. Codex shows evidenced memory-model dependencies and warns before closing them; native memory settings remain yours. An interactive terminal replaces ordinary startup checks with one live view: the listener, enabled sources, client setup/activity, usage and scoped notices. Source names start left-aligned below `Enabled sources: N`. Saved credentials do not imply access; configured clients do not imply running Apps. Motion uses observed inference and actual image generation, not MCP discovery traffic. Plain/NO_COLOR/narrow output remains supported; `--verbose` retains request detail.

The WebUI keeps English monospace text with explicit Chinese sans-serif system-font fallbacks, including Microsoft YaHei on Windows. Requests aligns applications to a shared right edge and models to a shared left edge. It shows live app/source/model flow above existing summaries and finished records; a thin theme-colored ring rotates around its atom while requests are active. Usage offers animated bars or curves; reduced motion stays static. Hidden pages stop scheduled reads; status refreshes about every two seconds and source/settings evidence about every 16 seconds. Catalogs and retained usage load on demand or every 30 minutes while open. Disclosures use down/up chevrons with brief rotation and content transitions; reduced-motion mode remains immediate. Saved model selection and configuration-write results are shown separately; writing does not prove that the App has loaded the change. The UI does not add inference calls. Ready means local service availability, not verified model access. First output uses ms, speed token/s, and partial/unknown usage remains explicit. Images/predictions stay opt-in; their first setup uses CLI. 1.2.18 preserves Codex sign-in and unavailable model selections after saving bindings. See the [control reference](docs/REFERENCE.md#control-console-and-online-settings), [1.2.18 fixes and verification](https://github.com/DaleXiao/codex-copilot-dx/blob/main/docs/RELEASE_1.2.18.md) and [copy inventory](https://github.com/DaleXiao/codex-copilot-dx/blob/main/docs/UX_COPY.md).

## Commands

| Command | Purpose |
| --- | --- |
| `ccdx` / `ccdx start` | Start/reuse the foreground gateway; keep existing client setup/launch behavior |
| `ccdx status` / `status --details` | Brief interactive state / complete diagnostic view |
| `ccdx web` | Open local management tools |
| `ccdx source list` | List registered sources |
| `ccdx source github status` / `check` / `reauth` | Saved GitHub evidence / online access check / safe sign-in replacement |
| `ccdx source m365 models --refresh` | Explicitly read the online company catalog; no inference |
| `ccdx source add` | Save an API, read models and choose their declared interfaces |
| `ccdx app list` | List client configuration and observed request activity |
| `ccdx app claude-app models --edit` | Choose client models separately from source authorization |
| `ccdx app claude-app sync --preview` | Review the model/configuration plan without writing |
| `ccdx app codex prediction status` | Inspect the optional Codex-only prediction integration |
| `ccdx app codex image setup` | Configure optional Codex images with a private key prompt |
| `ccdx requests --failed --app claude-app` | Inspect retained failures; no full-history promise |
| `ccdx usage` / `usage --scope run` | Legacy all-recorded usage / current service run |
| `ccdx config show --effective` | Separate saved service preferences from effective state |
| `ccdx config reset --preview` | Review default service/terminal preferences; browser appearance stays separate |
| `ccdx doctor` / `doctor --fix` | Local checks / existing bounded owned repairs |
| `ccdx update check` / `update github` | Check without installation / install a verified GitHub release |

Use `ccdx help app codex prediction` or nearby `--help` for complete options.
New read-only commands support `--format table|plain|json`. New connection writes require the compatible updated service and use the protected loopback API. Finish active work before restarting an older service. `--verbose` and `--show-request-id` keep detailed startup/request output.

Existing `ccdx auth`, `ccdx reauth`, `ccdx models`, `ccdx source github|m365`, `ccdx m365 switch`, `ccdx prediction`, `ccdx image`, `ccdx enable-image`, `ccdx disable-image`, `ccdx image-status`, `ccdx auto-review-model`, `ccdx animation`, `ccdx cache`, `ccdx limits` and flag aliases remain supported. Legacy `source` switching stays Codex-only; legacy `models` stays a catalog. Non-TTY legacy status output is retained.
See [command groups and compatibility](docs/REFERENCE.md#command-groups-1233).

## Add your own API

Run `ccdx web` without GitHub sign-in. In **Model sources → Add API**, enter the HTTPS address/key, read the catalog, select models and declare their real interfaces. Then open **Codex** or **Claude**, choose visible models across sources, set a default and save. Claude App/Code use Messages; Codex uses Responses, all on port 2026. GitHub-only Codex selections retain native OpenAI mode and readable model names. Token counting is separate from message generation. For manual APIs, an observed count-endpoint 404 is remembered for one minute per model/API-header scope; CCDX returns a clear 404 without inventing a token count. Unknown count capabilities share their first admitted request; a 404 prevents distinct waiting inputs from fanning out. A supported endpoint still counts each distinct input separately. Identical small count requests share bounded work. A request stays on its selected deployment; there is no automatic cross-source retry or model replacement. Reopen clients after configuration changes. Claude App can continue an existing conversation on a different selected, authorized source when complete Messages history is available; unfinished tool turns, unavailable attachments and company-account isolation still apply. Codex and Claude Code retain their existing history rules. Stop management before normal `ccdx` startup for the live terminal.

Keys use system credential protection or an explicit environment reference; clients receive separate local credentials. Saving reads model metadata automatically, without inference. Startup and the existing model refresh cycle also refresh enabled APIs when the 30-minute cache expires; failed reads retain saved configuration. Selecting no models pauses access; enable a source and select models to resume. Closed sources can be restored on Model sources; closed apps remain reachable for restoration on their app pages. Pinned streams finish on their original source. The version-two graph preserves old single-source visibility and saves a byte-for-byte v1 backup before migration. User and managed client settings remain protected. Refreshing GitHub models also updates Codex candidates without changing saved selections or native sign-in.

Model lists/details preserve the upstream maker declaration separately from your API source name. Missing maker metadata shows Not provided; model names are never used to guess a maker. Maker and display-name evidence use a rebuildable cache and do not change the strict connection schema or routing identity. Names follow upstream display name, upstream name, then model ID. Claude compatibility aliases remain internal; mixed sources retain their original visible names regardless of the default source. Closing a source previews all selected consumers, including nondefault models. First-time API setup uses **Save & read models** and keeps the model editor open, including after a failed lookup. Model details show upstream capabilities per API, with optional manual overrides collapsed below. Context, input/output limits, reasoning levels, thinking modes, input types, tools and native search are deployment-specific. Structured Anthropic declarations are mapped to Messages; they do not grant the same capabilities to a gateway's other interfaces. Missing and unrecognized metadata are distinguished, without guessing from model names. Manual overrides, including false, take priority. Claude synchronization projects compatible routes, supported host controls and per-model budgets. Unknown or out-of-range windows and unverified client versions are reported as limited; they are not promoted to 1M. Output requests are bounded by declared limits. Compatibility routes do not prove that every model supports every App tool, search or reasoning mode. See the [capability and synchronization limits](docs/REFERENCE.md#model-capabilities-and-claude-synchronization). [1.2.31 changes and verification](https://github.com/DaleXiao/codex-copilot-dx/blob/main/docs/RELEASE_1.2.31.md) cover model display, source impact, error evidence and scoped WebUI improvements. Shared GitHub catalogs and the policy-preserving complete-package update fallback remain included. Existing native Codex sign-in/model protections and the 1.2.27 context-preference fix remain included.

## Microsoft 365 access

Eligible macOS/Windows machines attempt silent Microsoft authorization at startup, without Copilot CLI or a browser login. MDM alone is insufficient: account, tenant, device policy and Loki entitlement must permit access. Optional failure does not block GitHub. Saved bindings stay selected; unresolved company accounts can be chosen under **Model sources → Microsoft 365** or `ccdx m365 account` in the updated running service. Listing is local; changing accounts validates only the selected account, affects M365 in Codex/Claude and requires new conversations. See the reference for identity and history limits. Microsoft 365 uses the fixed `loki.delve.office.com` service origin. Account/origin-bound model discovery is separate from inference; old environment caches are not advertised as current. This does not enable a paused source or change existing application routing.

In **Model sources → Microsoft 365 → Allowed apps**, choose consuming apps; discovery alone does not configure them all. Existing grants are retained, and changing access preserves other sources. Claude clients use `http://127.0.0.1:2026/anthropic` (or the configured main port), a private local gateway key and a Claude-only catalog. No second Claude listener is opened. Existing unchanged CCDX-owned 2027 addresses migrate automatically; hand-written or managed addresses are preserved and need explicit migration. The optional prediction CONNECT/PAC bridge remains a separate transport.
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

Open `ccdx web` for source-specific account tools and Checks & repairs without signing in first. It starts a management-only service when needed; stop it before normal app startup. Safe reauth, config preview/backup, local reports, feature pause/resume and matching circle SVG status icons are described in the [account tools reference](docs/REFERENCE.md#account-and-repair-tools). Existing themes, layout and bilingual support are preserved. Startup checks GitHub's latest-release web redirect, not npm or the anonymous REST quota, and suggests `ccdx update github`. Settings → Version & updates shows the running version, release dates and newer releases, with copyable update and macOS/Windows recovery commands. This separate, cached GitHub metadata check never installs; failed checks remain unknown. The separate **Update overnight** switch defaults off and requires a normal CCDX restart after enabling. Its foreground supervisor checks during 00:00–04:00 local time after ten observed idle minutes, selects same-series stable patches at least 24 hours old, stages verified packages and attempts rollback on failure. Ctrl+C stops it; no OS service is installed. Review the displayed risk and [handoff limits](docs/REFERENCE.md#nightly-updates-opt-in) before enabling. See the [reference](docs/REFERENCE.md#version-and-update-information).
Settings → **Save & restore**, immediately after Version & updates, defaults to automatic saving of this page’s preferences. Turn it off to save or discard drafts manually. Restore defaults backs up the saved preferences first and offers Restore backup; it preserves accounts, keys, model/source selections, native sign-in, client connections, image/prediction access, chats and usage. Browser appearance stays browser-local; failed or conflicting saves retain the draft and show the actual result. See the [scope and recovery rules](docs/REFERENCE.md#settings-saving-and-restore).
GitHub updates verify the exact Release without Git. Source packages use the configured npm registry; a confirmed EALLOWREMOTE restores the old package and permits one same-version complete platform package attempt offline. Nightly preparation shares this fallback. A blocked old updater can use the current verified bootstrap once. Lookup errors identify HTTP refusal, timeout, network failure or invalid redirects. For npm `EALLOWREMOTE`, only if policy permits and the update is trusted, use `ccdx update github --allow-remote`: explicit URL-download permission for that installation's whole dependency tree, not a hostname allowlist. Persistent npm settings stay unchanged.
Updates back up the discovered CCDX package and commands, restore them on install/runtime-check failure, and verify the installed version (exact for GitHub). Mismatched npm targets warn without changing PATH/prefix. Manual updates require a separate adapter restart. Full `ccdx doctor` reports this target and readonly credential permissions; it never changes ACLs.
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
