# Provider migration — 0.10.0 candidate

Status: implementation frozen for cross-platform CI; not published.

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
