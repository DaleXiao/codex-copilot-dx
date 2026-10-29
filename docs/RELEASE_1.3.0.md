# CCDX 1.3.0

Date: 2026-10-29. Baseline: 1.2.33 (`175e0b7`).

## Resulting behavior

The terminal keeps one live source/app summary, labels the Web UI address directly and displays retained client settings as `Unchanged`. Ordinary startup checks are transient; warnings and device-code instructions remain visible. Model details expand without shifting catalog columns, and API-editor capabilities open below their selected row. Existing themes and motion remain.

One command grammar and the single `ccdx` executable replace old roots/aliases. Image and native prediction handlers, including offline status, keep their existing setup, trust, routing and generation behavior. Recorded usage keeps its table/cache-hit display, labels rows as Records and escapes terminal-controlled fields.

Only macOS and Windows x64/ARM64 are shipped. This platform/command change is intentional and the 1.3.0 version was explicitly selected by the maintainer. Saved account, model, history and configuration formats are retained.

## State and configuration protection

- Connection operations have named local preparation/selection handlers while retaining the serial queue, revision checks, secret commit/retirement points and client synchronization order.
- Codex, Claude preparation/writing and shared App/Code capability reconciliation have separate local responsibilities. Desktop inspection remains at its existing await point; clients are not synchronized in parallel.
- Full snapshots reuse a client plan within that snapshot, including source-impact projection. Public objects remain isolated, with the same fields, revisions, route IDs and access interpretation. No global cache was added.
- Graph persistence skips identical serialized writes under the existing lock. Original-byte v1 backup and first-write migration remain; reads do not migrate files. Explicit synchronization/credential actions are not skipped.
- Native login files/stores, key references, source identity, model selections/defaults, manual capabilities and manual-sync choices retain their existing owners and behavior. Missing catalogs do not delete selections or re-enable hidden models.
- Startup composition loads after help/version/management/local-tool commands exit. Public syntax, exit codes and local diagnostics remain.

## Verification

The complete local verification reported **1,669 tests: 1,659 passed, 10 skipped, no failures**, including streaming smoke and existing performance/resource budgets. Targeted transition/configuration tests additionally cover:

- native auth bytes and timestamps retained through an isolated runtime reload;
- stable local gateway keys, source identity, model choices and manual-sync preferences;
- a real synthetic request using the retained credential, reasoning effort and output-token limit;
- original CRLF v1 bytes retained in backup and unchanged v2 file bytes/mtime/mode;
- unchanged public snapshots against the prior candidate in both legacy and managed configurations.

The native CI gate covers Windows/macOS, strict npm 12, complete package installation, native client protocols/sign-in/model catalogs and the unchanged browser UI. Final CI and publication receipts are linked in the GitHub Release. Synthetic protocol checks do not claim a live account or GUI adoption test.

Existing interface verification includes Chromium/WebKit source/catalog and editor checks, plus 36 xterm configurations with 200 frames each. Isolated 1.2.33 upgrade and empty-cache complete-package native loading remain release gates. Public npm bytes and a fresh installed runtime are independently verified after publication, against the source pack uploaded by the publish job.

## Local performance observations

With three clients selecting 800 models from eight synthetic APIs, 20 full snapshots reduced plan lookups from 48,660 to 60. Paired public snapshots were equal. The local median changed from about 23.2ms to 10.0ms; this is control-plane work, not an inference-latency claim.

Five fresh CLI processes per command, with the local filesystem warm, measured median `version` at about 65.7ms before / 32.0ms after, and `help` at 62.0ms / 29.5ms. These are local observations, not cross-platform timing guarantees.

## Scope and distribution

README and the current reference are shorter and use the current command paths. Obsolete command-shim/model-formatter tests, unsupported-platform positive cases and redundant CI work were removed; relevant native login, model, history, image and prediction protection remains.

The earlier authorized cleanup removed 24 GitHub Release records/assets: all existing releases below 1.2.0 plus 1.2.17 and 1.2.20. Tags, commits and npm versions were retained.

No new plugin framework, storage schema, production dependency, source failover, background model probe, DNS self-forwarding module or content-masking feature was added. See the repository's `STATE_REFACTOR_PLAN.md` for implemented boundaries and deferred work.

- [GitHub Release](https://github.com/DaleXiao/codex-copilot-dx/releases/tag/v1.3.0)
- [npm package](https://www.npmjs.com/package/codex-copilot-dx/v/1.3.0)
