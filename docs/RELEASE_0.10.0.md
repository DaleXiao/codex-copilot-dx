# Provider migration — 0.10.0 candidate

Status: published to GitHub and npm; superseded by the scoped [0.10.1 correction](RELEASE_0.10.1.md).

## Scope and acceptance

Keep GitHub Copilot as the default Codex provider. Introduce an isolated Microsoft
365 provider, a Claude-only local gateway, explicit Codex backup switching, and
provider-aware status and usage. Prediction and opt-in image generation retain
their existing independent lifecycle and configuration ownership.

1. Freeze the 0.9.41 baseline, then extract the GitHub provider without changing
   its wire behavior. Verify differential requests, streams, errors and history.
2. Independently package silent Microsoft SSO in a bounded short-lived helper.
   Verify account isolation, cancellation, unavailable environments and installs.
3. Add the Claude Messages gateway and owned client configuration. Verify stream,
   tools, model filtering, saved settings and failure isolation.
4. Add explicit Codex routing with capability checks and replay affinity. Verify
   switching, models, auto review, prediction, image delivery and history safety.
5. Add bounded status/usage integration, documentation and owned cleanup.
6. Run one integration review, fix its findings, and complete cross-platform,
   package, live-client and paired performance gates before publication.

M365 discovery or basic text success is not proof of complete client support.
Real App gray-text and image-thumbnail checks must be distinguished from offline
protocol replay. Unverified results remain explicitly unverified.

## Frozen baseline

- Source: `3a211ac0aa3d71bc424a652a03fb8040c5da4ae6`, package 0.9.41.
- Local `npm run verify`: 1,274 passed, nine platform skips, zero failures;
  offline HTTP/SSE, performance/resource gates and package dry-run passed.
- Baseline source and raw output are retained in a task-owned temporary directory
  until final comparison and cleanup. No active CCDX or Codex process was changed.

## Evidence to complete

- GitHub differential and regression suite.
- Independent broker package and silent authorization.
- Claude and Codex protocol compatibility, including tool loops and continuation.
- Prediction and image runtime/client evidence.
- Provider fault, credential, cache and configuration isolation.
- Performance, supported-platform CI and package installation/upgrade.
- Bounded review findings and their verification.
- Published tag, npm package integrity and cleanup receipts.

## Implementation evidence (not release acceptance)

- GitHub extraction: 96 focused routing/stream/history/fast/Auto-review checks
  passed; twelve offline baseline/candidate differential scenarios matched.
- Independent authorization: the separately published Microsoft
  `@azure/msal-node-runtime` 0.20.6 package loaded without installation scripts.
  Its short-lived helper silently acquired a token on the managed macOS host.
  No Copilot CLI installation file or saved CLI credential was used.
- This package has no runtime dependencies or install hook. Its distribution
  includes macOS arm64/x64 and Windows arm64/x64/x86 binaries; a listed binary is
  not yet real-machine acceptance for that platform. The optional download is
  14,604,947 bytes; the added installation cost must be disclosed.
- Independent M365 discovery returned fifteen models (ten Claude, five GPT).
  GPT-6 Sol completed native Responses streaming, a function call and result
  continuation, and an actual compaction response with encrypted compaction.
  All inputs were synthetic. No existing conversation was sent.
- Auth/provider/usage/performance focused run: 54 passed. Claude local HTTP/SSE,
  cache accounting and access-control run: six passed. Configuration/auth/runtime
  ownership run: eighteen passed. These are local tests, not Windows/App receipts.
- Source selection and account/profile history namespaces are explicit. A prior
  response ID cannot address another source by guessing the internal key. An
  explicitly requested provider transfer preserves full visible history and
  refuses opaque tool/compaction content when verified plaintext is unavailable.

Open acceptance work: integration and UI, native client checks, Windows/network
matrix, installed-package tests, paired performance and the bounded final review.

## Frozen candidate verification

- Full local `npm run verify`: 1,323 passed, nine Windows-only skips, zero failures;
  offline HTTP/SSE, performance/resource budgets and package inspection passed.
