# CCDX 0.9.21 verification report

## Scope

Add an optional, compatibility-gated Codex local thread-store compression default.
No AGENTS.md changes, model/routing changes, image setup changes, new dependencies,
client patches, transcript cleanup or request/cache limit changes.

- Preserve existing settings, including true/false, quoted/dotted/inline forms,
  legacy profile overrides and misplaced root declarations; never force-enable.
- Probe discovered macOS App binaries locally using an isolated temporary
  CODEX_HOME, an allowlisted environment, 1.5-second timeout and 128 KiB output
  cap. All discovered readers must advertise a supported disabled feature.
- Skip missing, removed, unknown, default-on and failed probes. No network,
  credential access, user transcript scan or fallback installation.
- Reread config after probing; surgical TOML validation permits only the feature
  addition. Ambiguous inline/dotted features tables remain intact. Unchanged
  configuration is not rewritten. Optional failures warn without stopping core.
- Core Ready/requests do not wait; adapter reuse finishes the bounded task before
  exiting. An App launched before setup finishes sees it on its next config load.
- External transcript readers are not detected. The feature remains experimental;
  compression is not context compaction or an increase in CCDX memory/body limits.

## Verification and bounded review

Baseline, isolated copy of HEAD 77be79e: 995 tests and existing smoke, SSE,
performance/resource and package checks passed. Initial sandbox execution could
not bind loopback ports; baseline was rerun with test-port permission, without
relaxing assertions or contacting any real provider.

Candidate: 1006 tests passed, zero failures/cancellations/skips; HTTP/SSE smoke,
performance/resource gates and package preflight passed. Targeted coverage adds
supported/off/removed/default-on/malformed/timeout/mixed-reader probes, temporary
directory cleanup, credential-free environment, format preservation, idempotency,
edits during probing, optional read/write failures, cold startup and adapter reuse.
Image-disabled tests still install no skill/MCP; all nine existing image startup
replays pass, including image conflicts and pending/failed provider isolation.

One scoped review/fix pass corrected fixture path normalization and preserved
Node execFile's promisified result shape in the shared offline preload. The new
startup tests use a synthetic App on every OS, never installed user state.
Existing update checks, config doctor no-process contract, Fast/Auto-review,
encrypted continuation, cancellation, streaming and image tests remain intact.

Actual installed Codex 0.162.0-alpha.17.2 reads the new setting and accepts the
full model catalog. Direct/proxied synthetic commentary/final identities pass.
The proxy replay then restarts an isolated runtime, ages only its synthetic
transcript and maintenance marker, and verifies Zstandard decoding is byte-exact,
thread/read and thread/resume succeed, with no additional inference request.
Test waits are bounded and all synthetic directories are cleaned automatically.
The same real-client regression is part of the existing latest-Codex CI job.
The local synthetic transcript was 47,506 bytes before and 14,643 bytes after
compression. The latest-client CI independently verified 40,521 to 13,369 bytes,
byte-exact decoding and successful read/resume; these are fixture-specific sizes.

## Performance boundary

There is no added upstream request, periodic task, prompt content or hot-path
compression. Core readiness is verified while the optional probe remains pending
or times out. Explicit settings skip even the probe. Existing benchmark resource
and stream/backpressure gates pass. Cold-file disk savings are demonstrated on a
synthetic transcript, not promised as faster inference or lower gateway memory.

## Publication

Application commit: `838465edb68f0bdac572defd6b22a4dc1f1f5695`.
Annotated `v0.9.21` tag object: `43034173e8ba755dc5e5af04fb6540a92d2bad8f`.

- Node 22.15, Node 24 and latest official Codex jobs all succeeded:
  https://github.com/DaleXiao/codex-copilot-dx/actions/runs/38114162914.
- Formal GitHub Release, neither draft nor prerelease:
  https://github.com/DaleXiao/codex-copilot-dx/releases/tag/v0.9.21.
- Exactly one npm workflow succeeded, including 1006 tests and prepublish gates:
  https://github.com/DaleXiao/codex-copilot-dx/actions/runs/38114233934.
- Official receipt confirms `codex-copilot-dx@0.9.21`, published with `latest`.
  Local and runner preflights match: 113 files, 295,721 packed bytes, SHA-1
  `d57fec897c1824df6eafe3711f70da412bd21c2e`.

GitHub used the previously supplied, freshly identity-verified DaleXiao PAT only
in memory; npm used the repository's existing NPM_TOKEN via its publish workflow.
No alternate credential or local npm registry query. Published tag stays fixed;
the final report-only commit does not change the npm payload.

Cleanup is limited to this task's baseline copy, test logs and release helpers;
preserve user settings, credentials, images, dependencies and running service.
