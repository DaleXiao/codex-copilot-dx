# codex-copilot-dx

Use Codex App with GitHub Copilot through a local adapter.

CCDX targets Codex App. It discovers Copilot models, adapts the client's model
catalog, and preserves Responses streaming, tool calls and conversation history.
Default Auto-review: **GPT-6.1 Sol / low**. Image generation is **off by default**.

## Install and run

Requires macOS, Codex App, Node.js **22.15+**, and a GitHub account with Copilot
access to the models you want to use.

```bash
npm install -g codex-copilot-dx@latest
ccdx
```

CCDX reuses a compatible local credential or starts GitHub Device Flow, listens
on `127.0.0.1:2026`, configures Codex, and opens the App. No client binary patch
is needed. The configured `dummy` API key is a placeholder, not a credential.

Open [the local dashboard](http://127.0.0.1:2026/) for status, model discovery,
usage, cache/limits, recent failures, request context and animation settings.
The dashboard does not poll in the background; refresh when needed.

## Commands

| Command | Purpose |
| --- | --- |
| `ccdx help` | Command help; use `ccdx help <command>` for details |
| `ccdx start` | Start without launching the App |
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
| `ccdx update` | Update the global package |

## Compatibility and safety

- Standard/Fast follow the exact variants advertised by Copilot; CCDX does not
  invent Fast availability. Auto-review is separate from the foreground model.
- Model discovery does not prove inference access. If a new model is absent in
  Codex, run `ccdx doctor`; fully quit the App with **Command-Q** before reopening.
  CCDX does not claim it can verify the App's internal model cache externally.
- After a package upgrade, restart the running CCDX adapter. Choosing a model or
  effort on a current adapter takes effect on its next Auto-review request.
- Request-body bytes, local-history bytes and the model's token window are
  different limits. Request-context figures are observed metadata, not exact
  live session occupancy. Prompts and images are not retained by that panel.
- `ccdx cache --clean --history` also clears active response history and can
  break continuations. Generated images and Codex transcripts are not deleted.
- Optional image setup/maintenance never blocks the primary service. Disabled
  users get no CCDX image skill or MCP installation.
- Image API redirects must stay on the same HTTPS origin. Returned images must
  use public HTTPS URLs; well-known NAT64 mappings follow IPv4 address rules.
- Keep the adapter on loopback. LAN mode is only for trusted networks; do not
  expose it to the public internet. The dashboard is not an authentication wall
  for the API. Diagnostic errors may contain sensitive upstream text.

Startup checks GitHub Releases, not npm, and suggests `ccdx update github` when a newer stable version is available. GitHub updates install the exact release tag; dependency downloads still use npm's configured registry.

See the [complete command/configuration reference](https://github.com/DaleXiao/codex-copilot-dx/blob/main/docs/REFERENCE.md)
for authentication recovery, configuration-write boundaries, advanced limits,
logging, image setup and client compatibility details.
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
