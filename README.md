# codex-copilot-dx

Use [Codex Desktop](https://openai.com/codex), [Claude Code](https://claude.com/claude-code), and optionally Claude App with your **GitHub Copilot** subscription.

## How it works

A single in-process adapter (port `2026`) exposes both APIs over your Copilot subscription:

- **Codex** -> OpenAI Responses API (`/v1/responses`, `/v1/responses/compact`); Responses-only models and compaction proxy directly, chat models convert to Chat Completions.
- **Claude Code** -> Anthropic Messages API (`/v1/messages`, `/v1/messages/count_tokens`), translated to/from Chat Completions.
- **Claude App** -> optional Claude Desktop App gateway profile using the same local Messages API plus local model discovery for the configured gateway key.

Supports both HTTP SSE streaming and non-streaming.

## Prerequisites

- GitHub Copilot subscription (Individual, Business, or Enterprise)
- Node.js 18+
- [Codex Desktop](https://openai.com/codex), [Claude Code](https://claude.com/claude-code), and/or Claude App installed

## Usage

```bash
npx codex-copilot-dx@latest
```

> Tip: the `@latest` suffix forces `npx` to fetch the newest release instead of using a stale cached copy.

On first run, it will:
1. Authenticate with GitHub via device flow (if needed)
2. Print the local package version and warn when a newer npm release is available
3. Start the adapter on loopback (`127.0.0.1:2026`)
4. Configure Codex (`~/.codex/config.toml`) to use the adapter, including stale shell env base URLs if present
5. Configure Claude Code (`~/.claude/settings.json`) to use the adapter; it creates the file when missing, otherwise backs up `settings.json.bak` before updating the local API env keys
6. Launch Codex Desktop

Claude Code picks up the new `ANTHROPIC_BASE_URL` on its next launch.

Do not set Claude Code by manually exporting `ANTHROPIC_BASE_URL` or `ANTHROPIC_AUTH_TOKEN` in your shell. Let `codex-copilot-dx` write the local config files instead. If you previously exported those variables, remove them from shell startup files and restart the terminal before launching Claude Code.

### Claude App opt-in

Claude App support is opt-in so the default Codex Desktop and Claude Code setup stays unchanged:

```bash
npx codex-copilot-dx@latest --configure-claude-desktop
```

Or set:

```bash
CCDX_CONFIGURE_CLAUDE_DESKTOP=1 npx codex-copilot-dx@latest
```

This writes a local Claude App 3P gateway profile that points to the adapter root URL, such as `http://127.0.0.1:2026`. The profile uses a generated local bearer key unless `CCDX_CLAUDE_DESKTOP_API_KEY` is set. Restart Claude App after running the command.

## Configuration

Environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `ADAPTER_HOST` | `127.0.0.1` | Host for the adapter; set `0.0.0.0` only if you knowingly expose it on a trusted network |
| `ADAPTER_PORT` | `2026` | Port for the adapter |
| `CCDX_MAX_BODY_BYTES` | `134217728` | Maximum compressed/raw request body size |
| `CCDX_MAX_DECODED_BODY_BYTES` | `268435456` | Maximum decoded request body size after decompression |
| `CCDX_UPSTREAM_TIMEOUT_MS` | `120000` | Timeout for non-streaming upstream Copilot requests |
| `CCDX_IMG_MAX_DIM` | `2048` | Max long edge in pixels for image downscaling |
| `CCDX_IMG_QUALITY` | `85` | WebP quality used when re-encoding images |
| `CCDX_IMG_MIN_BYTES` | `100000` | Images smaller than this are left untouched |
| `CCDX_IMG_CONCURRENCY` | `4` | Concurrent image optimization tasks; values above `12` are capped at `12` |
| `CCDX_DISABLE_IMG_OPT` | unset | Set to `1` to disable image optimization |
| `CCDX_CONFIGURE_CLAUDE_DESKTOP` | unset | Set to `1` to write the Claude App 3P gateway profile during startup |
| `CCDX_CLAUDE_DESKTOP_API_KEY` | generated for opt-in setup | Bearer key written into the Claude App profile and recognized by the adapter for model discovery |
| `CCDX_CLAUDE_MODEL_ALIASES` | built-in Claude aliases | Comma-separated Desktop-to-upstream aliases, for example `claude-sonnet-4-6=claude-sonnet-4.6` |
| `CCDX_USAGE_PATH` | `~/.local/share/codex-copilot-dx/usage.jsonl` | Local JSONL token usage log |
| `CCDX_DISABLE_USAGE` | unset | Set to `1` to disable usage logging |

### Usage logging

The adapter records token usage metadata to `~/.local/share/codex-copilot-dx/usage.jsonl` when upstream responses include usage fields. It logs counts, model names, API surface, and response IDs only; it does not log prompts, completions, tool arguments, or image content.

```bash
codex-copilot-dx usage
```

### Image optimization

Long computer-use sessions can accumulate screenshots inside the conversation history. Each screenshot is shipped on later turns, and GitHub Copilot's `/responses` endpoint can reject oversized requests with `413 Payload Too Large`.

The adapter automatically downsamples embedded screenshots to long-edge <= 2048 px and re-encodes them as WebP before forwarding `/v1/responses`.

## License

MIT
