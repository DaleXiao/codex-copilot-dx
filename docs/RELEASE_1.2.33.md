# CCDX 1.2.33

## Changes

- Supported interactive startup uses one transient row before a stable live region.
  The listener/uptime, enabled sources, peer client setup/activity, returned usage,
  scoped notices and independent activity row have separate meanings. Source names
  start left-aligned below `Enabled sources: N`. Device-code instructions, warnings,
  verbose and legacy plain/non-TTY output remain.
- Activity uses existing model/inference and actual generation evidence, not image
  MCP discovery. Unknown/stale activity is not Idle. Usage records, token reuse,
  HTTP requests and model outcomes remain separate; nonzero Unknown stays visible.
- Canonical `source`, `app`, `config`, `requests`, current-run usage, update-check
  and deep-help routes reuse existing backend capabilities. Legacy commands keep
  their semantics and script paths; source switching stays Codex-only.
- New connection mutations require a compatible service and current revisions.
  Client access-only toggles retain legacy bindings; manual sync retains auto-sync
  preferences. Source grants do not choose models. API removal requires disabled,
  unbound state and uses existing credential retirement.
- Service/terminal preference reset uses the existing atomic backup writer with
  an independent CLI backup. WebUI's backup, browser appearance and version-one
  format are preserved. No new production dependencies, forced App restarts,
  service hot upgrades or WebUI redesign.

## Verification

Candidate verification and public publication receipts are completed before
release promotion. Native Codex auth/catalog/old-session and Claude protocol gates
remain required; isolated synthetic checks do not claim real account/App adoption.
