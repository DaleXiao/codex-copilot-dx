# codex-copilot-dx

Use Codex Desktop or the ChatGPT app with GPT models provided by your **GitHub Copilot** subscription.

CCDX is a local compatibility adapter. It configures Codex-compatible desktop clients to use an OpenAI Responses API on loopback while GitHub authentication, model discovery, and inference stay backed by GitHub Copilot.

## How it works

One in-process adapter listens on `127.0.0.1:2026` by default and exposes:

- `POST /v1/responses`
- `POST /v1/responses/compact`
- `GET /v1/models`

Responses-only models and compaction use Copilot's Responses transport directly. For GPT models that advertise only Chat Completions, CCDX converts the supported text, image, and function-tool subset and rejects incompatible request shapes explicitly. Both streaming SSE and non-streaming responses are supported.

The adapter preserves Codex and ChatGPT app behavior around response history, encrypted reasoning state, function/custom tools, images, compaction, cancellation, retries, and usage metadata. Model routing follows the live Copilot catalog instead of a hard-coded GPT model list.

### Fast and Standard modes

Codex can select Standard or Fast without changing CCDX configuration. When the client requests `gpt-5.6-sol` with `service_tier: "priority"`, CCDX uses `gpt-5.6-sol-fast` only when the live Copilot catalog advertises that exact model as enabled, selectable, OpenAI-owned, and Responses-only. Standard mode continues to use `gpt-5.6-sol`; CCDX does not invent Fast availability when the upstream catalog does not provide it.

Codex Auto-review uses the hidden `codex-auto-review` model ID. CCDX maps it to Copilot's `gpt-5.5` Responses model by default, independently of the interactive Fast/Standard selection, and logs both model IDs when the mapping is used. The review target can be changed interactively without reinstalling or restarting CCDX.

## Prerequisites

- GitHub Copilot subscription (Individual, Business, or Enterprise)
- Node.js 22.15 or newer, for built-in Zstandard request decompression
- Codex Desktop or the ChatGPT app on macOS

## Install and start

```bash
npm install -g codex-copilot-dx@latest
ccdx
```

`ccdx` is the primary launcher. The old `codex-copilot-dx` executable remains temporarily as a compatibility shim: it prints a deprecation warning at most once every seven days in interactive terminals, runs `ccdx`, and remains silent in scripts. It will be removed in a future breaking release.

For a one-off run without a global install:

```bash
npm exec --yes --package=codex-copilot-dx@latest -- ccdx
```

On a normal launch, CCDX:

1. Prints the installed package version and checks for a newer npm release in the background.
2. Reuses a compatible running adapter when available; otherwise it reuses a compatible local Copilot credential or starts GitHub Device Flow when authentication is required.
3. Refreshes Copilot model metadata and listens on the configured loopback address.
4. Updates `~/.codex/config.toml` to use the local `/v1` endpoint while preserving unrelated Codex settings.
5. Attempts to open Codex Desktop or the ChatGPT app on macOS unless `CCDX_AUTO_LAUNCH` disables it.

The `OPENAI_API_KEY=dummy` value written into the Codex shell environment is only a client-side placeholder. It is not a GitHub credential. CCDX exchanges the saved GitHub OAuth credential for short-lived Copilot service tokens internally.

If a compatible adapter is already running, a later launch reuses it and refreshes the local Codex configuration. After updating the package, stop the old adapter before starting the new version; the CLI refuses to silently reuse an incompatible protocol version.

## Version 0.7.0 migration

CCDX 0.7.0 retires the former Claude App, Claude Code, Anthropic Messages API, isolated Claude account, and PM Studio patch integrations. Their setup, status, restore, profile, and routing commands are no longer supported.

If PM Studio is still patched by an older CCDX release, update or reinstall PM Studio to restore its official application bundle. CCDX 0.7.0 does not patch PM Studio and does not provide a restore workflow.

