# CCDX 0.9.24

## Changes

- Added opt-in native next-message predictions: `ccdx prediction on`, `off`, and
  `status`. Default is off. Native Codex UI handles display, adoption and sending;
  inference uses the conversation's selected model through CCDX. No prediction
  MCP, Hook, skill, panel or client-program patch is required.
- Removed the old prediction MCP/Hook/panel implementation. Startup removes only
  unchanged owned registrations. Inert old entrypoints let preserved customized
  registrations exit cleanly instead of failing with a missing module.
- Preserved image MCP and existing inference, Fast/model routing, history,
  streaming, tools, cache, usage and dashboard behavior.

## Explicit boundary

This is a macOS, user-opt-in compatibility bridge, not an official external
prediction-provider API. It adds App-profile certificate trust and a launch-only
PAC for `chatgpt.com` and `ab.chatgpt.com`. All HTTPS paths on those hosts pass
through the local bridge; only prediction configuration is overlaid. Other hosts
and CCDX inference keep their normal routes. Upstream TLS verification remains on.
There is no OS trust change, account/permission rewrite, credential persistence,
client-program change, renderer injection, automatic message send or global proxy.

Existing proxies are not overwritten. App updates require another explicit
compatibility check. On/off requires quitting/reopening the App to clear cached
configuration and apply/remove its process route. Existing official enabled
configuration is preserved; unknown formats pass through. Future App versions
are not unconditionally guaranteed. No separate prediction-model picker is
claimed; native prediction inherits its conversation model. These boundaries are
documented in `ccdx prediction --help` and the bundled reference.

## Bounded review and fixes

The review was limited to this feature and retirement migration. Findings fixed:

1. Customized old MCP/Hook registrations needed inert compatibility entrypoints.
2. Disabled mode, oversized bodies, cookies, raw paths, SSE and WebSocket errors
   needed faithful passthrough, without POST retries or redirect following.
3. The exact verified App must be the one launched with the PAC.
4. Off must clear profile bindings, while preserving edited trust records and
   allowing cleanup of expired certificates. Failed activation removes only
   newly added trust. Renewal retains old trust until the settings commit.
5. Real bootstrap payloads are about 7 MiB and can omit the prediction entry.
   The configuration buffer is bounded at 16 MiB, with streaming passthrough
   above it. Only the known prediction entry is added where necessary.
6. Real successful Statsig live overlays omit `has_updates`; support follows
   that schema. Full refresh requests avoid mismatched delta checksums.

No unrelated architecture or feature changes were added.

## Verification

- Full local unit suite: 1,063/1,063 passed. One additional targeted expired-
  renewal/failed-commit test was then added; the 12-test profile suite passed.
  HTTP/SSE smoke, performance/resource gates and package checks passed. The only
  final-gate failure was a README wording assertion; the explicit image-default
  wording was restored without weakening the test, and the full gate passed.
- Cold/reused startup replay passed all nine scenarios, including disabled
  images, malformed retired settings, failed/pending image setup and fatal core
  config. Optional feature failures did not stop core requests.
- Real current account: account response forwarded with HTTP 200; real bootstrap
  and successful Statsig live refresh both produced the prediction entry. No
  account or unrelated configuration fields were replaced.
- The upstream prediction-config route returned 404; the opt-in bridge supplied
  its own configuration. Disabling returned the original 404 again. Upstream
  authentication, permission and rate-limit failures remain errors.
- One real GPT-6.1 Sol / low request through the existing CCDX/Copilot service
  returned HTTP 200, completed status and a valid JSON suggestion. No inference
  retry or repeated paid model probe was used.
- Current installed Codex App passed the read-only protocol/signature check.
  Its ASAR hash remains
  `75e397e2280dde93b70a85aa926f4282c728eacc84dfeb15ba7fb6ddd84628af`.
- A disposable headless Chromium profile validated the production certificate
  writer and PAC against loopback-only content, with TLS verification on. It
  rendered the test page with no certificate error; trust and fixture data were
  removed afterward. No real browser/App profile was changed.
- Earlier user-confirmed isolated Codex UI checks covered native grey text,
  adoption, sending, repeated prediction and disabling. Those used synthetic
  account/inference fixtures. They are not represented as a fresh real-account
  UI test; this release does not claim universal client/account compatibility.

The disabled/default path adds no bridge, certificate, prediction inference or
background polling. Enabled predictions consume upstream usage, and selected-host
configuration processing adds bounded local work. No inference-speed improvement
or absolute no-regression guarantee is claimed; the existing performance gates
remain the release baseline.

## Publication

Local package check: 120 entries, 312,401 packed bytes, 991,410 unpacked bytes;
SHA-1 `09b137ba7ac0527c66b2f614a254d4868559d6cb`.

Application commit: `3bca90a5ebdd88305861ba3b9d23340de34e6f03`.

- Node 22.15, Node 24 and latest official Codex jobs succeeded:
  https://github.com/DaleXiao/codex-copilot-dx/actions/runs/38194644767.
- The final CI suite contains 1,064 tests; all passed. Both Node package checks
  match the local SHA-1 above.
- Formal GitHub Release (neither draft nor prerelease):
  https://github.com/DaleXiao/codex-copilot-dx/releases/tag/v0.9.24.
- Exactly one npm publishing workflow succeeded, including prepublish gates:
  https://github.com/DaleXiao/codex-copilot-dx/actions/runs/38194793014.
- npm published `codex-copilot-dx@0.9.24` with `latest`; its 120-file package
  SHA-1 matches `09b137ba7ac0527c66b2f614a254d4868559d6cb`.
- Annotated tag object: `3ab6b75a50ebca0851f6f65d3bb0406ab4c23c3a`.

GitHub uses the previously supplied, identity-checked
DaleXiao PAT, held only in memory. npm uses the repository's existing publishing
secret. No browser login, alternate credential or local npm registry lookup is
required. Cleanup is limited to task-created temporary keys, fixtures, logs and
release helpers; unrelated data and user profiles remain untouched. The evidence
commit does not move the release tag or trigger a second npm publication.
