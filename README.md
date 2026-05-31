# codex-copilot-dx

Use [Codex Desktop](https://openai.com/codex) **and** [Claude Code](https://claude.com/claude-code) with your **GitHub Copilot** subscription.

## How it works

A single in-process adapter (port `8148`) exposes both APIs over your Copilot subscription:

- **Codex** → OpenAI Responses API (`/v1/responses`); Responses-only models proxy directly, chat models convert to Chat Completions.
- **Claude Code** → Anthropic Messages API (`/v1/messages`, `/v1/messages/count_tokens`), translated to/from Chat Completions.

Supports both HTTP SSE streaming and non-streaming.

## Prerequisites

- GitHub Copilot subscription (Individual, Business, or Enterprise)
- Node.js 18+
- [Codex Desktop](https://openai.com/codex) and/or [Claude Code](https://claude.com/claude-code) installed

## Usage

```bash
npx codex-copilot-dx@latest
```

> Tip: the `@latest` suffix forces `npx` to fetch the newest release instead of using a stale cached copy.

On first run, it will:
1. Authenticate with GitHub via device flow (if needed)
2. Start the adapter (port `8148`)
3. Configure Codex (`~/.codex/config.toml`) to use the adapter
4. Configure Claude Code (`~/.claude/settings.json` `ANTHROPIC_BASE_URL`) to use the adapter — backs up `settings.json.bak` first, only touches that one key
5. Launch Codex Desktop

Claude Code picks up the new `ANTHROPIC_BASE_URL` on its next launch.

## Configuration

Environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `ADAPTER_PORT` | `8148` | Port for the adapter |

## License

MIT
