# CCDX 0.9.26 — release preparation

Not published. The current test package is `0.9.26-windows.3`; Windows native
composer and company-network verification are outstanding release gates.

## Scope

- GitHub issue [#1](https://github.com/DaleXiao/codex-copilot-dx/issues/1): exact
  HTTP 400 connection-ownership errors now select one reasoning-only recovery.
  Healthy history and unrelated errors are unchanged. Compaction rejection
  returns a structured `ccdx_history_rebuild_required` error instead of dropping
  hidden memory. This is an explicit recovery boundary, not an automatic repair
  of an affected chat whose full plaintext is unavailable to CCDX.
- WebUI: existing seven top cards remain. Client features precede recent
  requests. All lower regions use native keyboard-accessible plus/minus
  disclosures. Previously visible regions start open; refresh buttons are not
  nested in disclosure headings. No added polling or API mutations.
- Windows: verified Store/MSIX entry and profile binding, NTFS key checks,
  OpenSSL discovery, opt-in App-scoped trust and PAC route. A persistent native
  worker adds company automatic routing without changing system proxy or trust.
  Native network policy controls proxy authentication and TLS checks. No MCP,
  Hook, renderer injection, account substitution or automatic sending.

## Verification so far

- Existing Windows `.2` baseline: 1,095 passing tests, one Windows-only skip;
  HTTP/SSE smoke, performance/resource and package gates passed.
- Intermediate candidate: 1,104 passing tests, two Windows-only skips; the same
  full gates passed. These checks ran on macOS with isolated Windows fixtures.
- One bounded implementation review fixed upload buffering, fail-fast worker
  shutdown and diagnostic identifier sanitization. Final gate results, Windows
  CI, UI checks and user-machine results will be appended before release.

## Boundaries

Default-off users do not start a Windows network worker. Static/direct paths and
macOS routing retain their existing agents. Dynamic Windows routing and explicit
proxy environment overrides are not silently combined. Restart after changing
network/PAC policy. A failed optional worker must not stop core inference.
No universal company-policy or future-client compatibility guarantee is made.

The native worker uses the documented
[Windows automatic proxy session](https://learn.microsoft.com/en-us/windows/win32/api/winhttp/nf-winhttp-winhttpopen).
Source/protocol tests do not prove company authentication or visible predictions.
