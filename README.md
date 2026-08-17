# codex-copilot-dx

Use [Codex Desktop](https://openai.com/codex), [Claude Code](https://claude.com/claude-code), and optionally Claude App or PM Studio with your **GitHub Copilot** subscription.

## How it works

A single in-process adapter (port `2026`) exposes both APIs over one Copilot
account by default, or over isolated Codex and Claude accounts when configured:

- **Codex** -> OpenAI Responses API (`/v1/responses`, `/v1/responses/compact`); Responses-only models and compaction proxy directly, chat models convert to Chat Completions.
- **Claude Code** -> Anthropic Messages API (`/v1/messages`, `/v1/messages/count_tokens`), translated to/from Chat Completions.
- **Claude App** -> optional Claude Desktop App gateway profile using the same local Messages API plus local model discovery for the configured gateway key.
- **PM Studio** -> optional macOS app patch that keeps the active PM profile for GPT models while routing enabled Claude models through an isolated CCDX Claude account.

Supports both HTTP SSE streaming and non-streaming.

Codex Auto-review requests use the hidden `codex-auto-review` model ID. The adapter maps it to Copilot's `gpt-5.5` Responses model by default and logs both model IDs when the mapping is used. The target can be changed interactively without reinstalling the package.

## Prerequisites

- GitHub Copilot subscription (Individual, Business, or Enterprise)
- Node.js 22.15+ (required for built-in Zstandard request decompression)
- [Codex Desktop](https://openai.com/codex), [Claude Code](https://claude.com/claude-code), Claude App, and/or a supported PM Studio installation

## Usage

```bash
npm install -g codex-copilot-dx@latest
ccdx
```

`ccdx` is the only documented command and primary launcher. The old
`codex-copilot-dx` executable remains temporarily as a compatibility shim: it
prints a deprecation warning at most once every 7 days in interactive terminals,
runs `ccdx`, and remains silent in scripts. It will be removed in a future
breaking release. For a one-off run without a global install, use
`npm exec --yes --package=codex-copilot-dx@latest -- ccdx`.
Run `ccdx <command> --help` (including `auth login claude --help` and
`pms status --help`) for command-specific behavior and side-effect details.
The read-only `usage`, `models`, `auth status`, and `pms status` commands use
aligned tables in interactive terminals. Redirected or piped output keeps the
legacy plain-text layout for script compatibility; use `--format table` or
`--format plain` to choose explicitly.

To query the models currently advertised as selectable for the saved Codex
Copilot account, run:

```bash
ccdx models
```

This performs a fresh, read-only GitHub Copilot model-directory lookup without
starting the adapter, opening device login, reading the local model cache, or
consuming an inference request. It lists model IDs in a provider, API, and
preview-status table with their
advertised API capabilities and reports the live Claude/Anthropic count. A model
being advertised does not guarantee that a later inference request will avoid
quota, rate-limit, or policy enforcement.

### Separate GitHub account for Claude

The default remains fully backward compatible: Codex and Claude requests share
the existing GitHub authentication. To keep an enterprise account for Codex
while using a different personal account that has Claude models enabled, run:

```bash
ccdx auth login claude --github-login <personal-github-login>
```

This is the only command that may start the additional Device Flow. Before
opening a browser, it checks compatible local Copilot credentials, excludes the
current Codex identity, and reuses an unambiguous valid account. It then verifies
the selected GitHub identity, Copilot entitlement, and an enabled Claude model
before saving anything. It refuses the current Codex account and never changes,
migrates, or deletes the existing Codex credential. The optional login pin is
recommended so a machine with multiple accounts selects only the requested
identity. Use `--reauth` to bypass local discovery and force Device Flow.

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
model endpoint metadata, and credential-bound model caches. Switching either
GitHub account invalidates that profile's old cache instead of borrowing it. If the isolated Claude profile later
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

### PM Studio opt-in patch

CCDX can add the isolated Claude catalog to PM Studio without switching its
active account or profile. GPT requests continue to use the bearer supplied by
the current PM profile; exact enabled Anthropic model IDs use the isolated
CCDX Claude profile. Neither credential is copied into the other application.

The current patch recipes support only the exact, unmodified PM Studio 2.9.7
and 2.9.10 bundles on macOS. This is exact-version support, not a version range:
2.9.11 and other unknown builds remain unsupported until they receive their own
verified recipe. Authorize the isolated Claude profile first, quit PM Studio
and its updater, then run the one-time setup command:

```bash
ccdx auth login claude --reauth --github-login <personal-github-login>
ccdx pms setup
```

Inspect the installed version, exact patch manifest plus executable/signing
integrity, isolated Claude profile, and live relay routing without changing files:

```bash
ccdx pms status
```

`ccdx pm-studio status` and `ccdx pm-studio setup` are equivalent long-form aliases.

`ccdx pms setup` performs only local preflight, backup, staging, integrity,
signing, and replacement work. It never starts Device Flow, the adapter,
Codex, or PM Studio, and it does not modify PM profiles, cached model lists, or
saved PM tokens. Unknown versions, hashes, signatures, partial patches, a
running PM process, insufficient space, and every pre-replacement verification
failure leave the installed App unchanged. If the final read-only verification
after an atomic replacement detects an exceptional filesystem drift, setup
does not attempt a second automatic write: it preserves the verified backup,
retains any diagnostic stage still present, and prints recovery paths. Repeating
setup for the exact installed recipe is idempotent.

The official 2.9.10 artifact can fail macOS's vendor-signature verifier even
though its signing metadata remains readable. CCDX does not generally ignore
that failure: the 2.9.10 exception is accepted only when the complete App tree,
including every file, mode, symlink, and non-volatile extended attribute,
matches the frozen official fingerprint. The staged and installed CCDX patch
must still pass strict ad-hoc signature verification and match the complete
patched-tree record in the backup manifest.

The patch is App-wide: every PM profile sends its Copilot API traffic through
the loopback-only `/pm-ccdx/*` relay. Run ordinary `ccdx` before opening PM
Studio; if port 2026 is unavailable, PM Copilot requests cannot connect. The
relay explicitly supports only the Copilot paths discovered in the validated
2.9.7 and 2.9.10 bundles (`GET /models` and `POST /chat/completions`, `/responses`, and
`/embeddings`) and is not a general-purpose proxy.

Patching replaces the vendor signature with an ad-hoc signature. PM Studio's
updater is not disabled; an official update may overwrite the patch or may
require reinstalling the official App. Setup prints the verified backup and
manifest paths plus the version-matched restore procedure. Never restore a
backup over a different PM Studio version or build.

To restore, first quit PM Studio and its updater. Use the exact verified backup
path printed by setup as `BACKUP_APP`, then confirm that both the installed App
and backup still report the same version/build printed by setup (`2.9.7/2.9.7`
or `2.9.10/2.9.10`):

```bash
BACKUP_APP="<verified-backup-path-from-ccdx-pms-setup>"
/usr/bin/plutil -extract CFBundleShortVersionString raw -o - "/Applications/PM Studio.app/Contents/Info.plist"
/usr/bin/plutil -extract CFBundleVersion raw -o - "/Applications/PM Studio.app/Contents/Info.plist"
/usr/bin/plutil -extract CFBundleShortVersionString raw -o - "$BACKUP_APP/Contents/Info.plist"
/usr/bin/plutil -extract CFBundleVersion raw -o - "$BACKUP_APP/Contents/Info.plist"
```

Only when all four values match the one exact recipe, move the patched App
aside, restore the complete vendor bundle, and verify it before launch:

```bash
RECOVERY_DIR="$(/usr/bin/mktemp -d '/Applications/CCDX-PM-Studio-recovery.XXXXXX')"
PATCHED_APP="$RECOVERY_DIR/PM Studio.app"
mv "/Applications/PM Studio.app" "$PATCHED_APP"
/usr/bin/ditto --rsrc --extattr --acl "$BACKUP_APP" "/Applications/PM Studio.app"
/usr/bin/codesign --verify --deep --strict --verbose=2 "/Applications/PM Studio.app"
ccdx pms status
```

For 2.9.10, the vendor `codesign` command may report the documented upstream
signature failure; in that case the App-patch row from `ccdx pms status` must
still classify the restored bundle as exact supported clean content rather than
integrity drift. If the version check, copy, or both verification paths fail,
do not launch the restored App. Keep the moved patched bundle at `$PATCHED_APP`
and reinstall the official PM Studio instead of applying a version-mismatched
backup. CCDX never runs these restore commands or `sudo` automatically.

To change the model used by Codex Auto-review, run:

```bash
ccdx auto-review-model
```

The selector first queries the running adapter, including its last-known-good
model list when live refresh is unavailable, then falls back to the non-expired
local model cache. It offers only enabled models that advertise a Responses endpoint.
It saves the selection in `~/.config/codex-copilot-dx/config.json` (or under
`XDG_CONFIG_HOME` when set); choosing `gpt-5.5` clears the override and restores
the package default. A running adapter reads the setting on the next Auto-review
request, so it does not need to be restarted.

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
for that command. It does not change npm's persistent `allow-git` setting. Both
paths use npm's global installer without shell
interpolation. A currently running adapter keeps its loaded version until it is
stopped and started again.
If a configured npm mirror has not synchronized the current release yet, use
the GitHub source to install the current `main` revision.

On a normal launch, it will:
1. Print the local package version and check for a newer npm release in the background
2. Reuse a compatible running adapter when available; otherwise authenticate with GitHub if needed, after first trying compatible local Copilot token sources
3. When starting a new adapter, refresh Copilot model metadata and listen on loopback (`127.0.0.1:2026`)
4. Configure Codex (`~/.codex/config.toml`) to use the adapter, including stale shell env base URLs if present
5. Configure Claude Code (`~/.claude/settings.json`) to use the adapter; it creates the file when missing, otherwise backs up `settings.json.bak` before updating the local API env keys
6. On macOS, attempt to launch Codex or ChatGPT unless `CCDX_AUTO_LAUNCH` disables it

Claude Code picks up the new `ANTHROPIC_BASE_URL` on its next launch.

If a compatible CCDX adapter is already running on the configured host and port, a second launch reuses it instead of starting another proxy. The second launch still refreshes Codex and Claude Code config, then exits.

The running adapter reports its package and protocol versions. After upgrading the package, stop the old process before starting the new version; the new CLI refuses to silently reuse an incompatible adapter.

Do not set Claude Code by manually exporting `ANTHROPIC_BASE_URL` or `ANTHROPIC_AUTH_TOKEN` in your shell. Let `ccdx` write the local config files instead. If you previously exported those variables, remove them from shell startup files and restart the terminal before launching Claude Code.

### Diagnostics

Run a read-only config check without starting the adapter or changing files:

```bash
ccdx doctor
```

The command exits with status `1` when it finds an invalid configuration and `0` when checks contain only OK or warning results.

The doctor checks the GitHub token, Codex config, Claude Code settings, Claude
App gateway profile, adapter availability, and an installed PM Studio bundle.
It ends with passed/warning/error totals and deduplicated next-step commands.
An absent PM Studio installation is ignored; unsupported versions are reported
without modification, while integrity drift remains an error.

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

For the complete machine-readable payload, query the loopback endpoint directly:

```bash
curl -s http://127.0.0.1:2026/_ccdx/status | jq
```

The status endpoint is restricted to the socket's real loopback address, even when LAN binding is explicitly enabled. It reports fixed-size request counters, bounded TTFT/TPOT histograms for streaming routes, admission pressure, memory use, response-history size, image queue/cache and adaptive-history state, profile model cache counts, PM relay route totals, and token expiry state. It never retains metric samples or includes prompts, completions, tool arguments, image content, account names, or token values. API responses always include a safe `X-Request-Id` for correlation. If the adapter is not running, the CLI prints the exact start-and-retry command. To include the same ID as `request_id` in related terminal and file log lines, start the adapter with:

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
npm exec --yes --package=codex-copilot-dx@latest -- ccdx start --configure-claude-app
```

The previous `--configure-claude-desktop` spelling remains a compatibility
alias. Startup reports Claude App as ready only when a matching managed gateway
key is restored or the profile is configured in that run.

Or set:

```bash
CCDX_CONFIGURE_CLAUDE_DESKTOP=1 npm exec --yes --package=codex-copilot-dx@latest -- ccdx
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
| `CCDX_MAX_INFLIGHT_BODY_BYTES` | `33554432` | Per-pool byte budget for raw bodies, decoded bodies, and materialized response history; a larger item runs exclusively in its pool |
| `CCDX_MAX_QUEUED_REQUESTS` | `16` | Maximum body requests waiting for the shared byte budget |
| `CCDX_REQUEST_QUEUE_TIMEOUT_MS` | `120000` | Maximum wait for request-body admission before returning `503` |
| `CCDX_REQUEST_BODY_TIMEOUT_MS` | `120000` | Maximum time to receive and decode one request body before returning `408` |
| `CCDX_MAX_UPSTREAM_BODY_BYTES` | `31457280` | Strict maximum forwarded Responses body size; larger payloads are adapted locally or rejected with `413` |
| `CCDX_MAX_SSE_BUFFER_BYTES` | `8388608` | Maximum buffered bytes for one unterminated upstream SSE line/event |
| `CCDX_UPSTREAM_TIMEOUT_MS` | `120000` | Per-phase timeout for Responses preparation and non-streaming upstream Copilot requests |
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

The summary covers the retained current usage log and its single rotated
backup, not an unbounded lifetime history. Its table reports recorded usage
responses and per-model input, cache-read, output, and total token metadata.

### Debug logging

Set `CCDX_LOG_PATH=1` to mirror terminal logs to `~/.local/share/codex-copilot-dx/debug.log`, or set `CCDX_LOG_PATH` to a custom file. Add `CCDX_LOG_LEVEL=debug` to include upstream request attempts, retry causes, status codes, and timings. Debug logs do not include prompts, completions, request bodies, or authorization tokens.

### Image optimization

Long computer-use sessions can accumulate screenshots inside the conversation history. Each screenshot is shipped on later turns, which can increase local preparation time, upstream handshake latency, and the chance of a `413 Payload Too Large` response.

The adapter automatically downsamples embedded screenshots to model-appropriate pixel bounds (with a conservative 2048 px long-edge fallback) and initially re-encodes them as WebP quality 82 before forwarding `/v1/responses`. It never replaces an image with a larger encoding and applies one global concurrency limit across direct, function-tool, and custom-tool output images.

The final serialized UTF-8 request body is measured before forwarding. Above the configured byte limit, unique source images are processed largest-first from their originals at quality 75 / 1600 px and then quality 65 / 1280 px, stopping as soon as the body fits. If necessary, the forwarded view omits older duplicate images, historical tool images, other historical images, and finally old tool outputs while preserving current input and tool-call skeletons. A request that still cannot fit is rejected locally with a structured `413` instead of sending an oversized body upstream.

Completed image transforms are reused from a byte-bounded process-local LRU cache, and concurrent requests for the same transform share one encode. The cache key includes source content, MIME type, model-aware dimensions, WebP quality, and encoder settings; failures are not cached and request cancellation remains isolated.

Before image encoding, CCDX leaves ordinary visual history byte-for-byte unchanged while it has at most 24 historical images and the expanded body is at most 18 MiB. Above either threshold, the temporary upstream view keeps every current-turn image and at most 16 recent historical images, targeting 16 MiB. If that history tree then times out during local preparation, a streaming handshake, or a non-streaming upstream request, or if the upstream returns HTTP 408, the next retry automatically uses an 8-image, 10 MiB recovery window for ten minutes. Two successful requests or a successful compaction clear recovery mode. CCDX never transparently repeats the ambiguous timed-out POST, and no local history is deleted; retrying does not require restarting the service.

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
