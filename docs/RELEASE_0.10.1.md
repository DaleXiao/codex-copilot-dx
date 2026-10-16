# CCDX 0.10.1 — keep the configured core port available

Date: 2026-10-17. Follow-up to [0.10.0](RELEASE_0.10.0.md).

Status: published to npm `latest` and GitHub; publication receipts follow.

The final port-isolation fixture reproduced a startup-order conflict when the
existing core service is configured with `ADAPTER_PORT=2027`, which is also the
new Claude gateway's fixed port. An early M365 setup could reserve it before the
core listener started. The fixture failed before this correction.

The composition root now passes its actual core port to provider setup. That port
always wins: only the optional Claude listener/configuration is skipped, with an
explicit `m365_gateway_core_port_conflict` reason. M365 GPT remains selectable.
Default port 2026, existing caller preferences, credentials, prediction routes,
image behavior and network policy are unchanged. No automatic port move, process
restart or new option/dependency is introduced.

This is a scoped follow-up, not another architecture pass. The M365 eligibility
and platform-validation limits in the 0.10.0 report still apply. Final verification
and publication receipts are appended below after completion.

## Verification

- Focused port/routing/CLI/provider/documentation checks: 64 passed.
- Full local verification: 1,327 passed, nine platform skips, zero failures;
  offline HTTP/SSE, package inspection and performance/resource gates passed.
- The running pre-update service remained 0.9.41 / PID 54407 with HTTP 200 status,
  prediction bridge running and client route observed. It was not restarted or
  reconfigured during release work.
- Default-path paired performance and real-client evidence from 0.10.0 still
  apply: this patch changes startup port ownership only, plus the version stamp.
  It does not change per-request model routing or add an inference call.
- Production commit: `af720412e761312bc948e75dd05f469496ec37ba`.
- [Final CI 38941944155](https://github.com/DaleXiao/codex-copilot-dx/actions/runs/38941944155):
  all fourteen jobs passed across Linux, Windows and macOS, including native
  workers, npm 12 installation/upgrade, browser recovery and official Codex image replay.
- Package: 171 files, 432,933 bytes. Local artifact integrity:
  `sha512-o2W1XuBwYiOPtgN7SabKv3aDevmYosbi92jJgirNAtPQB1pVbRhFXyqWpUMte3aVh5wpE81LE+QBDI3dwdyTZw==`.

Publication receipts are appended on the repository's main branch after the
immutable tag/package is published. Windows M365 real-tenant validation remains
pending user feedback, rather than being inferred from the CI results.

## Publication

- Tag `v0.10.1` targets `f0ffb2a0ec068afb0e5fc16e8d1fc1b2471644ee`.
- [npm publishing run 38942724743](https://github.com/DaleXiao/codex-copilot-dx/actions/runs/38942724743)
  completed successfully. It reported `+ codex-copilot-dx@0.10.1` on
  `https://registry.npmjs.org/` with tag `latest`.
- [GitHub release v0.10.1](https://github.com/DaleXiao/codex-copilot-dx/releases/tag/v0.10.1)
  is public and latest, with the tested package attached. Asset SHA-256:
  `46bd95d792bc9a3365ac306dd3440ab3383d948f1b656ab5f25b28a8ce25d7f8`.
- GitHub used the previously verified historical PAT; npm used the existing
  repository secret. No new interactive authentication or credential replacement
  was requested. The existing local service was left running for the user to update.
