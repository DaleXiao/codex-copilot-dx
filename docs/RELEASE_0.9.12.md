# CCDX 0.9.12 verification report

Date: 2026-10-08. Baseline: `181b44d` (0.9.11).

## Scope

- Change only the hidden `codex-auto-review` default target from `gpt-5.5` to
  `gpt-6.1-sol`. Saved selections and `CCDX_AUTO_REVIEW_MODEL` retain their
  established precedence; existing explicit GPT-5.5 selections are not rewritten.
- Keep native Responses routing and the existing removal of inherited review
  speed tiers. When an Auto-review request omits reasoning effort, supply `low`
  rather than allowing GPT-6.1 Sol's upstream `medium` default. Preserve explicit
  efforts and other reasoning fields on JSON, SSE and compaction requests.
- Foreground model IDs, reasoning parameters, Fast selection and approval rules
  remain unchanged. No client patch, new retry/fallback, dependency, background
  work or image/configuration migration was added.
- Update the selector/default documentation and package version to 0.9.12.

## Evidence and limits

- Current official model documentation confirms GPT-6.1 Sol supports `low`;
  explicit `none`/`minimal` remain unsupported, not silently remapped:
  https://developers.openai.com/api/docs/models/gpt-6.1-sol.
- OpenAI's October 14 GPT-5.5 retirement notice covers ChatGPT, Work and Codex,
  not the OpenAI API. It does not establish GitHub Copilot's withdrawal date:
  https://learn.chatgpt.com/docs/models#gpt-55-retirement.
- The earlier fixed 24-case, low-effort A/B trial produced identical allow/deny
  outcomes. Completion medians were 2.373 s for GPT-5.5 and 3.526 s for GPT-6.1
  Sol. This is a lifecycle/default migration, not a claim of faster inference or
  proof of equivalent production security. No repeated A/B loop was performed.

## Verification and bounded review

- Baseline: 20 settings/model/selector tests, nine focused adapter tests and
  existing performance/resource checks passed before editing.
- Candidate: `npm run verify` passed all 923 tests, offline HTTP smoke,
  performance/resource checks and package dry-run. Isolated startup replay
  passed disabled-image, optional-image-conflict and invalid-config scenarios.
  Initial sandbox runs could not open loopback listeners (`EPERM`); the same
  checks passed with the required execution permission, without code workarounds.
- Regression coverage checks default selection/reset, persisted legacy GPT-5.5
  selection, environment precedence and missing model availability. JSON, SSE
  and compact cases verify `low` defaults, explicit low/high preservation,
  reasoning-summary preservation, unchanged foreground requests and one upstream
  invocation. Existing Fast/Standard, history, image and cancellation tests pass.
- One additional live Copilot check exercised the candidate HTTP handler with
  `codex-auto-review`, no configured model override and no supplied effort. The
  upstream request was `gpt-6.1-sol` / `low`; HTTP 200, `completed`, the four-field
  Guardian contract and the expected allow decision were verified. Exactly one
  model invocation, no retries; 5.417 s end-to-end including auth refresh. The
  synthetic proposed action was never executed. No credentials or opaque response
  state were recorded; the isolated listener was closed.
- Adapter import heap remained 7 MiB. SSE scanning remained linear at one scan
  per input byte on 1/2/4/8 MiB inputs. Existing native stream/content/backpressure,
  tool-output parse and retained-image resource checks passed before and after.
  Absolute timings are environment-dependent; no inference-speed gain is claimed.
- One bounded source/diff review confirmed the effort default is limited to the
  review alias on both handlers, preserves explicit reasoning and leaves request
  cancellation, client settings, approval policy and transport retries untouched.
  `git diff --check` passed; no unrelated cleanup/refactor or test weakening.

## Publication and cleanup

- Application commit/tag: `1303f1fa5b3e074dec95c17c2208902e7b6dc88e` /
  `v0.9.12`. Report-only publication updates do not move the tag or change the
  npm package bytes.
- GitHub CI passed on Node 22.15 and 24:
  https://github.com/DaleXiao/codex-copilot-dx/actions/runs/37717714325.
- Formal GitHub Release, not a draft/prerelease:
  https://github.com/DaleXiao/codex-copilot-dx/releases/tag/v0.9.12.
- Exactly one npm publication succeeded, including its prepublish verification:
  https://github.com/DaleXiao/codex-copilot-dx/actions/runs/37717888221.
  The official npm receipt confirms `codex-copilot-dx@0.9.12`, `latest`, 101
  files and SHA-1 `c97bfc65fdd21193a8ff83e50a15d6603f0b2907`, matching the
  local 275,091-byte package preflight.
- GitHub used the previously supplied, verified DaleXiao PAT without printing
  or persisting its value; npm used the existing repository NPM_TOKEN. The
  machine's default npm registry is a package-feed mirror; a query during
  publication returned 404. One independent query directly to the official npm
  registry returned ENOTCONN. Publication was not retried; successful official
  publish receipt/checksum confirmation is distinct from a local registry read.
- Cleanup is limited to this run's temporary release/probe scripts, logs and
  identified npm diagnostic logs. Preserve user settings, credentials, existing
  dependencies, saved evaluation results and the active adapter. Final handoff
  checks include a clean checkout, no untracked workspace garbage and remote sync.
