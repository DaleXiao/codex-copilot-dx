# CCDX

Use your model services in **Codex App, Claude App, Claude Code and Antigravity App** through one local gateway.

Releases cover Apple Silicon Macs and Windows x64/ARM64. Connect GitHub Copilot, Microsoft 365 or a custom API, then choose which apps and models can use the source.

| Client | macOS | Windows |
| --- | --- | --- |
| Codex App | App and model routing | Registered App and model routing |
| Claude App | Desktop discovery and capability checks | MSIX or standalone discovery. Native capability checks require a registered package. |
| Claude Code | PATH and npm package detection | PATH, native executable and npm shim detection |
| Antigravity App | Antigravity and Gemini App bundles | Official installer verification with a cached compatibility catalog |

Native feature status depends on the detected client and available evidence. See [client setup and verification](docs/REFERENCE.md#client-setup-and-verification).

## Install and start

With Node.js **22.15+** and npm:

```sh
npm install -g codex-copilot-dx@latest
ccdx
```

Without Node.js, download and run the installer for your system:

- macOS: [install.sh](https://github.com/DaleXiao/codex-copilot-dx/releases/latest/download/install.sh), then `sh install.sh`.
- Windows: [install.ps1](https://github.com/DaleXiao/codex-copilot-dx/releases/latest/download/install.ps1), then `./install.ps1` under your current shell policy.

The installer reuses a compatible Node.js or installs a private, verified copy. Git and a compiler are not required. Complete platform packages include their dependencies. Company registry, proxy, certificate and shell policies are kept.

On Windows, use `npm.cmd` or `ccdx.cmd` if PowerShell blocks npm-generated scripts. See [installation and updates](docs/REFERENCE.md#installation-and-updates).

## Choose sources and models

The Web UI opens at [http://127.0.0.1:2026](http://127.0.0.1:2026/). Run `ccdx web` to open it again, including before signing in.

1. **Model sources:** connect an account or API, read its models, choose allowed apps and save. Source tabs only change the view.
2. **Codex / Claude / Antigravity:** choose visible models, set a default and save. For Antigravity, enable the integration and open the verified App from its page.
3. **Overview / Requests:** check configuration, activity and errors.
4. **Usage → Context:** inspect reported input, model windows and observed compactions from this run.

Claude capability synchronization checks the installed macOS App contract when it changes. Compatible upgrades can keep their model identities and reasoning controls without a CCDX version-list update. Reopen Claude normally after native configuration changes. Inspect synchronization and observed effort with `ccdx app claude-app status --details`.

For a custom API, enter its HTTPS address and key, then choose **Save & read models**. Select the models and interfaces it provides. Codex uses Responses; Claude uses Messages. Both share port 2026.

Model availability depends on your account and service. Microsoft 365 also requires a supported company environment. Existing account, model and client settings are retained during upgrades. No repeat setup or model selection is needed for an unchanged working configuration.

## Commands

| Task | Command |
| --- | --- |
| Start the gateway | `ccdx` |
| Open the Web UI | `ccdx web` |
| Check service and apps | `ccdx status` / `ccdx app list` |
| Preview imported APIs | `ccdx source import --file providers.json` |
| Find configured APIs in another tool | `ccdx source import --from cc-switch` or `--from magpie` |
| Manage sources | `ccdx source list` / `ccdx source add` |
| Sign in again | `ccdx source github reauth` |
| Choose client models | `ccdx app codex models --edit` |
| Preview client setup | `ccdx app claude-app sync --preview` |
| Set up Antigravity | `ccdx app antigravity status` / `enable` / `open` |
| Inspect compression | `ccdx compact status` / `ccdx compact enable` / `ccdx compact disable` |
| Inspect failures | `ccdx requests --failed` / `ccdx requests show ID --format json` |
| Inspect observed tool calls | `ccdx requests tools` / `ccdx requests tools --active` |
| Inspect active model requests | `ccdx requests --active` |
| Capture one upstream Messages 400/422 | `ccdx requests diagnose --source api_work --model model-id --yes` |
| Read usage | `ccdx usage` / `ccdx usage --provider google --days 7` / `ccdx usage --purpose diagnostic` / `ccdx usage --scope run` |
| Inspect preferences | `ccdx config show --effective` |
| Inspect local masking | `ccdx config privacy status` |
| Check local setup | `ccdx doctor` |

Use `ccdx help` or `ccdx <command> --help` for options. The CLI uses English; the Web UI supports English and Chinese.

## Features and maintenance

- [Input suggestions](docs/REFERENCE.md#optional-native-predictions) and [native image tools](docs/REFERENCE.md#native-image-generation) have their own checks on the Codex page.
- [Local masking](docs/REFERENCE.md#local-masking) runs on this computer and is off by default.
- [Updates](docs/REFERENCE.md#installation-and-updates) are in Settings. For terminal updates, run `ccdx update github`.
- Use **Checks & repairs** or `ccdx doctor` for local diagnostics. **Ctrl+C** stops the foreground service.

[Command reference](docs/REFERENCE.md) · [Architecture](docs/ARCHITECTURE.md)

## License

MIT
