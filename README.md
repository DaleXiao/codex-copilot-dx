# codex-copilot-dx

Use [Codex Desktop](https://openai.com/codex) app with your **GitHub Copilot** subscription.

## How it works

Codex Desktop uses OpenAI's Responses API (`/v1/responses`), which isn't directly exposed by the GitHub Copilot API proxy. This tool bridges the gap:

- **GPT-5.5, GPT-5.4** and other Responses-only models → proxied directly to `api.githubcopilot.com/v1/responses`
- **GPT-4o, GPT-4.1** and other chat models → converted from Responses API to Chat Completions format via `copilot-api`

Supports both HTTP SSE streaming and WebSocket connections.

## Prerequisites

- [Codex Desktop](https://openai.com/codex) app installed
- GitHub Copilot subscription (Individual, Business, or Enterprise)
- Node.js 18+

## Usage

```bash
npx codex-copilot-dx@latest
```

> Tip: the `@latest` suffix forces `npx` to fetch the newest release instead of using a stale cached copy.

On first run, it will:
1. Authenticate with GitHub via device flow (if needed)
2. Start `copilot-api` proxy (port 4141)
3. Start the Responses API adapter (port 4142)
4. Configure Codex to use the adapter
5. Launch Codex Desktop

## Configuration

Environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `COPILOT_API_PORT` | `4141` | Port for copilot-api |
| `ADAPTER_PORT` | `4142` | Port for the adapter |

## License

MIT