The upgrade intentionally does not delete or rewrite retired Claude or PM Studio configuration, historical patch backups, or isolated credentials created by older versions. Normal Codex configuration updates continue as documented above. Review and remove obsolete retired-integration state yourself only if you no longer need it.

## Commands

Run `ccdx <command> --help` for command-specific behavior and side-effect details.

### Live models

```bash
ccdx models
```

This performs a fresh, read-only GitHub Copilot model-directory lookup without starting the adapter, opening Device Flow, reading the local model cache, or consuming an inference request. It lists selectable GPT model IDs, providers, advertised APIs, and preview status. Catalog availability does not guarantee that a later inference request will avoid quota, rate-limit, or policy enforcement.

Interactive terminals use aligned tables for `models`, `auth status`, and `usage`. Redirected or piped output retains the plain-text layout for scripts; use `--format table` or `--format plain` when a command offers an explicit format override.

### Auto-review model

```bash
ccdx auto-review-model
```

The selector first queries the running adapter, including its last-known-good model list when live refresh is unavailable, then falls back to the non-expired local model cache. It offers only enabled models that advertise a Responses endpoint.

The selection is saved in `~/.config/codex-copilot-dx/config.json`, or under `XDG_CONFIG_HOME` when set. Choosing `gpt-5.5` clears the override and restores the package default. A running adapter reads the setting on the next Auto-review request.

### Update

Choose a source interactively:

```bash
ccdx update
```

Or choose directly:

```bash
ccdx update npm
ccdx update github
```

`ccdx update gh` is accepted as shorthand for the GitHub source. The npm source installs `codex-copilot-dx@latest` through the registry already configured for npm, including a company mirror. The GitHub source installs the latest commit from `DaleXiao/codex-copilot-dx` `main` and opts in to Git fetching only for that command. It does not change npm's persistent `allow-git` setting.

If a configured npm mirror has not synchronized the current release yet, use the GitHub source. A running adapter keeps its loaded version until it is stopped and restarted.

## Diagnostics

Run a read-only local configuration check:

```bash
ccdx doctor
```

The doctor checks the saved GitHub credential, Codex configuration, and adapter availability without starting the adapter or changing files. It exits with status `1` for an invalid configuration and `0` when results contain only OK or warning rows.

To verify the saved GitHub token, Copilot entitlement, and live models endpoint without starting Device Flow or changing the credential:

```bash
ccdx doctor --online
```

To exercise the protocol through an already-running adapter:

```bash
ccdx doctor --compat
```

The compatibility doctor sends a few minimal Copilot requests covering Auto-review, native Responses, streaming history, and compaction. It consumes a small amount of Copilot usage, never starts the adapter or Device Flow, and does not change client configuration. Combine it with `--online` when both checks are needed.

For a concise summary of the running adapter:

```bash
ccdx status
```

For the complete machine-readable status payload:

```bash
curl -s http://127.0.0.1:2026/_ccdx/status | jq
```

The status endpoint is restricted to the socket's real loopback address even when LAN binding is explicitly enabled. It reports fixed-size request counters, bounded TTFT/TPOT histograms, admission pressure, memory use, response-history size, image queue/cache and adaptive-history state, model-cache counts, and token expiry state. It never retains metric samples or includes prompts, completions, tool arguments, image content, account names, or token values.

Every API response includes a safe `X-Request-Id` for correlation. To include the same ID in related terminal and file log lines, start with:

```bash
ccdx --show-request-id
```

### Authentication recovery

When the saved token is missing, `ccdx` looks for compatible local Copilot GitHub tokens, validates them with GitHub and Copilot, and imports a valid one before starting Device Flow. It checks explicit token sources (`CCDX_GITHUB_TOKEN`, `CCDX_GITHUB_TOKEN_PATH`, and `CCDX_GITHUB_TOKEN_PATHS`) plus common local `auth.json` layouts. Generic discovery refuses to choose silently when valid credentials for multiple GitHub accounts are found.

