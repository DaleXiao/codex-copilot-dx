# codex-copilot-dx

Use Codex App with GitHub Copilot through a local adapter.

CCDX targets Codex App. It discovers Copilot models, adapts the client's model
catalog, and preserves Responses streaming, tool calls and conversation history.
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
enabled. The configured `dummy` API key is a placeholder, not a credential.

Open [the local dashboard](http://127.0.0.1:2026/) for status, model discovery,
usage, cache/limits, recent failures, request context and animation settings.
Auto refresh runs every 30 minutes while visible and can be switched off. Hidden pages pause; opening sections and manual refresh still work.

## Commands

| Command | Purpose |
| --- | --- |
| `ccdx help` | Command help; use `ccdx help <command>` for details |
| `ccdx start` | Start or reuse the adapter and open Codex when auto-launch is enabled |
| `ccdx status` | Runtime, limits and bounded request diagnostics |
| `ccdx doctor` | Configuration, adapter and read-only App/catalog diagnostics |
| `ccdx doctor config` | Read-only configuration check |
| `ccdx doctor --compat` | Online inference/continuation compatibility probes |
| `ccdx auth status` | Saved account; add `--online` to verify access |
| `ccdx models` | Fresh upstream model list |
| `ccdx usage` | Recorded tokens and upstream prompt-cache hit rate |
| `ccdx auto-review-model` | Select model, then reasoning effort; `0` follows client |
| `ccdx animation` | Preview and select terminal animation |
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
- The manual prediction MCP, background hook and dashboard panel are retired.
  Startup removes only unchanged CCDX registrations and disables saved prediction
  settings. The optional image MCP remains unchanged. Modified old registrations
  can use inert compatibility entrypoints; they no longer generate suggestions.
- Native predictions are a separate, opt-in compatibility feature. Quit Codex,
  run `ccdx prediction on`, then restart CCDX. This adds App-profile certificate
  trust and an App-only route for `chatgpt.com` and `ab.chatgpt.com`; HTTPS on those
  hosts is decrypted locally, but only prediction configuration is changed.
  Other domains and the CCDX model endpoint stay on their existing routes.
  No program files or OS trust are changed. Static HTTP/HTTPS/SOCKS5 proxies and bypass rules are retained.
  Windows supports company PAC/WPAD; macOS dynamic routing remains unsupported. Windows setup needs the official MSIX App, Windows PowerShell and .NET Framework 4.7.2+—not Git/OpenSSL. See the reference for limits.
- CCDX adds experimental local history compression only when installed App
  runtimes support it and report it off. Existing choices are preserved; an
  already-enabled default, unavailable runtime or failed check is skipped.
- Image API redirects must stay on the same HTTPS origin. Returned images must
  use public HTTPS URLs; well-known NAT64 mappings follow IPv4 address rules.
- Keep the adapter on loopback. LAN mode is only for trusted networks; do not
  expose it to the public internet. The dashboard is not an authentication wall
  for the API. Diagnostic errors may contain sensitive upstream text.

Startup checks GitHub's latest-release web redirect, not npm or the anonymous REST quota, and suggests `ccdx update github`.
Updates install the exact stable tag; dependencies still use npm's configured registry. Lookup errors identify HTTP refusal, timeout, network failure or invalid redirects.

The dashboard and CLI separate prediction preference, bridge state and observed config traffic; candidate visibility stays unknown.
Inference, client integration, optional images and management have separate ownership. See [architecture boundaries](docs/ARCHITECTURE.md).

See the [complete command/configuration reference](https://github.com/DaleXiao/codex-copilot-dx/blob/main/docs/REFERENCE.md)
for authentication recovery, configuration safety, limits, logging, images and client compatibility.
The same reference is included as `docs/REFERENCE.md` in the installed npm package.

## Development

```bash
npm ci
npm run verify
node scripts/config-startup-replay.mjs
```

Verification covers unit tests, isolated HTTP/idle-stream replay, performance
and resource gates, and package contents. These are not an upstream service SLA.

License: MIT.
