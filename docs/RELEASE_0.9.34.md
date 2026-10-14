# CCDX 0.9.34: clear startup and bounded prediction recovery

## Scope

- A favicon-style atom made from static ANSI-green half-blocks, only on a wide
  interactive color terminal. Plain-title fallbacks respect narrow output,
  `NO_COLOR`, `TERM=dumb` and redirection. No graphics/font/runtime dependency.
- Aligned status tags, startup checks and the common left-aligned Ready footer.
  Cold start and service reuse retain their distinct ownership; reuse never
  advertises Ctrl+C as a way to stop another foreground process. Model refresh
  prints a count instead of wrapping a long list; `ccdx models` retains that list.
- Separate prediction listener recovery and closed-profile route ownership.
  Same-port recovery is single-flight, checked every 30 seconds and limited to
  three attempts per process. Startup conflicts are not repeatedly retried.
  Company worker failure can close/recreate only that optional bridge. No App
  restart, port stealing, model request replay or global proxy/trust change.
- An initialized closed profile in a direct environment may receive the owned
  PAC preference. Ownership intent precedes the one-field preference change;
  concurrent edits, malformed files, symlinks and explicit user proxies are
  preserved. Off restores only the owned field and preserves unrelated edits.
  Company routing remains on the existing launch-argument path. A previously
  owned persistent route is removed before a closed-App launch on company routing.
- Changed App metadata triggers a bounded reuse of the existing signature,
  protocol, App identity and profile checks, preserving the port and trust.
  Unknown/incompatible App changes still fail the optional integration safely.
- CLI snapshots distinguish launch arguments, saved preferences, observed
  configuration traffic and unknown candidate visibility. WebUI recognizes the
  new recovering state without claiming gray-text success.

## Architecture and safety review

`startup-ui.mjs` owns presentation only. `native-prediction-route.mjs` owns the
bounded closed-profile transaction. `native-prediction-recovery.mjs` owns optional
bridge supervision; platform checks remain in their existing modules. Dependency
direction and import-cycle assertions cover these boundaries. Core Responses,
Fast selection, compaction/history, image generation/editing and company routing
policies are not replaced. Prediction-disabled startup starts no bridge/recovery
timer or platform probe. Image-disabled startup still installs no image MCP/skill.

One bounded review addressed status-tag spacing (including DEBUG), README brevity,
stale replay assertions, company-route transitions and the dashboard's transient
state label. No unrelated optimization or dependency upgrade was added. Clarify
and polish guidance informed the concise copy and shared alignment; their
unavailable impeccable dependency was not installed.

The first cross-platform candidate passed all other jobs but Windows/Node 22.15
exposed a retained same-process synchronous lock in the new route writer's repeated
operation checks. The new writer now uses the project's existing asynchronous
ownership lock, as the prediction settings lifecycle already does. Shared
synchronous-lock security rules were not weakened or refactored. The affected
route lifecycle and both calling boundaries are awaited and revalidated.

## Local verification

- Baseline 0.9.33: 1,168 passed, eight Windows-only skips, zero failures.
- Candidate: 1,188 passed, eight Windows-only skips, zero failures. The final
  dashboard/translation/documentation follow-up also passed 18 focused checks.
- Offline HTTP/SSE smoke passed. Nine isolated actual-CLI startup cases passed:
  cold start, reuse, core availability, optional image conflicts/failures,
  disabled-image isolation and invalid-core-config preservation.
- Real temporary TLS/CONNECT bridge closure followed by supervised restart
  passed on the exact cached address/certificate, with the same client route.
  This is transport evidence, not a logged-in App gray-text test.
- Persistent route tests cover field restoration, unrelated values, idempotent
  writes, company/user proxy preservation, concurrent changes, malformed/oversized
  files and ownership conflicts. App-update tests preserve port/trust and reject
  changed App/profile identity or concurrent settings changes.
- Existing performance/resource gates passed. Single local samples varied:
  adapter-import RSS was 59.0 -> 58.6 MiB; SSE scan ratio remained 1; native stream
  bytes, backpressure and cancellation checks retained their results; warm image
  reuse retained eight cache hits per repeated sample and zero retained
  ArrayBuffer growth. Elapsed times varied in both directions (5 MiB x4 payload
  preparation 118.5 -> 135.3 ms; 30 MiB x1 153.2 -> 150.7 ms). These are not a
  controlled statistical speedup/no-regression proof or upstream latency claims.
- Package dry-run passed and includes the three new production modules, with
  no release helper or credentials. Local company-registry package-upgrade
  verification initially returned ETARGET for the already-published 0.9.31
  baseline; a single official-registry attempt then returned ENOTCONN. Neither
  changed the permanent registry or user installation. Real install/upgrade is
  delegated to the same required CI checks on all three operating systems.

## Compatibility limits

This release does not claim that a running App with no route can be hot-attached.
First-time persistent-route migration requires a normal closed-App launch, not
an automatic forced restart. Saved preferences, HTTP 200 and a recovered listener
do not prove a displayed suggestion. App-side configuration caches, proxy
backoff, account access and prediction triggers still affect observed behavior.
No new real-account UI proof or live Windows/macOS corporate-network claim is
inferred from CI or synthetic tests. Existing user App/services were not restarted
for the local tests.

## Cross-platform and publication receipts

The final CI and GitHub/npm publication results are recorded after the candidate
passes those gates. The previously provided PAT is used in memory for GitHub;
npm publication uses the existing repository secret. No credential is packaged.
