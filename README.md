# codex-copilot-dx

Use Codex App with GitHub Copilot through a local adapter.

CCDX targets Codex App: Copilot discovery, adapted model catalogs, Responses streaming, tool calls and conversation history.
Default Auto-review: **GPT-6.1 Sol / low**. Image generation is **off by default**. Native predictions are also **off by default**.

## Install and run

Requires macOS or Windows, Codex App, Node.js **22.15+**, and a GitHub account with Copilot
access to the models you want to use.

```bash
npm install -g codex-copilot-dx@latest
ccdx
```

CCDX reuses a compatible local credential or starts GitHub Device Flow, listens
on `127.0.0.1:2026`, configures Codex, and opens the App. No client binary patch
is needed. On Windows, open the App manually unless native prediction setup is
enabled. In restricted Windows PowerShell, use `npm.cmd` to install and `ccdx.cmd` for the first launch, or run `ccdx.cmd doctor --fix`. Startup, updates and explicit repair remove only CCDX's exact npm-generated `.ps1` launchers so later calls can use `ccdx`. No install script, alias or policy change is added; custom launchers are preserved. npm's own script is untouched. The configured `dummy` API key is a placeholder, not a credential.

Open [the local dashboard](http://127.0.0.1:2026/) for status, model discovery,
usage, cache/limits, recent failures, request context and animation settings. First output uses **ms**; estimated output speed uses **token/s**. Inference HTTP failures are retained separately from route and MCP-method errors.
Auto refresh runs every 30 minutes while visible and can be switched off. Hidden pages pause; opening sections and manual refresh still work. The atom rotates once on page load and manual refresh, respecting reduced motion. Startup uses a compact six-line atom and aligned checks; `Ready` refers to the core service. Narrow/non-color terminals use a plain title.

## Commands

| Command | Purpose |
| --- | --- |
| `ccdx help` | Command help; use `ccdx help <command>` for details |
| `ccdx start` | Start or reuse the adapter and open Codex when auto-launch is enabled |
| `ccdx status` | Runtime, limits and bounded request diagnostics |
| `ccdx doctor` | Configuration, adapter and read-only App/catalog diagnostics |
| `ccdx doctor --fix` | Repair owned launchers/config, recover existing auth and enabled prediction routing once |
| `ccdx doctor --json` | Redacted structured diagnostics; combines with `--fix` |
| `ccdx doctor config` | Read-only configuration check |
| `ccdx doctor --compat` | Online inference/continuation compatibility probes |
| `ccdx auth status` | Saved account; add `--online` to verify access |
| `ccdx models` | Fresh upstream model list |
| `ccdx usage` | Recorded tokens and upstream prompt-cache hit rate |
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

Startup checks GitHub's latest-release web redirect, not npm or the anonymous REST quota, and suggests `ccdx update github`.
Updates install the exact stable tag; dependencies still use npm's configured registry. Lookup errors identify HTTP refusal, timeout, network failure or invalid redirects. For npm `EALLOWREMOTE`, only if policy permits and the update is trusted, use `ccdx update github --allow-remote`: explicit URL-download permission for that installation's whole dependency tree, not a hostname allowlist. Persistent npm settings stay unchanged.
Updates warn about mismatched npm targets without changing PATH/prefix and verify the installed target version (exact tag for GitHub). Restart the adapter separately. Full `ccdx doctor` reports this target and readonly credential permissions; it never changes ACLs.
Recent errors separate HTTP and model failures. HTTP metadata retains status, source and IDs, not error bodies or prompts; original errors still reach Codex unchanged.

The dashboard and CLI separate prediction preference, bridge state and observed config traffic; candidate visibility stays unknown. See [architecture boundaries](docs/ARCHITECTURE.md) for separate inference, integration, image and management ownership.

See the [complete reference](https://github.com/DaleXiao/codex-copilot-dx/blob/main/docs/REFERENCE.md) for authentication, configuration, limits, logging, images and compatibility. It is also included as `docs/REFERENCE.md` in the npm package.

## Development

```bash
npm ci
npm run verify
node scripts/config-startup-replay.mjs
```

Verification covers unit tests, isolated HTTP/idle-stream replay, performance/resource gates and package contents—not an upstream service SLA.
CI also tests Node 22.15/24 on Linux, Windows and macOS, temporary-prefix installation/upgrade and installed image processing.

License: MIT.
