# codex-copilot-dx

Use [Codex Desktop](https://openai.com/codex), [Claude Code](https://claude.com/claude-code), and optionally Claude App with your **GitHub Copilot** subscription.

## How it works

A single in-process adapter (port `2026`) exposes both APIs over one Copilot
account by default, or over isolated Codex and Claude accounts when configured:

- **Codex** -> OpenAI Responses API (`/v1/responses`, `/v1/responses/compact`); Responses-only models and compaction proxy directly, chat models convert to Chat Completions.
- **Claude Code** -> Anthropic Messages API (`/v1/messages`, `/v1/messages/count_tokens`), translated to/from Chat Completions.
- **Claude App** -> optional Claude Desktop App gateway profile using the same local Messages API plus local model discovery for the configured gateway key.

Supports both HTTP SSE streaming and non-streaming.

Codex Auto-review requests use the hidden `codex-auto-review` model ID. The adapter maps it to Copilot's `gpt-5.5` Responses model by default and logs both model IDs when the mapping is used. The target can be changed interactively without reinstalling the package.

## Prerequisites

- GitHub Copilot subscription (Individual, Business, or Enterprise)
- Node.js 22.15+ (required for built-in Zstandard request decompression)
- [Codex Desktop](https://openai.com/codex), [Claude Code](https://claude.com/claude-code), and/or Claude App installed

## Usage

```bash
npm install -g codex-copilot-dx@latest
ccdx
```

The shorter `ccdx` command is the primary launcher. The existing `codex-copilot-dx`
command remains an equivalent compatibility alias. For a one-off run without a
global install, use `npx codex-copilot-dx@latest`.
Both installed commands expose the same options and subcommands; help, version,
doctor, status, and argument-error output use the command name that was invoked.

To query the models currently advertised as selectable for the saved Codex
Copilot account, run:

```bash
ccdx models
```

This performs a fresh, read-only GitHub Copilot model-directory lookup without
starting the adapter, opening device login, reading the local model cache, or
consuming an inference request. It lists model IDs by provider with their
advertised API capabilities and reports the live Claude/Anthropic count. A model
being advertised does not guarantee that a later inference request will avoid
quota, rate-limit, or policy enforcement. `codex-copilot-dx models` is fully
equivalent.

### Separate GitHub account for Claude

The default remains fully backward compatible: Codex and Claude requests share
the existing GitHub authentication. To keep an enterprise account for Codex
while using a different personal account that has Claude models enabled, run:

```bash
ccdx auth login claude --github-login <personal-github-login>
```

This is the only command that starts the additional Device Flow. It verifies
the selected GitHub identity, Copilot entitlement, and an enabled Claude model
before saving anything. It refuses the current Codex account and never changes,
migrates, or deletes the existing Codex credential. The optional login pin is
recommended so authorizing the wrong browser account fails before activation.

The existing Codex token remains at
`~/.local/share/copilot-api/github_token`. The isolated Claude credential is
stored with mode `0600` under
`~/.local/share/copilot-api/profiles/claude/github_token`, with matching account
metadata committed last. Restart a running adapter after authentication.

Once enabled, routing is fixed by API surface rather than by model name:

- `/v1/responses`, `/v1/responses/compact`, their Chat fallback, and normal
  `/v1/models` use the Codex account.
- `/v1/messages` and Claude App model discovery use the isolated Claude account.
- `/v1/messages/count_tokens` remains local and uses neither account.

The two profiles keep separate service tokens, API bases, refresh/backoff state,
model endpoint metadata, and model caches. If the isolated Claude profile later
becomes invalid, Claude requests fail with a reauthentication instruction while
Codex remains available; CCDX never silently falls back to the enterprise
account. Reauthorize it explicitly with:

```bash
ccdx auth login claude --reauth --github-login <personal-github-login>
```

These commands are read-only and never start Device Flow:

```bash
ccdx auth status
ccdx auth status --online
ccdx models --profile claude
ccdx doctor --online --profile all
```

To change the model used by Codex Auto-review, run:

```bash
ccdx auto-review-model
```

The selector reads the current adapter model list, falling back to the fresh local
model cache, and offers only enabled models that advertise a Responses endpoint.
It saves the selection in `~/.config/codex-copilot-dx/config.json` (or under
`XDG_CONFIG_HOME` when set); choosing `gpt-5.5` clears the override and restores
the package default. A running 0.5.1+
adapter reads the setting on the next Auto-review request, so it does not need to
be restarted. `codex-copilot-dx auto-review-model` is fully equivalent.

To update the globally installed package, choose a source interactively:

```bash
ccdx update
```

For scripts or a direct choice, pass the source explicitly:

```bash
ccdx update npm
ccdx update github
```

`ccdx update gh` is accepted as a shorthand for the GitHub source.

The npm source installs `codex-copilot-dx@latest` through the registry already
configured for npm, including a company mirror. The GitHub source installs the
latest commit from `DaleXiao/codex-copilot-dx` `main` and opts in to Git fetching
for that command, as required by npm 12. It does not change npm's persistent
`allow-git` setting. Both paths use npm's global installer without shell
interpolation. A currently running adapter keeps its loaded version until it is
stopped and started again. The
`codex-copilot-dx update` compatibility command behaves identically.
If a configured npm mirror has not synchronized the current release yet, use
the GitHub source to install the current `main` revision.

On first run, it will:
1. Authenticate with GitHub via device flow (if needed), after first trying compatible local Copilot token sources
2. Print the local package version and check for a newer npm release in the background
3. Start the adapter on loopback (`127.0.0.1:2026`)
4. Configure Codex (`~/.codex/config.toml`) to use the adapter, including stale shell env base URLs if present
5. Configure Claude Code (`~/.claude/settings.json`) to use the adapter; it creates the file when missing, otherwise backs up `settings.json.bak` before updating the local API env keys
6. Launch Codex Desktop

Claude Code picks up the new `ANTHROPIC_BASE_URL` on its next launch.

If an existing `codex-copilot-dx` adapter is already running on the configured host and port, a second launch reuses it instead of starting another proxy. The second launch still refreshes Codex and Claude Code config, then exits.

The running adapter reports its package and protocol versions. After upgrading `codex-copilot-dx`, stop the old process before starting the new version; the new CLI refuses to silently reuse an incompatible adapter.

Do not set Claude Code by manually exporting `ANTHROPIC_BASE_URL` or `ANTHROPIC_AUTH_TOKEN` in your shell. Let `ccdx` write the local config files instead. If you previously exported those variables, remove them from shell startup files and restart the terminal before launching Claude Code.

### Diagnostics

Run a read-only config check without starting the adapter or changing files:

```bash
ccdx doctor
```

The command exits with status `1` when it finds an invalid configuration and `0` when checks contain only OK or warning results.

The doctor checks the GitHub token, Codex config, Claude Code settings, Claude App gateway profile, and whether the local adapter port is listening.

For a read-only live check of the saved GitHub token, Copilot entitlement, and models endpoint, run:

```bash
ccdx doctor --online
```

The online doctor never starts device flow, scans for replacement tokens, or changes the saved token.
Use `--profile codex`, `--profile claude`, or `--profile all` to choose which
account entitlement is checked. Without `--profile`, the legacy Codex check is
preserved.

To actively verify the protocol path through an already-running adapter, run:

```bash
ccdx doctor --compat
```

The compatibility doctor sends a few minimal Copilot requests to check Codex Auto-review, native Responses, streaming history, compaction, image tool namespace handling, and Anthropic streaming. It consumes a small amount of Copilot usage, never starts the adapter or device flow, and does not change client configuration. Combine it with `--online` when both the saved-token entitlement check and the adapter protocol checks are needed.

For a read-only summary of the running adapter, use:

```bash
ccdx status
```

The compatibility alias supports the same command as
`codex-copilot-dx status`. For the complete machine-readable payload, query the
loopback endpoint directly:

```bash
curl -s http://127.0.0.1:2026/_ccdx/status | jq
```

The status endpoint is restricted to the socket's real loopback address, even when LAN binding is explicitly enabled. It reports fixed-size request counters, bounded TTFT/TPOT histograms for streaming routes, admission pressure, memory use, response-history size, image queue/cache state, model cache counts, and token expiry state. It never retains metric samples or includes prompts, completions, tool arguments, image content, account names, or token values. API responses always include a safe `X-Request-Id` for correlation. To include the same ID as `request_id` in related terminal and file log lines, start the adapter with:

```bash
ccdx --show-request-id
```

When the saved token is missing, `ccdx` first looks for compatible local Copilot GitHub tokens, validates them with GitHub and Copilot, and imports a valid one before starting device login. It checks explicit token sources (`CCDX_GITHUB_TOKEN`, `CCDX_GITHUB_TOKEN_PATH`, `CCDX_GITHUB_TOKEN_PATHS`) plus common local `auth.json` layouts under application config directories. It does not rely on a specific app name. Generic discovery refuses to choose silently when valid tokens for multiple GitHub accounts are found. After an account is selected, automatic `401`/`403` recovery and in-process token rotation accept only the same GitHub account. Concurrent callers share token refresh work without sharing cancellation, and a still-valid Copilot token may be used briefly after a transient refresh failure. Explicit token variables remain the intentional way to switch accounts.

If Copilot token refresh still fails with `401` or `403`, the saved GitHub token may be expired, revoked, or missing Copilot access. Delete the saved token and start the tool again to trigger GitHub device login:

```bash
rm ~/.local/share/copilot-api/github_token
ccdx
```

### Claude App opt-in

Claude App support is opt-in so the default Codex Desktop and Claude Code setup stays unchanged:

```bash
npx codex-copilot-dx@latest --configure-claude-desktop
```

Or set:

```bash
CCDX_CONFIGURE_CLAUDE_DESKTOP=1 npx codex-copilot-dx@latest
```

This writes a local Claude App 3P gateway profile that points to the adapter root URL, such as `http://127.0.0.1:2026`. The profile uses a generated local bearer key unless `CCDX_CLAUDE_DESKTOP_API_KEY` is set. Later starts restore that key only from the active managed profile when its gateway URL matches the adapter. Once that managed profile is active, successful Copilot model refreshes automatically keep its `inferenceModels` list current without changing the gateway key or other profile settings. Restart Claude App after the initial setup. Later model changes require no profile reconfiguration, although a running Claude App may need to be reopened if it has not reloaded the updated profile yet.

When reusing an already-running adapter, Claude App profile updates require `CCDX_CLAUDE_DESKTOP_API_KEY` or `CCDX_PROXY_API_KEY` so the profile key matches the running process. Otherwise the existing adapter is left untouched.

## Configuration

Environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `ADAPTER_HOST` | `127.0.0.1` | Host for the adapter; only loopback hosts are allowed by default |
| `ADAPTER_PORT` | `2026` | Port for the adapter |
| `CCDX_ALLOW_LAN` | unset | Set to `1` to allow non-loopback `ADAPTER_HOST` values such as `0.0.0.0`; exposes your Copilot-backed adapter beyond this machine |
| `CCDX_MAX_BODY_BYTES` | `67108864` | Maximum compressed/raw request body size |
| `CCDX_MAX_DECODED_BODY_BYTES` | `134217728` | Maximum decoded request body size after decompression |
| `CCDX_MAX_INFLIGHT_BODY_BYTES` | `33554432` | Shared byte budget for admitted request bodies; a larger single request runs exclusively |
| `CCDX_MAX_QUEUED_REQUESTS` | `16` | Maximum body requests waiting for the shared byte budget |
| `CCDX_REQUEST_QUEUE_TIMEOUT_MS` | `120000` | Maximum wait for request-body admission before returning `503` |
| `CCDX_MAX_UPSTREAM_BODY_BYTES` | `31457280` | Strict maximum forwarded Responses body size; larger payloads are adapted locally or rejected with `413` |
| `CCDX_MAX_SSE_BUFFER_BYTES` | `8388608` | Maximum buffered bytes for one unterminated upstream SSE line/event |
| `CCDX_UPSTREAM_TIMEOUT_MS` | `120000` | Timeout for non-streaming upstream Copilot requests |
| `CCDX_STREAM_HANDSHAKE_TIMEOUT_MS` | `120000` | Timeout while waiting for upstream streaming response headers |
| `CCDX_STREAM_IDLE_TIMEOUT_MS` | `120000` | Maximum idle time between upstream streaming body chunks |
| `CCDX_UPSTREAM_RETRIES` | `2` | Retries for safe requests and clearly pre-connect POST failures; capped at `5` |
| `CCDX_UPSTREAM_RETRY_DELAY_MS` | `300` | Initial upstream retry backoff in milliseconds; capped at `5000` |
| `CCDX_AUTO_REVIEW_MODEL` | saved selection or `gpt-5.5` | Copilot Responses model used for Codex Auto-review requests; overrides the interactive selection |
| `CCDX_LOG_PATH` | unset | Mirror terminal logs to a file; set to `1` for `~/.local/share/codex-copilot-dx/debug.log` |
| `CCDX_LOG_LEVEL` | `info` | Set to `debug` to include upstream request attempts, status codes, retry causes, and timings |
| `CCDX_LOG_MAX_BYTES` | `16777216` | Rotate the debug log at this size, retaining one `.1` backup; set to `0` to disable rotation |
| `CCDX_TERMINAL_ANIMATION` | auto | Show a transient comet while an interactive terminal has active requests and no new output for 800ms; set to `0` to disable |
| `CCDX_IMG_MAX_DIM` | `2048` | Max long edge in pixels for image downscaling |
| `CCDX_IMG_QUALITY` | `82` | Initial WebP quality used when re-encoding images |
| `CCDX_IMG_MIN_BYTES` | `100000` | In-bounds images smaller than this are left untouched; oversized images are still downscaled |
| `CCDX_IMG_CONCURRENCY` | `2` | Global concurrent image optimization tasks; values above `12` are capped at `12` |
| `CCDX_IMG_MAX_INPUT_PIXELS` | `40000000` | Maximum decoded pixels accepted by `sharp` for one image |
| `CCDX_IMG_CACHE_MAX_BYTES` | `67108864` | Process-local byte ceiling for cached image optimization results; set to `0` to disable result caching |
| `CCDX_DISABLE_IMG_OPT` | unset | Set to `1` to disable image optimization |
| `CCDX_CONFIGURE_CLAUDE_DESKTOP` | unset | Set to `1` to write the Claude App 3P gateway profile during startup |
| `CCDX_AUTO_LAUNCH` | enabled | Set to `0`, `false`, `no`, or `off` to start the adapter without opening Codex or ChatGPT |
| `CCDX_CLAUDE_DESKTOP_API_KEY` | managed profile or generated for opt-in setup | Explicit bearer key written into the Claude App profile and recognized by the adapter for model discovery |
| `CCDX_PROXY_API_KEY` | unset | Backward-compatible alias for `CCDX_CLAUDE_DESKTOP_API_KEY`; the Claude-specific variable takes precedence |
| `CCDX_CLAUDE_MODEL_ALIASES` | built-in Claude aliases | Comma-separated Desktop-to-upstream aliases, for example `claude-sonnet-4-6=claude-sonnet-4.6` |
| `CCDX_GITHUB_TOKEN` | unset | Explicit GitHub Copilot OAuth token to validate and import before device login |
| `CCDX_GITHUB_TOKEN_PATH` | unset | Explicit file containing a GitHub Copilot OAuth token to validate and import before device login |
| `CCDX_GITHUB_TOKEN_PATHS` | unset | Multiple token files separated by the platform path delimiter (`:` on macOS/Linux, `;` on Windows) |
| `CCDX_GITHUB_LOGIN` | saved account | Require automatic discovery and recovery to use this GitHub login |
| `CCDX_DISABLE_TOKEN_DISCOVERY` | unset | Set to `1` to skip local token discovery and go straight to the saved token or device flow |
| `CCDX_TOKEN_LOCK_TIMEOUT_MS` | `600000` | Maximum time to wait for another local process to finish GitHub token login/import |
| `CCDX_TOKEN_LOCK_STALE_MS` | `900000` | Age after which a stale GitHub token lock file can be removed |
| `CCDX_EXISTING_ADAPTER_TIMEOUT_MS` | `500` | Timeout for detecting an already-running local adapter during startup |
| `CCDX_MODEL_REFRESH_TIMEOUT_MS` | `5000` | Timeout for a Copilot model metadata refresh or live Auto-review model lookup |
| `CCDX_MODEL_REFRESH_INTERVAL_MS` | `7200000` | Interval for refreshing Copilot model metadata; successful lists are cached locally as last-known-good data |
| `CCDX_RESPONSE_HISTORY_MAX_BYTES` | `67108864` | Total in-memory byte budget for locally expanded Responses history |
| `CCDX_RESPONSE_HISTORY_MAX_ENTRIES` | `4096` | Maximum stored incremental Responses history nodes |
| `CCDX_USAGE_PATH` | `~/.local/share/codex-copilot-dx/usage.jsonl` | Local JSONL token usage log |
| `CCDX_USAGE_MAX_BYTES` | `33554432` | Rotate the usage log at this size, retaining one `.1` backup; set to `0` to disable rotation |
| `CCDX_DISABLE_USAGE` | unset | Set to `1` to disable usage logging |
| `CCDX_SHUTDOWN_TIMEOUT_MS` | `5000` | Time to drain active HTTP connections before forcing shutdown |

### Usage logging

The adapter records token usage metadata to `~/.local/share/codex-copilot-dx/usage.jsonl` when upstream responses include usage fields. It logs counts, model names, API surface, and response IDs only; it does not log prompts, completions, tool arguments, or image content.

```bash
ccdx usage
```

### Debug logging

Set `CCDX_LOG_PATH=1` to mirror terminal logs to `~/.local/share/codex-copilot-dx/debug.log`, or set `CCDX_LOG_PATH` to a custom file. Add `CCDX_LOG_LEVEL=debug` to include upstream request attempts, retry causes, status codes, and timings. Debug logs do not include prompts, completions, request bodies, or authorization tokens.

### Image optimization

Long computer-use sessions can accumulate screenshots inside the conversation history. Each screenshot is shipped on later turns, and GitHub Copilot's `/responses` endpoint can reject oversized requests with `408 Request Timeout` while reading the body or `413 Payload Too Large`.

The adapter automatically downsamples embedded screenshots to model-appropriate pixel bounds (with a conservative 2048 px long-edge fallback) and initially re-encodes them as WebP quality 82 before forwarding `/v1/responses`. It never replaces an image with a larger encoding and applies one global concurrency limit across direct, function-tool, and custom-tool output images.

The final serialized UTF-8 request body is measured before forwarding. Above the configured byte limit, unique source images are processed largest-first from their originals at quality 75 / 1600 px and then quality 65 / 1280 px, stopping as soon as the body fits. If necessary, the forwarded view omits older duplicate images, historical tool images, other historical images, and finally old tool outputs while preserving current input and tool-call skeletons. A request that still cannot fit is rejected locally with a structured `413` instead of sending an oversized body upstream.

Completed image transforms are reused from a byte-bounded process-local LRU cache, and concurrent requests for the same transform share one encode. The cache key includes source content, MIME type, model-aware dimensions, WebP quality, and encoder settings; failures are not cached and request cancellation remains isolated.

When expanded Responses history exceeds Copilot's 50-image request limit, the adapter removes older duplicate image occurrences first, then keeps the 50 most recent images. This applies only to the forwarded request: local history remains complete, current images are preferred over older history, and requests at or below the limit are unchanged.

For `/v1/responses/compact`, the adapter sends one terminal `compaction_trigger` in unary mode, validates that Copilot returned completed compaction state, and rebuilds a replayable snapshot from recent system, developer, user, and assistant messages plus every compaction item. Only a validated snapshot becomes a new local history root. Later turns continue from it without re-expanding pre-compaction history; existing older response branches remain available until normal history eviction.

Successful streaming responses are accepted only when the upstream body is SSE and reaches its protocol terminal event. Unexpected EOF becomes a protocol-native stream error, and repeated blank tool-argument deltas are stopped per tool call. Inference responses forward safe quota, retry, model, trace, and upstream request-ID metadata; cookies, authorization, body-length, and encoding headers are not forwarded.

Newer ChatGPT/Codex clients can advertise an `image_gen` namespace that already exists upstream. The adapter removes that exact conflicting client tool before forwarding and retries once only when Copilot explicitly reports an image namespace collision. Image inputs and screenshot optimization remain enabled.

## License

MIT

## Development

```bash
npm ci
npm run verify
npm run bench:payload
```

`npm test` runs the unit and handler-level suite. `npm run test:smoke` starts a real local HTTP adapter with fully injected offline upstreams. `npm run bench:check` enforces relative token-counting performance and request-admission resource limits. `npm run pack:check` verifies the npm tarball contents without publishing. `npm run bench:payload` remains a report-only, isolated-process benchmark for 5-60 MiB image payloads and does not contact Copilot. The CI workflow runs the verification checks on supported Node.js release lines.
