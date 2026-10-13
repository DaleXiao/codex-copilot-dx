# CCDX 0.9.31: Windows updater process compatibility

This report is historical release evidence, not a guarantee for every npm,
company registry, Git installation or future Windows runtime.

## Cause and bounded fix

`ccdx.cmd update github` resolved 0.9.30 successfully but failed before npm could
start: the updater used `spawn("npm.cmd", ..., { shell: false })`. Windows batch
files require a command interpreter; prior Windows CI did not run the updater's
process tests. POSIX tests and mocked Windows arguments did not establish real
Windows launch compatibility.

Windows now invokes the system `cmd.exe` with `/d /s /v:off /c`, a fixed quoted
`npm.cmd` install command and verbatim Windows arguments. AutoRun and delayed
expansion are disabled. Only fixed package/installer options and an already
validated numeric stable tag enter this command line. No user command is
interpolated, and Node's generic `shell` option remains false.
macOS/Linux retain direct npm execution and exact argv. Environment, terminal
streams, configured registry/proxy and installer exit handling remain unchanged.

The change stays in the existing explicit package-management module. No generic
shell runner, runtime dependency, OS-policy write or coupling to core inference,
native predictions, image tools or dashboard rendering is added.
README, reference, architecture and command help describe Windows `.cmd` usage,
the manual bootstrap for affected old versions and the unchanged Git/registry
requirements. Failed installation is never reported as successful or retried.

## Verification plan and evidence

The 0.9.30 macOS baseline passed 1,153 tests (zero failures, four Windows-only
skips), plus offline HTTP/SSE, performance/resource and package gates.
Unit tests cover both sources, static command construction, hostile tag/source
rejection, exact POSIX behavior, preserved company environment, synchronous spawn
failure, nonzero exits, signals, lookup failure and user cancellation.

Three Windows-only regressions use actual OS child processes, not a mocked
spawn: reproduce the old EINVAL, execute a controlled npm.cmd under a path with
spaces/Unicode/metacharacters, then exercise actual CCDX CLI npm/GitHub updates
and a failing installer. The npm.cmd fixture only records fixed arguments and
selected synthetic environment fields; it never performs a global installation.
A Fetch guard refuses all real network calls, and temporary prefix/cache plus
offline/ignore-scripts settings protect the host if fixture lookup fails.
Both supported Node lines must pass this chain on Windows CI before publication.

The candidate macOS full gate passed 1,157 tests, zero failures and seven skips
(four existing Windows-native checks plus the three new real Windows updater
checks). Offline HTTP/SSE, all performance/resource checks and package checks
passed. A single bounded review confirmed that the interpreter receives only
fixed/validated installer arguments, uses system cmd rather than arbitrary
ComSpec, and has no inferred effect on core request processing. The complete
Windows updater suite is now included in both Windows Node CI jobs; it is not
replaced by the POSIX mocked launch tests.

The first Windows CI run reproduced the original EINVAL and passed the corrected
updater's real batch process on both Node lines. The full CLI test then exposed
a fixture issue: Windows drive paths supplied to `--import` must be file URLs.
The fixture now uses `pathToFileURL`; the production updater was unchanged.
This failed candidate is not used as publication evidence for the full chain.

Final [candidate CI](https://github.com/DaleXiao/codex-copilot-dx/actions/runs/38374770228)
passed all six jobs at `c1721ab2871a8438bffe139905fd318c9f366b5b`:
Windows Node 22.15 and 24 each passed 150 tests with no failures/skips, including
all three real-process regressions and the actual CLI update chain. Linux Node
22.15 and 24 each passed 1,157 tests, zero failures and seven Windows-only skips,
all offline HTTP/SSE/performance/package gates and nine startup/reuse scenarios.
Official Codex synthetic replays and 16 Chromium/WebKit dashboard combinations
also passed. This is real OS process validation with a controlled installer,
not a claim that every user's Git/registry installation was performed.
Local baseline/candidate import RSS was 58.2/58.5 MiB and heap 7/7 MiB; duplicate
image optimizer calls remained one and oversized output bytes were identical.
Timings are report-only; no statistical core speedup is claimed.

The production installer is not exercised against a real registry on a user's
Windows machine by these tests. Company download/SSO restrictions, missing Git,
offline caches and lock permissions remain environment concerns. Versions with
the old launcher need one direct `npm.cmd install` to acquire this fix; after
installation, stop/restart the running CCDX service to load it.

## Upstream reference

[Node child-process Windows batch-file guidance](https://nodejs.org/api/child_process.html#spawning-bat-and-cmd-files-on-windows)
describes the required command-interpreter path; the implementation does not
use generic `shell: true` or change PowerShell execution policy.

## Publication receipts

- Stable [GitHub release](https://github.com/DaleXiao/codex-copilot-dx/releases/tag/v0.9.31),
  tag `v0.9.31` at `a4c823ccb87e37c3712a23368d3ea9b94bf1d011`.
  Runtime source matches the successful `c1721ab` candidate; the intervening
  commit only records verified results in this report.
- [npm publication](https://github.com/DaleXiao/codex-copilot-dx/actions/runs/38375390936)
  succeeded with `codex-copilot-dx@0.9.31`, tag `latest`, 1,157 passing tests,
  all offline smoke/performance/package gates and zero failures.
- npm/GitHub archive SHA-1: `519967545cae00211d7a940b9a47c79fa131206c`.
  GitHub asset digest equals local SHA-256:
  `b3268d80c1b5638be7154dd1da5dfbe263133321d5bd9205faf9893246984bbb`.
  The archive has 135 files and 353,383 bytes; all packed files were compared
  byte-for-byte with committed source. No test fixture or credential helper ships.
- GitHub operations reused the user's existing PAT in memory. npm used the
  existing repository secret; no browser login, substitute credential or local
  registry probe was used. Package creation used a task-owned temporary cache;
  no user's cache ownership, npm configuration or installed package was changed.
- This task does not silently update/restart the user's running adapter or App.
  Affected older Windows installations need the documented manual bootstrap once.