- Thirteen exact baseline/candidate differential scenarios passed, including the
  actual candidate provider-runtime composition, Fast, Auto-review, tools, native
  image declarations, Chat semantic rejection, truncation and compaction.
- Real managed-macOS silent broker acquisition, discovery and inference used no
  Copilot CLI files, user transcript or interactive sign-in. Discovery observed
  ten Claude and five GPT models on 2026-10-16; this is not a future availability promise.
- Official Claude Code 2.1.295 completed Opus 5.5 text and a Read-tool/result loop.
  Its `haiku` and `sonnet` aliases also completed through the actual gateway. The
  latter checks used only CCDX-written isolated settings, not a test-only beta override.
- Installed Claude App 2.42304.0 visibly listed all ten Claude models, completed
  `CCDX_APP_OK` and a second `CCDX_APP_CONTINUED` turn with Opus 5.5. Its existing
  configuration was restored after the test and the test App was closed.
- Installed Codex runtime `0.162.0-alpha.17.2` used real M365 GPT-6 Sol to select
  the image integration, deliver final image Markdown, edit twice and redisplay
  the original without another image call. Pixels were synthetic: no image-API
  quota was spent. This proves the real runtime's image/tool flow, not a new claim
  about screenshot appearance in every desktop version.
- Through the actual candidate adapter, GPT-6 Sol passed native Responses,
  native compaction plus encrypted continuation preserving a synthetic marker,
  and separate low-effort Auto-review with foreground priority metadata removed.
- Eight real Chromium UI cases passed: English/Chinese, light/dark, 420/1280 px,
  M365 state and provider-filtered usage, refresh and retained user selections.
- Same-browser PAC replay preserved company fallback and recovered without
  restarting the browser. Existing App prediction settings/routes were not changed.
  This is proxy-engine evidence, not an assertion that a real App gray suggestion
  was newly tested in a Windows managed environment.
- Installed-package upgrade from the frozen 0.9.41 artifact to 0.10.0 passed in an
  isolated macOS arm64 prefix; sharp and the optional native broker both loaded.
  The corporate registry did not list 0.9.41 during testing, so the locally packed
  frozen source supplied only that baseline. Dependency registry/policy was not changed.

## Bounded review findings resolved

1. Native Claude Code experimental fields produced a real `invalid_body` response.
   Its documented gateway beta-compatibility option now belongs only to the owned
   M365 Code configuration. Conversation content and permission checks are not stripped.
2. Claude App explicitly rejected one-hour prompt-cache retention. M365 caps that
   TTL to its supported five minutes, retaining content and breakpoint positions,
   exposing an adjustment counter and logging the limitation once. This does not
   claim equivalent one-hour caching and does not affect GitHub.
3. Real M365 rejects native image-generation declarations. A shared, unchanged
   image-tool policy preserves the existing CCDX image functions/MCP; GitHub's
   exact behavior is covered by differential replay.
4. Known same-source history takes precedence over a prior-source switch hint,
   avoiding unnecessary opaque-state rejection when returning to a source.
5. Invalid native-worker requests now clear their timers. The established Windows
   C# filename/class remain available to an older running prediction process
   during package replacement; target credentials and worker lifecycles stay isolated.
6. Explicit Claude API keys, auth helpers, cloud routes and foreign App providers
   are preserved. First-party App configuration is not modified. No beta option,
   provider preference or credential is written into Codex/image/prediction configuration.
7. GitHub-only models retain their original standalone behavior. Doctor follows
   source selection and does not repair inactive GitHub credentials. Usage exports,
   Claude outcome labels, body budgets and bilingual UI checks were corrected.

No further scope expansion is planned. Remaining gates: cross-platform CI,
final paired measurements, publication verification and owned scratch cleanup.
Real Windows MDM authorization/App inference still requires an eligible machine;
CI loading and native-network tests are not equivalent to tenant entitlement.

## Final fault and performance gates

Two explicit fault-injection tests first reproduced coupling between Claude setup
and M365 GPT selection. Both now pass: a busy Claude port does not prevent the
Codex backup, and a GPT-only catalog does not configure or launch Claude clients.
Unknown publisher metadata is excluded without breaking the core status path.