After an account is selected, automatic `401`/`403` recovery and in-process token rotation accept only that same GitHub account. Concurrent callers share token refresh work without sharing cancellation, and a still-valid Copilot token may be used briefly after a transient refresh failure. Explicit token variables remain the intentional way to select another account.

If refresh still fails with `401` or `403`, the saved GitHub OAuth credential may be expired, revoked, or missing Copilot access. Remove that exact saved token and start again to trigger Device Flow:

```bash
rm ~/.local/share/copilot-api/github_token
ccdx
```

## Security

- CCDX binds to loopback by default. Non-loopback hosts are rejected unless `CCDX_ALLOW_LAN=1` is set explicitly.
- Enabling LAN binding exposes a Copilot-backed API to other reachable machines. Provide your own host firewall and network isolation; do not expose the listener to an untrusted network.
- The GitHub OAuth credential is stored locally at `~/.local/share/copilot-api/github_token`. Short-lived Copilot service tokens remain in process memory and are refreshed as needed.
- Runtime status, usage, and debug logs exclude authorization headers, prompts, completions, tool arguments, and image content.
- Request and response bodies are bounded. Queues, history, image work, SSE parsing, retries, and shutdown all have explicit resource or time limits.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `ADAPTER_HOST` | `127.0.0.1` | Adapter host; only loopback hosts are allowed by default |
| `ADAPTER_PORT` | `2026` | Adapter port |
| `CCDX_ALLOW_LAN` | unset | Set to `1` to permit a non-loopback host such as `0.0.0.0`; this exposes the Copilot-backed adapter beyond this machine |
| `CCDX_MAX_BODY_BYTES` | `67108864` | Maximum compressed or raw request-body size |
| `CCDX_MAX_DECODED_BODY_BYTES` | `134217728` | Maximum decoded request-body size after decompression |
| `CCDX_MAX_INFLIGHT_BODY_BYTES` | `33554432` | Per-pool byte budget for raw bodies, decoded bodies, and materialized response history; a larger item runs exclusively in its pool |
| `CCDX_MAX_UPSTREAM_CHAT_RESPONSE_BYTES` | `67108864` | Maximum buffered successful Chat Completions response used by the internal Responses compatibility path |
| `CCDX_MAX_UPSTREAM_RESPONSES_RESPONSE_BYTES` | `268435456` | Maximum buffered successful native Responses or compact response; streaming Responses use bounded backpressure |
| `CCDX_MAX_QUEUED_REQUESTS` | `16` | Maximum body requests waiting for shared byte admission |
| `CCDX_REQUEST_QUEUE_TIMEOUT_MS` | `120000` | Maximum wait for request-body admission before returning `503` |
| `CCDX_REQUEST_BODY_TIMEOUT_MS` | `120000` | Maximum time to receive and decode a request body before returning `408` |
| `CCDX_MAX_UPSTREAM_BODY_BYTES` | `31457280` | Strict maximum forwarded Responses body size; larger payloads are adapted locally or rejected with `413` |
| `CCDX_MAX_SSE_BUFFER_BYTES` | `8388608` | Maximum buffered bytes for one unterminated upstream SSE line or event |
| `CCDX_UPSTREAM_TIMEOUT_MS` | `120000` | Per-phase timeout for Responses preparation and non-streaming upstream requests |
| `CCDX_STREAM_HANDSHAKE_TIMEOUT_MS` | `120000` | Timeout while waiting for upstream streaming response headers |
| `CCDX_STREAM_IDLE_TIMEOUT_MS` | `120000` | Maximum idle time between upstream streaming body chunks |
| `CCDX_UPSTREAM_RETRIES` | `2` | Retries for safe requests and clearly pre-connect POST failures; capped at `5` |
| `CCDX_UPSTREAM_RETRY_DELAY_MS` | `300` | Initial upstream retry backoff in milliseconds; capped at `5000` |
| `CCDX_AUTO_REVIEW_MODEL` | saved selection or `gpt-5.5` | Copilot Responses model used for Codex Auto-review; overrides the interactive selection |
| `CCDX_LOG_PATH` | unset | Mirror terminal logs to a file; set to `1` for `~/.local/share/codex-copilot-dx/debug.log` |
| `CCDX_LOG_LEVEL` | `info` | Set to `debug` for upstream attempts, status codes, retry causes, and timings |
| `CCDX_LOG_MAX_BYTES` | `16777216` | Rotate the debug log at this size and retain one `.1` backup; set to `0` to disable rotation |
| `CCDX_TERMINAL_ANIMATION` | auto | Show a transient comet while an interactive terminal has active requests and no output for 800 ms; set to `0` to disable |
| `CCDX_IMG_MAX_DIM` | `2048` | Maximum long edge in pixels for image downscaling |
| `CCDX_IMG_QUALITY` | `82` | Initial WebP quality for image re-encoding |
| `CCDX_IMG_MIN_BYTES` | `100000` | In-bounds images smaller than this remain unchanged; oversized images are still downscaled |
| `CCDX_IMG_CONCURRENCY` | `2` | Global concurrent image-optimization tasks; values above `12` are capped |
| `CCDX_IMG_MAX_INPUT_PIXELS` | `40000000` | Maximum decoded pixels accepted for one image |
| `CCDX_IMG_CACHE_MAX_BYTES` | `67108864` | Process-local byte ceiling for cached image transforms; set to `0` to disable the cache |
| `CCDX_DISABLE_IMG_OPT` | unset | Set to `1` to disable image optimization |
| `CCDX_AUTO_LAUNCH` | enabled | Set to `0`, `false`, `no`, or `off` to start without opening Codex or ChatGPT |
| `CCDX_GITHUB_TOKEN` | unset | Explicit GitHub Copilot OAuth token to validate and import before Device Flow |
| `CCDX_GITHUB_TOKEN_PATH` | unset | Explicit file containing a GitHub Copilot OAuth token |
| `CCDX_GITHUB_TOKEN_PATHS` | unset | Multiple token files separated by the platform path delimiter (`:` on macOS/Linux, `;` on Windows) |
| `CCDX_GITHUB_LOGIN` | saved account | Require automatic discovery and recovery to use this GitHub login |
| `CCDX_DISABLE_TOKEN_DISCOVERY` | unset | Set to `1` to skip local token discovery and use the saved token or Device Flow |
| `CCDX_TOKEN_LOCK_TIMEOUT_MS` | `600000` | Maximum time to wait for another process to finish GitHub token login or import |
| `CCDX_TOKEN_LOCK_STALE_MS` | `900000` | Age after which a stale GitHub-token lock can be removed |
| `CCDX_EXISTING_ADAPTER_TIMEOUT_MS` | `500` | Timeout for detecting an already-running local adapter during startup |
| `CCDX_MODEL_REFRESH_TIMEOUT_MS` | `5000` | Timeout for Copilot model refresh or live Auto-review model lookup |
| `CCDX_MODEL_REFRESH_INTERVAL_MS` | `7200000` | Model refresh interval; successful lists are cached as last-known-good data |
| `CCDX_RESPONSE_HISTORY_MAX_BYTES` | `67108864` | Total in-memory byte budget for locally expanded Responses history |
| `CCDX_RESPONSE_HISTORY_MAX_ENTRIES` | `4096` | Maximum stored incremental Responses history nodes |
| `CCDX_USAGE_PATH` | `~/.local/share/codex-copilot-dx/usage.jsonl` | Local JSONL token-usage log |
| `CCDX_USAGE_MAX_BYTES` | `33554432` | Rotate the usage log at this size and retain one `.1` backup; set to `0` to disable rotation |
| `CCDX_DISABLE_USAGE` | unset | Set to `1` to disable usage logging |
| `CCDX_SHUTDOWN_TIMEOUT_MS` | `5000` | Time to drain active HTTP connections before forcing shutdown |

