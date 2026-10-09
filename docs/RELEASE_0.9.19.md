# CCDX 0.9.19 verification report

Date: 2026-10-09. Baseline: `a598a9f` (0.9.18).

## Delivered scope

- Normal startup checks the fixed public GitHub latest-Release endpoint instead
  of `registry.npmjs.org`. No PAT, Copilot token, cookies or authentication header.
- One check per launch, a two-second deadline covering headers and response body,
  256 KiB metadata cap, no redirects/retries/polling/npm fallback. Only a valid
  stable version tag on a non-draft/non-prerelease resource can trigger a notice.
- Notices name the installed/latest versions and suggest `ccdx update github`,
  followed by restarting CCDX. No automatic install or service restart.
- On reuse, the existing service and Ready message are available before awaiting
  the remaining bounded check. Command exit may wait for the remainder of the
  two-second budget; service readiness and inference do not wait for it.
- GitHub/gh manual updates resolve a stable Release once (ten-second deadline)
  and pin its exact validated tag in the existing npm Git installer. `main` is
  no longer the default GitHub update target. Failed lookup starts no installer.
- npm updates, aliases, interactive selection/cancellation, Windows npm.cmd,
  shell-free spawning, inherited registry/environment and restart notice remain.

This changes only update checks/install selection and their documentation.
Request/streaming/history/image/model/Auto-review/Fast/dashboard code and policy
are unchanged. No dependencies, background worker, persistent update cache or
global npm configuration changes were introduced.

## Verification

- Clean baseline `npm run verify`: 971 tests, HTTP/SSE smoke, performance/resource
  gates and package preflight passed before edits.
- Targeted update/CLI/documentation checks: 33 passed. Coverage includes numeric
  versions, unsafe tags, drafts/prereleases/missing fields, malformed JSON,
  HTTP 403/404/429/500, body cancellation, oversized/chunked metadata, stalled
  headers/body deadlines, exactly one anonymous lookup, no fallback, exact tag
  installation, ignored untrusted download URLs, manual npm without a GitHub
  query, preserved mirror/environment, cancellation and installer failures.
- Six real CLI child-process replays passed using synthetic credentials, isolated
  configuration and loopback servers: delayed new release on both entrypoints,
  current release, offline, malformed and timeout. Cold/reuse Ready precedes
  delayed results; reuse retains one notice before exit; failed checks remain
  silent. Each child makes one release lookup and zero npm-registry requests;
  config bytes/mtime survive reuse and core Responses remains available.
- Candidate `npm run verify`: all 985 tests passed with zero failures,
  cancellations or skips, plus existing HTTP smoke/SSE idle, performance/resource
  checks and package preflight. Existing Fast/Auto-review, encrypted history,
  model/client catalogs, image opt-in/editing/delivery and dashboard tests pass.
- Existing isolated config/startup replay also passed optional-image conflicts,
  failures, disabled-image paths, cold start/reuse and invalid shared config.
- One live anonymous GitHub lookup using the candidate returned stable v0.9.18
  in 1,344.7 ms. Its generated installation plan pinned that tag; no installer
  was executed. No live inference/image calls or real config/credential changes.
- After publication, a default-budget check was skipped silently once; its HTTP
  cause was not recorded. A single diagnostic read returned HTTP 200 and v0.9.19.
  The final instrumented candidate check then returned latestVersion 0.9.19 and
  updateAvailable true in 1,387.4 ms, under the normal two-second budget. No
  retry loop, authentication fallback, npm query or installer was used.
- One bounded source/test review found no remaining production npm-check URL
  or `main` update target. Version API result shape stays compatible: the
  before/after injected lookup returns the same update result, with only the
  captured source URL changing. `git diff --check` passed.

## Performance and compatibility boundaries

Native SSE output, parse/copy/write/drain counts, backpressure, cancellation and
zero reads while blocked match the baseline. Large tool output parses once,
duplicate images optimize once, repeated image work settles within the original
retention budget. Admission/history/provider paths were not changed.

Single-run adapter import was 40.8 versus 40.0 ms, RSS 58.3 versus 58.1 MiB,
and retained import heap 7 MiB in both. Large-body timings varied by about 1-2%;
one 30 MiB single-request RSS sample was 220.4 versus 228.3 MiB, while the other
samples were almost identical. These machine-dependent observations are not
throughput or memory-improvement claims; all original resource gates passed.

The proven user benefit is removal of unsolicited startup npm requests and
consistent stable-release update selection. GitHub updates still use npm as
the installer: runtime/native dependencies may contact npm's configured registry.
Use an organization-approved mirror/cache when needed. Do not claim entirely
registry-free installs, bypass company controls, disable auditing or add a
secret/authentication flow to public update checks.

## Publication and cleanup

Final local preflight: `codex-copilot-dx@0.9.19`, 111 files, 290,867 packed bytes,
SHA-1 `22f6d723ac92b5d5002da1790ba903606f246c11`.

The earlier verify preflight preceded the new documentation-index entry. npm
automatically includes `docs/README.md`; its added 80 bytes explain the older
290,833-byte/`5965217635fd681659f7e6fe273e051f333bdd62` result. The final local
preflight and official publish receipt match. No production code changed and
no second publication was attempted.

- Application commit/tag: `6466cac2bfd9f9ebd69eab76fa44703b102122f0` /
  `v0.9.19`. Annotated tag object:
  `23a7e10e7b01a7e09a2d4e384054afe95cedc727`. Report-only updates do not move it.
- Node 22.15 and 24 CI passed full verification and startup replay:
  https://github.com/DaleXiao/codex-copilot-dx/actions/runs/37875906801.
- Formal GitHub Release, neither draft nor prerelease:
  https://github.com/DaleXiao/codex-copilot-dx/releases/tag/v0.9.19.
- Exactly one npm workflow succeeded, including 985 tests and prepublish gates:
  https://github.com/DaleXiao/codex-copilot-dx/actions/runs/37876180733.
  Official receipt confirms version 0.9.19, `latest`, 111 files and the final
  matching SHA-1 above.

GitHub used the previously supplied, identity-verified DaleXiao PAT only in
process memory; npm used the repository's existing NPM_TOKEN. No local npm
registry metadata query was made on this corporate machine.

Cleanup is limited to owned baseline copies, temporary release helpers/logs and
test profiles. Preserve dependencies, actual settings/credentials, the running
adapter and this report. Final handoff requires a clean, synchronized checkout.
