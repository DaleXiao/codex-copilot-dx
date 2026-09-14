# CCDX 0.7.9 verification report

Date: 2026-09-14. Baseline: `28a0c53` (0.7.8).

## Image tool discovery and invocation

An already-open Codex task could miss the newly configured CCDX image MCP
server and enter the unrelated built-in imagegen Python fallback. This led to
SDK installation attempts, a local Images endpoint 404, and an official API
401 when the existing `dummy` Copilot placeholder was used.

Enabling images now installs a distinct CCDX-owned `ccdx-image` skill alongside
the MCP configuration. The skill uses the configured MCP tool, including one
targeted deferred-tool search when needed. A task whose MCP catalog is still
stale can use the installed, dependency-free Node helper to call the same local
MCP service. The helper initializes the service, validates its identity, submits
one generation, and writes a new image file without overwriting an existing
one. It does not read provider credentials, install SDKs, switch endpoints, or
retry an ambiguous generation failure.

Normal startup migrates providers already enabled in 0.7.8 without asking for
the API key again. Unchanged guidance is not rewritten. Disabling images
removes the credential, MCP configuration and unmodified generated guidance;
user-modified skill files are preserved. Failed configuration writes roll back
new guidance. The built-in imagegen skill is neither modified nor disabled.

`enable-image` and `image-status` now check the local MCP handshake and tool
directory without generating an image. They distinguish saved configuration
from a reachable local service. They do not claim that an external CLI can
refresh every App-owned process: actual MCP and skill loading remain under
Codex's control. On clients that do not refresh changed skills, a one-time
App restart can still be necessary.

## Scope and verification

- Default image generation remains disabled. Image guidance is installed only
  for a configured provider; the ordinary Responses request path is unchanged.
- Full `npm run verify` passed on Node 22.20.0: **702 tests, zero failures**,
  offline HTTP smoke, performance/resource gates and an 82-entry npm dry run.
- Focused coverage includes reversible ownership-aware installation, write
  rollback, disabled providers, custom ports, non-generating readiness checks,
  local-only helper requests, RPC identity, bounded bodies, output collisions
  and no retry after a failed or ambiguous generation.
- Restricted-network command environments need the host's normal permission
  before a helper can connect to loopback. The guidance now requests that
  permission up front; initialization failures explicitly state that no image
  generation has been submitted. Post-dispatch failures remain non-retryable.
- The optional installed-Codex replay uses isolated homes, synthetic model
  responses and synthetic images. On Codex CLI 0.154.0-alpha.6.2, the next turn
  of an already-loaded pre-enable task discovered the new skill before any
  explicit MCP or skill reload. Separate cases cover MCP reload, deferred tool
  search, one image call, native image output, saved-task resume and a new task.
- The normal Copilot Responses, encrypted-state recovery, message identity,
  Fast, Auto-review, compaction and image-input tests remain green.
- A separate live `gpt-5.6-sol` run received a plain Chinese request for a blue
  circle on white, with both the installed native imagegen skill and CCDX skill
  present. It selected CCDX and made exactly one image call, receiving native
  image content in four model requests. Image pixels were synthetic; this
  check exercised real model selection without charging the image provider.
- A second live case kept MCP unregistered in an existing task, installed the
  guidance after its first turn, then sent the same natural image request.
  The model selected the Node helper, obtained one normal command approval,
  generated exactly once, and saved a decodable 1024x1024 image. The image turn
  used five model requests and made no Python/SDK/alternate-provider attempts.

The offline replay is protocol evidence, while `--live-model` checks the
observed model's decision. Neither guarantees behavior of every future model
or client. Normal host tool/command approval rules continue to apply.
