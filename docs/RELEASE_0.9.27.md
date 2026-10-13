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

Verification and publication receipts will be recorded after the bounded gates
complete. Native Windows certificate tests are required; POSIX mocks alone do
not establish that the system .NET helper compiles or that Chromium accepts its
certificate. Visible Windows predictions in 0.9.26 are historical evidence,
not a new 0.9.27 live UI result.

## Boundaries

Only Windows certificate setup/renewal changes. Unsupported .NET versions or
company policy failures report an optional-setup error; no OpenSSL fallback,
administrator prompt or disabled TLS verification is added. Company PAC, model
inference, image tools and dashboard code are outside this change.

The helper uses the documented
[CertificateRequest API](https://learn.microsoft.com/en-us/dotnet/api/system.security.cryptography.x509certificates.certificaterequest?view=netframework-4.8.1).
