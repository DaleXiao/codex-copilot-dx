# CCDX

Use your model services in **Codex App, Claude App and Claude Code** through one local gateway.

On macOS, the optional Gemini integration adds Copilot Carbon and Argon to the original App's Antigravity. Ordinary Gemini chat keeps Google. Set it up on the Antigravity page; inspect it with `ccdx app antigravity status`. Existing clients keep their setup.

Connect GitHub Copilot, Microsoft 365 or your own API. Choose which apps can use each source, then select their models. CI and prebuilt releases cover **macOS on Apple Silicon** and **Windows on x64/ARM64**. Intel Mac code remains available, without CI coverage or new prebuilt assets.

Optional local masking is off by default. Enable it in Settings → Local masking to download the model and component. Checks run locally and may add delay or mistake ordinary text; an unfinished check holds the request back. See [local masking](docs/REFERENCE.md#local-masking).

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
2. **Codex / Claude:** choose visible models, set a default and save. Preview and synchronize client settings when needed.
3. **Overview / Requests:** check configuration, activity and errors.
4. **Usage → Context:** inspect reported input, model windows and observed compactions from this run.

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
| Set up Antigravity | `ccdx app antigravity status` / `enable` / `open` |
| Inspect failures | `ccdx requests --failed` |
| Read usage | `ccdx usage` / `ccdx usage --scope run` |
| Inspect preferences | `ccdx config show --effective` |
| Inspect local masking | `ccdx config privacy status` |
| Check local setup | `ccdx doctor` |

Use `ccdx help` or `ccdx <command> --help` for options. The CLI uses English; the Web UI supports English and Chinese.

**1.3 uses one command tree.** Old command names and the `codex-copilot-dx` executable have been removed. This changes command entrypoints, not saved accounts, model selections or chats. See the [command reference](docs/REFERENCE.md#commands).

## Features and maintenance

Start CCDX to open Codex with native image tools, then use a new chat. If image access is missing, use the Web UI image checks or `ccdx app codex image check`, `repair` and `open`. Running Apps are never forcibly restarted.

Use the Web UI for accounts, APIs, models, client access, input suggestions, native images, local masking, appearance, diagnostics and updates. CLI commands remain available for automation and recovery. See the [control reference](docs/REFERENCE.md#webui-and-cli-controls).

- **Input suggestions:** new integrations attempt setup by default when Codex is closed. Saved off choices are retained. The Web UI can enable, disable, finish setup, open Codex and repair the bridge. Setup synchronizes Show predictions, adds App-profile trust and locally decrypts the prediction hosts' HTTPS traffic. App/thread eligibility still applies. [Details](docs/REFERENCE.md#optional-native-predictions).
- **Images:** Codex native host tools use the selected GitHub image model, with GPT Image 2.5 Flare as the default. Images start enabled; saved off choices are retained. On macOS with Codex 0.166+, fully quit a running App that lacks the host, start Codex through CCDX, and use a new chat. ChatGPT sign-in and Apps are retained. The Web UI provides model selection without an extra API key, MCP or CCDX image skill. [Details](docs/REFERENCE.md#native-image-generation).
- **Updates:** Settings → Install update downloads and verifies a stable release, then switches the installed service when idle. Busy work postpones the switch. Unmanaged launches require the installer or an installed command. [Details](docs/REFERENCE.md#installation-and-updates).
- **App updates:** Checks & repairs and `ccdx doctor` show observed installed Codex and Claude versions. A version change does not by itself verify the running App or its integrations. [Details](docs/REFERENCE.md#checks-and-troubleshooting).

Web UI activity updates through server push; the terminal uses the same in-process activity feed. Reconnecting restores current state and bounded recent records.

The foreground terminal stops with **Ctrl+C**. Client configuration marked **Unchanged** means CCDX kept the existing settings. Configuration and successful model access are separate checks.

If models are missing, check the selected source and app models first. After a client update or configuration change, fully quit and reopen that app. Use **Checks & repairs** or `ccdx doctor` for local diagnostics.

Keep the gateway on loopback. Account keys stay separate from the local credentials given to clients. Prompts are not included in routine diagnostics. See the [reference](docs/REFERENCE.md) for access, history, troubleshooting and settings, and [architecture](docs/ARCHITECTURE.md) for engineering boundaries.

## License

MIT