An initial paired loopback comparison measured a 3.86% throughput reduction. This
was retained as a failed performance observation, not declared equivalent. A
bounded hot-path pass removed unnecessary async hops, duplicate affinity work,
ephemeral correlation hashing, header-array construction and context-shape churn.
Source/account isolation and exact wire behavior remain covered by the same tests.

Final medians from four alternating baseline/candidate pairs, same Node 22.20.0
arm64 host, 800 measured requests per run, eight concurrent synthetic streams:

| Metric | 0.9.41 baseline | 0.10.0 candidate |
| --- | --- | --- |
| Requests/s | 3,484.826 | 3,527.237 |
| P50 | 1.868 ms | 1.873 ms |
| P95 | 3.027 ms | 2.975 ms |
| Post-GC heap | 19.311 MiB | 19.593 MiB |
| RSS | 141.305 MiB | 140.820 MiB |

Throughput is +1.22% in this synthetic gate; latency is effectively stable, not
evidence of faster upstream inference. Provider metadata has a small memory cost.
The optional 14.6 MB broker download and supported-platform helper/worker costs
remain disclosed; they are not hidden behind this core-path benchmark.

Final local verification after these fixes: 1,325 passed, nine platform skips,
zero failures. The packaged CLI and synthetic GitHub inference also passed with
only the optional Microsoft broker removed (`m365_broker_missing`), while the
existing image-processing dependencies remained installed.

First CI run `38934430168` passed thirteen of fourteen jobs. The added official
Codex image replay could not start npm's Node-based wrapper because its isolated
test PATH omitted the current Node directory. The harness now includes that exact
runtime directory, without inheriting credentials or the user's full environment.
This was a test-harness startup failure, not an observed image-provider failure;
the complete matrix is being rechecked on the corrected commit.

The corrected matrix `38936038411` passed all fourteen jobs. A final failure-only
Claude fixture then reproduced an error event followed by `message_stop` being
counted as completed. Error events now remain authoritative failures, retain their
original stream bytes, close the upstream reader and use the `upstream_event`
diagnostic origin. This extends the existing HTTP-success/model-completion rule
to the new protocol; it does not add inference retry or change valid replies.

## Release acceptance

- Final production commit: `0cf5d766bd7a4c3f1422e97e33a8f3a04fcb5c9f`.
- Final local verification: 1,326 passed, nine platform-specific skips, zero failures.
- Final CI: [38938690105](https://github.com/DaleXiao/codex-copilot-dx/actions/runs/38938690105),
  all fourteen jobs passed: Linux/macOS/Windows, Node 22.15/24, strict npm 12
  installation/upgrade, native Windows workers, browser recovery, bilingual
  dashboard and official Codex image/tool/history replays.
- Pack inspection: 171 files, no test logs, credentials, downloaded clients or
  experimental files. The optional Microsoft dependency remains registry-resolved.
- GitHub publication uses the same historical, owner-verified PAT as the preceding
  release, in process memory only. npm uses the existing repository publishing
  workflow and secret; no browser sign-in or credential replacement is involved.

Platform distinction: existing Windows behavior and the new native-package,
network, configuration and failure-isolation contracts passed CI. Actual Windows
M365 tenant authorization and Claude App inference are still awaiting eligible-device
feedback; they are not claimed as live-tested. macOS real-client results above are
confirmed. M365 remains entitlement-dependent, and optional-provider failure must
not change the default GitHub route. Known new-provider limits remain Standard-only
GPT service tier, five-minute Claude cache retention and gateway-compatible Code betas.

## Publication

- Tag `v0.10.0` targets `45c975a995f4c79db07b0f244697ca42592c086e`.
- npm publication [38940447545](https://github.com/DaleXiao/codex-copilot-dx/actions/runs/38940447545)
  completed successfully and reported `+ codex-copilot-dx@0.10.0` on the official
  registry with `latest`. GitHub release `v0.10.0` was published with its package asset.
- An additional core-port fixture then found the `ADAPTER_PORT=2027` startup-order
  conflict described in the 0.10.1 report. The immutable npm version/tag was not
  rewritten; the correction is a new patch version.
