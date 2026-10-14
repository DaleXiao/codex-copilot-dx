# CCDX 0.9.38: explicit npm download-policy compatibility

Date: 2026-10-15. Base: 0.9.37. Candidate; publication receipts follow verification.

## Scope

- The npm updater queries only version, global `allow-remote` and registry fields,
  with bounded subprocess output/time. It never reads the complete credential-
  bearing configuration. Global context matches its installer and cannot silently
  inherit an unrelated working project's permission settings. These checks run
  only for explicit updates, not adapter startup or model/image traffic.
- Ordinary updates retain npm's policy. The new boolean `--allow-remote` is an
  explicit one-install grant for URL dependencies throughout the selected package
  tree, including transitives. It is not a hostname allowlist. No persistent npm,
  registry, PATH, proxy, prefix or client setting is changed. Older npm versions
  without this option receive no unsupported flag; unknown support refuses an
  explicitly requested override before installing.
- Failed installs retain original installer streams and exit status. Under a
  restrictive known policy, guidance says **if** npm reported `EALLOWREMOTE`; it
  does not misclassify every error. There is no automatic retry, source fallback
  or success claim after a nonzero exit. Name/version verification still follows
  a zero installer exit; GitHub remains pinned to the validated stable release.
- Windows retains fixed `cmd.exe /d /s /v:off /c`, separate validated source/tag
  construction and no generic shell mode. The only new installer argument is a
  fixed flag resulting from explicit boolean permission, not user shell text.
- The source lock no longer embeds a developer's corporate smol-toml download URL.
  Its exact version and original integrity remain pinned; npm resolves the registry
  location. It is not a blind mirror-to-public URL substitution. Strict clean
  dependency installation is part of the new npm 12 checks.

This addresses a real installer boundary, not a guarantee that CCDX can bypass
company download policy. If the policy cannot authorize cross-origin tarballs,
the mirror must provide compatible allowed URLs. An old CCDX cannot acquire the
new option before installation; the reference documents an explicit npm bootstrap
command, with the same policy/trust requirement. Running services are not restarted.

## Verification and review

- Baseline local suite: 1,223 passed, eight Windows-only skips, zero failures.
- Final local suite: 1,228 passed, nine Windows-only skips, zero failures. Offline
  HTTP/idle-SSE, all nine isolated startup/reuse scenarios and package dry-run passed.
- Baseline and candidate performance/resource gates pass. Adapter import RSS is
  58.5 -> 58.5 MiB and heap 7.1 -> 7.1 MiB. SSE 1/2/4/8 MiB scan ratios remain
  1.0; eight duplicate images invoke one optimizer and repeated 8 MiB tool output
  parses once. Samples are not statistical speedup or all-machine latency claims.
- Unit tests cover readonly named-field/global policy probes, credential redaction,
  default policy preservation, one-installer-only consent, old/unknown npm support,
  strict CLI parsing, fixed Windows argv and installation-version verification.
- A pinned npm 12.0.1 / Node 24.18.0 matrix is added on Windows, macOS and Linux.
  Loopback-only synthetic registry/CDN/local-Git fixtures exercise real installs and
  updates under same-origin strict policy, cross-origin refusal, explicit consent
  and corrupted-tarball integrity failure. They assert actual npm error classes,
  unchanged user/global config, previous fixture retention on failure, one installer
  launch, and no registry token forwarded to the other origin. Synthetic sharp
  fixtures are not represented as real native-image acceptance.
- Separately, the existing real package lifecycle runs under npm 12 strict defaults:
  install/upgrade CCDX in an isolated prefix, check its version and execute installed
  native sharp. Existing Node 22.15/24 platform, client, browser and startup gates
  remain; no runtime dependency or production npm monkey-patch is added.
- Local fetching of the exact npm 12 package was blocked by this host's TLS path;
  local npm is 10.9.3. Exact-version installation evidence must come from the CI
  matrix, not from a simulated local npm version or a dry-run alone.

## Boundaries and source evidence

npm 12's `allow-remote` options are `none`, `root` and `all`; a mirror's tarball
origin can differ from its metadata origin and fail the registry exemption. See
[npm 12.0.1 config](https://github.com/npm/cli/blob/v12.0.1/workspaces/config/lib/definitions/definitions.js)
and [registry tarball classification](https://github.com/npm/cli/blob/v12.0.1/workspaces/arborist/lib/arborist/reify.js).
CCDX does not silently alter those semantics. The opt-in does not grant every
package script permission or bypass integrity, authentication, offline/cache-only
rules or administrator policy. Real company-network acceptance remains separate.

## Results and publication

Pending final local and cross-platform results, archive hashes and publication receipts.