## Usage logging

When upstream responses contain usage fields, CCDX records token counts, model names, API surface, and response IDs in `~/.local/share/codex-copilot-dx/usage.jsonl`. It does not record prompts, completions, tool arguments, or image content.

```bash
ccdx usage
```

The summary covers the current log and its single rotated backup, not an unbounded lifetime history. It reports recorded responses and per-model input, cache-read, output, and total token metadata.

## Debug logging

Set `CCDX_LOG_PATH=1` to mirror terminal logs to `~/.local/share/codex-copilot-dx/debug.log`, or provide a custom path. Add `CCDX_LOG_LEVEL=debug` for upstream attempts, retry causes, status codes, and timings. Debug logs do not include prompts, completions, request bodies, or authorization tokens.

## Large histories and images

Long computer-use sessions can accumulate screenshots that are sent again on later turns. This can increase local preparation time, upstream handshake latency, and the chance of a `413 Payload Too Large` response.

CCDX automatically downsamples embedded screenshots to model-appropriate pixel bounds, with a conservative 2048 px fallback, and initially encodes them as WebP quality 82. It never replaces an image with a larger encoding and uses one global concurrency limit across direct images and function/custom-tool outputs.

The final serialized UTF-8 body is measured before forwarding. Above the configured limit, unique source images are processed largest-first from their originals at quality 75 / 1600 px and then quality 65 / 1280 px, stopping when the body fits. If necessary, the forwarded view omits older duplicate images, historical tool images, other historical images, and finally old tool outputs while preserving current input and tool-call skeletons. Requests that still do not fit receive a structured local `413`.

