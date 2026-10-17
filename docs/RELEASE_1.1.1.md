# CCDX 1.1.1 — Clear startup checks and framed terminal status

Date: 2026-10-17 (Asia/Shanghai). Baseline: 1.1.0 / `ff689bb`.
This report records this release's checks and evidence limits; it is not a future
client/network guarantee. Publication receipts are added after publication.

## Resulting behavior

- Startup shows discovered cached/live Provider catalogs, model counts and source,
  plus Claude Code/App configuration. Pending discovery remains pending and does
  not delay the core listener; the running status region follows its latest state.
  Catalogs and configured clients do not establish inference access.
- Normal prediction startup uses one concise conclusion. Exceptions retain reasons,
  required restarts and the details command; environment/recovery diagnostics remain
  available through `ccdx prediction status`, status and doctor.
- The terminal uses a responsive line-framed table for returned usage and inference
  counters. Notices occupy their own row and animation is directly below them.
  Cache read is included in input. Partial usage stays visible. Counters retain
  their protocol scopes; historical notices do not imply an unhealthy core service.
- Data/table preparation remains on the one-second snapshot cadence. Animation
  ticks write only changed rows. Very small, dumb, non-TTY and CI terminals keep
  plain output; verbose and opt-in redacted file diagnostics retain detail.
- Client-originated cancellations are informational rather than warnings. Actual
  failures and timeouts still produce notices and retain their HTTP classifications.
- The WebUI atom and its existing load/manual-refresh motion move into the sidebar
  brand. Dark/light themes, mobile navigation, favicon geometry and reduced motion
  remain supported. Terminal motion settings do not control the WebUI logo.

No runtime dependency, installation hook, inference routing, credential/trust
policy or company npm setting is added or changed. Local installation checks use
the configured company registry; a GitHub source install still needs dependencies
permitted by that registry and npm policy.

## Verification

Local `npm run verify` passed: **1,360 passed, 9 platform skips**, offline smoke,
SSE idle/timeout replay, performance gates and package dry-run. The existing
isolated configuration/startup replay passed all ten modes.

Actual xterm 6.0.0 replay passed six combinations (40/80/120 columns, color/no
color), each with 200 motion frames, stable scroll position, changing counters,
independent notice/activity rows and real terminal reflow through resize/plain
fallback/restore. Image MCP active requests stay outside inference counters.
Local real Chrome passed eight English/Chinese, light/dark and 420/1280px WebUI
combinations, including brand placement, manual refresh and reduced motion.
All upstream data in these presentation replays is synthetic; no paid model
or image call is made.

The actual isolated **1.1.0 → 1.1.1** install/upgrade passed on darwin/arm64 using
the configured company registry, including command entry, installed sharp and
the supported optional broker. No global user installation was changed.

All **14/14** jobs passed in [CI 38996147763](https://github.com/DaleXiao/codex-copilot-dx/actions/runs/38996147763)
at `f1184730400334d2e4ee0af1b12ebdf33c5d37de`, the immutable `v1.1.1` tag.
This includes Node 22.15/24 on Linux/macOS/Windows, strict npm 12 installation
and upgrade, native Codex/Claude synthetic replays, Chromium/WebKit WebUI checks,
and actual xterm cursor/resize replay alongside browser PAC recovery on all three
platforms. These checks do not establish real-tenant M365 entitlement, live model
latency or visible native prediction candidates.

The npm package contains **177 files**, **458,900 bytes**, with no new runtime
dependency or installation hook. SHA-256:
`68aec6d2ee9ed81527b2c05c2670299390cf3993e45627911b41110e8b316e24`.

## Publication

Published to npm `latest` by [workflow 38996632401](https://github.com/DaleXiao/codex-copilot-dx/actions/runs/38996632401).
Its SHA-1 `e80765f659e4e7208c07faae9286a5797fefb8e9` matches the locally verified
artifact. [GitHub Release](https://github.com/DaleXiao/codex-copilot-dx/releases/tag/v1.1.1)
contains the matching tarball and portable checksum file. GitHub's asset digest
and one fresh download both matched the SHA-256 and exact size recorded above.

This Mac's npm origin is blocked by company IT; no direct-origin retry, registry,
proxy, TLS or npm policy change was made. Publication is evidenced by the successful
official workflow and matching artifact, not by local public-registry access.
`ccdx update github` uses GitHub for the source package; dependencies still require
the configured company registry and applicable npm policy. Restart the running
CCDX service after upgrade; release validation did not stop or replace it.

`main` records these receipts separately from the immutable tested tag.
