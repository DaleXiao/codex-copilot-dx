# CCDX 0.9.27

## Scope

- Replace only Windows prediction certificate issuance with Windows PowerShell
  and .NET Framework 4.7.2+ `CertificateRequest`. No Git/OpenSSL lookup, binary
  download, npm dependency, system certificate installation or policy bypass.
- Node creates RSA-2048 keys. The one-shot system helper imports ephemeral keys
  from stdin and returns public certificates only. The CA private key is never
  written to disk; the leaf key retains the existing private PEM/NTFS layout.
- Preserve the 90-day lifetime, SHA-256 RSA signatures, CA path length zero,
  critical name constraints, both exact leaf DNS names and App trust metadata.
- Existing valid credentials, activation/rollback, prediction routing and
  runtime requests retain their existing paths. The macOS OpenSSL generator is
  unchanged. Default-off users do not invoke the new helper.
- README, the bundled reference and architecture describe current prerequisites.
  Historical reports retain their original version-specific evidence. Git is
  still needed for the separate Git-source updater, not for prediction setup.

## Verification

- Unchanged 0.9.26 macOS baseline: 1,108 passing tests, three Windows-only skips,
  zero failures; HTTP/SSE smoke, performance/resource and package gates passed.
- Final macOS Node 22.20 gate: 1,110 passing tests, four Windows-only skips,
  zero failures; the same full gates and nine isolated cold/reused startup
  scenarios passed, with zero live-provider calls.
- [Candidate CI](https://github.com/DaleXiao/codex-copilot-dx/actions/runs/38333885234)
  passed at `a3606d2`: Linux Node 22.15/24 full gates, latest official Codex
  configuration/catalog/synthetic Responses replay, and native Windows Node
  22.15/24. Each Windows job passed all 21 scoped tests without skips.
- Windows certificate tests remove external tools from PATH and mask Git lookup
  roots. Actual .NET issuance, RSA size, 90-day validity, CA constraints and key
  usages, exact leaf DNS names, NTFS privacy, TLS acceptance, untrusted/wrong-host
  rejection and App-owned SQLite trust removal pass. First activation, settings
  commit failure rollback and subsequent credential reuse also pass without
  external certificate commands. Existing network/launch tests remain passing.
- One bounded source/security review checked platform isolation, private-key
  transport, ephemeral Windows keys, unchanged PEM/trust contracts and failure
  cleanup. It addressed JWK component padding, whole-second certificate validity
  and the existing README length contract. No adjacent refactor followed.
- The macOS OpenSSL certificate extensions were inspected as a public reference:
  RSA/SHA-256, CA path length zero, critical name constraints/key usages and both
  leaf DNS names are preserved. macOS issuance itself was not replaced.
- No inference, image, model, dashboard, proxy-worker or launch implementation
  changed; npm dependencies are byte-identical apart from version metadata.
  Performance/resource gates pass; this is not a claim of faster model inference.
- The installed-layout package check located the shipped C# helper correctly.
  All 132 packaged files matched the release commit byte-for-byte.

Visible Windows predictions in 0.9.26 are historical evidence, not a new 0.9.27
live App UI result. Native Windows tests exercise the actual system certificate
API and Node TLS, but do not claim a new Chromium UI or enterprise-authentication
test. Existing valid certificates skip issuance entirely.

## Boundaries

Only Windows certificate setup/renewal changes. Unsupported .NET versions or
company policy failures report an optional-setup error; no OpenSSL fallback,
administrator prompt or disabled TLS verification is added. Company PAC, model
inference, image tools and dashboard code are outside this change.

The helper uses the documented
[CertificateRequest API](https://learn.microsoft.com/en-us/dotnet/api/system.security.cryptography.x509certificates.certificaterequest?view=netframework-4.8.1).

## Publication

- Published stable `0.9.27` on 2026-10-13 (Asia/Shanghai).
- Release/tag target: `59a54c166557c42ef1907f3866c15f1d57c3f898`.
- [Final main CI](https://github.com/DaleXiao/codex-copilot-dx/actions/runs/38334409930):
  all five jobs passed, including native Windows on both supported Node lines.
- [GitHub release](https://github.com/DaleXiao/codex-copilot-dx/releases/tag/v0.9.27):
  latest stable, not draft/prerelease, with the verified package attached.
- [npm publication](https://github.com/DaleXiao/codex-copilot-dx/actions/runs/38334648603):
  succeeded with `+ codex-copilot-dx@0.9.27`, tag `latest`, default access.
- Published npm package: 132 files, SHA-1
  `45b8c97a9f388dc04772d0f25ddbcb4c6fa1c250`, identical to the locally checked tarball.
  GitHub's uploaded asset also matched its SHA-256
  `1232894217e897064d682286ca12fb7619594418e3ad6bb6c43798a20687711c`.

Publication used the same user-provided GitHub PAT as prior successful releases
and the repository's existing npm secret. No browser login or credential
replacement was performed. This receipt-only report update does not change
runtime code or the tagged/published package.
