# CCDX 0.7.5 verification report

Date: 2026-09-06. Baseline: `5965b58` (0.7.4).

Normal startup and reuse of an existing adapter now add
`context_management = true` to the `[features]` table when missing. A missing
table is created, and fresh configuration files include the setting.
Existing values, including `false`, remain unchanged. Inline or dotted
`features` declarations and structured context-management settings are preserved
to avoid conflicting TOML definitions. Codex currently marks this feature as
under development; this default is intentional and does not override an opt-out.

Only startup configuration behavior changes. Request processing, image
optimization, model routing, context limits, and existing configuration values
retain their previous behavior. Repeated startup does not rewrite a file that
already matches.

Verification:

- Full `npm run verify` passed locally on Node 26.3.0: **638 tests, 0 failures**,
  offline HTTP smoke, performance/resource checks, and npm package dry run
  with 73 entries.
- The 17 configuration tests cover missing files/tables/keys, existing true and
  false values, comments, indentation, quoted keys/tables, nested section
  boundaries, alternate declarations, trailing newlines, and unchanged file
  identity/modification time on a second startup.
- Read-only transformation of the existing local configuration was a no-op.
  The user's actual configuration was not rewritten.
- Release is gated on the existing GitHub CI matrix (Node 22.15.0 and 24.x)
  before dispatching the existing npm publishing workflow.
