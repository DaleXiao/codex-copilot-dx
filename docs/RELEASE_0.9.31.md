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

The production installer is not exercised against a real registry on a user's
Windows machine by these tests. Company download/SSO restrictions, missing Git,
offline caches and lock permissions remain environment concerns. Versions with
the old launcher need one direct `npm.cmd install` to acquire this fix; after
installation, stop/restart the running CCDX service to load it.

## Upstream reference

[Node child-process Windows batch-file guidance](https://nodejs.org/api/child_process.html#spawning-bat-and-cmd-files-on-windows)
describes the required command-interpreter path; the implementation does not
use generic `shell: true` or change PowerShell execution policy.
