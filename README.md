# CCDX

Use your model services in **Codex App, Claude App and Claude Code** through one local gateway.

Connect GitHub Copilot, Microsoft 365 or your own API. Choose which apps can use each source, then select their models. CCDX supports **macOS and Windows**, on Apple Silicon/ARM64 and x64.

## Install and start

With Node.js **22.15+** and npm:

```sh
npm install -g codex-copilot-dx@latest
ccdx
```

Without Node.js, download and run the installer for your system:

- macOS: [install.sh](https://github.com/DaleXiao/codex-copilot-dx/releases/download/v1.3.0/install.sh), then `sh install.sh`.
- Windows: [install.ps1](https://github.com/DaleXiao/codex-copilot-dx/releases/download/v1.3.0/install.ps1), then `./install.ps1` under your current shell policy.

The installer reuses a compatible Node.js or installs a private, verified copy. Git and a compiler are not required. Complete platform packages include their dependencies. Company registry, proxy, certificate and shell policies are kept.

On Windows, use `npm.cmd` or `ccdx.cmd` if PowerShell blocks npm-generated scripts. See [installation and updates](docs/REFERENCE.md#installation-and-updates).

## Choose sources and models

The Web UI opens at [http://127.0.0.1:2026](http://127.0.0.1:2026/). Run `ccdx web` to open it again, including before signing in.

1. **Model sources:** connect an account or API, read its models and choose allowed apps.
2. **Codex / Claude:** choose visible models, set a default and save. Preview and synchronize client settings when needed.
3. **Overview / Requests:** check configuration, activity and errors.

For a custom API, enter its HTTPS address and key, then choose **Save & read models**. Select the models and interfaces it provides. Codex uses Responses; Claude uses Messages. Both share port 2026.

Model availability depends on your account and service. Microsoft 365 also requires a supported company environment. Existing account, model and client settings are retained during upgrades. No repeat setup or model selection is needed for an unchanged working configuration.

## Commands

| Task | Command |
| --- | --- |
| Start the gateway | `ccdx` |
| Open the Web UI | `ccdx web` |
| Check service and apps | `ccdx status` / `ccdx app list` |
| Manage sources | `ccdx source list` / `ccdx source add` |
| Sign in again | `ccdx source github reauth` |
| Choose client models | `ccdx app codex models --edit` |
| Preview client setup | `ccdx app claude-app sync --preview` |
| Inspect failures | `ccdx requests --failed` |
| Read usage | `ccdx usage` / `ccdx usage --scope run` |
| Inspect preferences | `ccdx config show --effective` |
| Check local setup | `ccdx doctor` |

Use `ccdx help` or `ccdx <command> --help` for options. The CLI uses English; the Web UI supports English and Chinese.

**1.3 uses one command tree.** Old command names and the `codex-copilot-dx` executable have been removed. This changes command entrypoints, not saved accounts, model selections or chats. See the [command reference](docs/REFERENCE.md#commands).

## Optional features

Images, native input suggestions and overnight updates are **off by default**. Existing enabled settings are retained.

- **Images:** `ccdx app codex image setup`. [Image guide](docs/REFERENCE.md#optional-image-generation).
- **Input suggestions:** `ccdx app codex prediction setup`. Setup adds trust within the Codex profile and locally decrypts traffic for the configured prediction hosts. Read the [setup and removal guide](docs/REFERENCE.md#optional-native-predictions) first.
- **Appearance and updates:** open Settings. Web and terminal colors are independent.

## Update and troubleshoot

Finish active tasks before updating the active installation. Install the update, then restart CCDX normally:

```sh
ccdx update github
ccdx version
```

The foreground terminal stops with **Ctrl+C**. Client configuration marked **Unchanged** means CCDX kept the existing settings. Configuration and successful model access are separate checks.

If models are missing, check the selected source and app models first. After a client update or configuration change, fully quit and reopen that app. Use **Checks & repairs** or `ccdx doctor` for local diagnostics.

Keep the gateway on loopback. Account keys stay separate from the local credentials given to clients. Prompts are not included in routine diagnostics. See the [reference](docs/REFERENCE.md) for access, history, troubleshooting and settings, and [architecture](docs/ARCHITECTURE.md) for engineering boundaries.

## License

MIT