Completed image transforms are reused from a byte-bounded process-local LRU cache, and concurrent requests for the same transform share one encode. Failures are not cached and request cancellation remains isolated.

Ordinary visual history stays byte-for-byte unchanged while it has at most 24 historical images and the expanded body is at most 18 MiB. Above either threshold, the temporary upstream view keeps every current-turn image and up to 16 recent historical images, targeting 16 MiB. After a preparation, handshake, upstream timeout, or HTTP `408`, the next retry uses an 8-image, 10 MiB recovery window for ten minutes. Two successful requests or a successful compaction clear recovery mode. CCDX never transparently repeats an ambiguous timed-out POST, and it does not delete local history.

When expanded history exceeds Copilot's 50-image request limit, CCDX removes older duplicate occurrences first and then keeps the 50 most recent images. This affects only the forwarded request; local history remains complete and current images are preferred.

For `/v1/responses/compact`, CCDX sends one terminal `compaction_trigger`, validates completed compaction state, and preserves the complete returned window as the canonical next context. Only a validated window becomes a new local history root. Existing older branches remain available until normal history eviction.

Successful streaming responses are accepted only when the upstream body is SSE and reaches its protocol terminal event. Unexpected EOF becomes a protocol-native stream error, and repeated blank tool-argument deltas are stopped per tool call. Safe quota, retry, model, trace, and upstream request-ID metadata are forwarded; cookies, authorization, body-length, and encoding headers are not.

Newer Codex and ChatGPT clients can advertise an `image_gen` namespace that already exists upstream. CCDX removes that exact conflicting client tool before forwarding and retries once only when Copilot explicitly reports an image namespace collision. Image input and screenshot optimization remain enabled.

## Development

```bash
npm ci
npm run verify
npm run bench:payload
```

`npm test` runs unit and handler-level tests. `npm run test:smoke` starts a real local adapter with fully injected offline upstreams. `npm run bench:check` enforces linear SSE scanning, image/tool processing, and request-admission resource limits. `npm run pack:check` verifies npm tarball contents without publishing. `npm run bench:payload` is a report-only isolated-process benchmark for 5–60 MiB image payloads and does not contact Copilot. CI runs verification on the supported Node.js release lines.

## License

MIT
