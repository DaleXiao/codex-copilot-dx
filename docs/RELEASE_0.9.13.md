# CCDX 0.9.13 verification report

Date: 2026-10-08. Baseline: `ac8a7bf` (0.9.12).

## Scope

- Extend `ccdx auto-review-model` with a numeric reasoning-effort menu after
  model selection. Reuse the existing model-directory request and its cached
  fallback. Show only recognized advertised efforts; do not invent capabilities
  when metadata is absent. GPT-6.1 Sol excludes `none`/`minimal`, which its
  official specification rejects even when Copilot metadata lists them:
  https://developers.openai.com/api/docs/models/gpt-6.1-sol.
- Save both choices with one existing atomic settings write, after both prompts
  complete. Cancel/interrupt either prompt without changing either setting.
  Preserve current valid effort; otherwise offer `low` when advertised. Effort
  zero follows the client, with `low` when the client omits effort.
- Store effort with its model identity. Environment model overrides retain
  precedence and never inherit a different model's saved effort. A null marker
  remembers an explicit client-following selection without overriding requests.
  Missing/invalid runtime effort settings preserve existing model preferences.
- Only `codex-auto-review` applies a saved effort. JSON, SSE and compaction retain
  other reasoning fields, native routing and existing inherited-tier removal.
  Existing clients without effort configuration retain 0.9.12 behavior. Current
  adapters read one settings snapshot per review request, no foreground settings
  lookup or new inference-path network request. Legacy string model resolvers
  remain supported.
- No change to client files, primary model/reasoning, Fast selection, permissions,
  approval policy, transport retries, images or dependencies. Update help/README
  and version to 0.9.13. Older running adapters must upgrade/restart before they
  can apply the new effort setting; the CLI states this requirement.

## Verification and bounded review

- Before editing: all 22 targeted model/settings/selector tests, 10 focused
  adapter tests and performance/resource checks passed.
- Final `npm run verify`: all 933 tests, offline HTTP smoke, performance/resource
  gates and package dry-run passed. Isolated startup replay passed image-disabled,
  optional-image-conflict and invalid-config cases.
- Regression coverage includes capability filtering and malformed metadata,
  one model lookup, live/cache sources, invalid numeric input, current/default
  choice, cancellation/interruption, no pre-confirmation write, atomic paired
  settings, permission/unrelated-key preservation, model-binding, environment
  precedence, malformed-setting isolation and one snapshot read. JSON/SSE/compact
  cover hot medium/high updates, client following, legitimate `none` on another
  model, preserved summaries, foreground isolation and one upstream invocation.
- Real terminal test used the running adapter's model directory, entered model
  1 and effort 2, and saved `gpt-6.1-sol` / `medium` only in an owned temporary
  XDG configuration directory. GPT-6.1's menu displayed low/medium/high/xhigh/max,
  not none/minimal; user configuration and the active adapter were untouched.
- One live check loaded that exact CLI-created setting through the candidate
  HTTP handler. A synthetic client's `low` request was forwarded as `medium`,
  retaining its summary field. Copilot returned HTTP 200, completed status,
  valid four-field Guardian JSON and the expected allow decision. Response
  metadata also reported `medium`. Exactly one model invocation, no retry;
  6.715 s including token refresh. The sample action was data and never executed;
  no credentials/opaque response state were recorded. The test listener closed.
- This is effort-selection compatibility evidence, not a comparison proving
  medium/high safer or faster. Higher effort can add upstream latency/usage;
  the default remains GPT-6.1 Sol / low and unconfigured behavior is unchanged.
- Baseline/candidate import heap: 7 MiB. SSE scan ratios: 1 for 1/2/4/8 MiB.
  Native SSE parse/copy counts, writes, drains, content and cancellation invariants
  were identical; retained image array-buffer growth remained zero and tool-output
  parse count remained one. Both resource gates passed; no speed gain is claimed.
- One bounded source/UX review found Enter would turn a previously explicit
  client-following choice into low. The null marker and a repeat-Enter regression
  fix that state-loss issue. Final gates were rerun once after this fix; no scope
  expansion, weakened test or recursive review loop. `git diff --check` passed.

## Publication and cleanup

- Application commit/tag: `d3e57963c2f17a3a0a57167ae05e7a58e776317b` /
  `v0.9.13`. Report-only publication updates do not move the tag or change npm
  package bytes.
- GitHub CI passed on Node 22.15 and 24:
  https://github.com/DaleXiao/codex-copilot-dx/actions/runs/37719841890.
- Formal GitHub Release, not a draft/prerelease:
  https://github.com/DaleXiao/codex-copilot-dx/releases/tag/v0.9.13.
- Exactly one npm publish workflow succeeded, including prepublish verification:
  https://github.com/DaleXiao/codex-copilot-dx/actions/runs/37719998805.
  The official receipt confirms `codex-copilot-dx@0.9.13`, `latest`, 101 files
  and SHA-1 `74f31e1d004528bd2601f866735d5b80d264fa98`, matching local
  preflight's 276,636-byte package.
- GitHub used the previously supplied, verified DaleXiao PAT without printing
  or persisting its value; npm used the existing repository NPM_TOKEN. A single
  independent query directly to the official npm registry returned ENOTCONN;
  publication was not repeated. Successful official publish receipt/checksum
  confirmation is distinct from a local registry read.
- Cleanup is limited to this run's temporary scripts, logs, npm query cache and
  test configuration. Preserve real user settings/credentials, dependencies,
  saved evaluation results and the active adapter. Final handoff checks include
  a clean checkout, no untracked workspace garbage and synchronization with main.
