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

- Final runtime candidate: `8b5e4f4bcf12b23f79956d6d0755789458d7befc`.
- [CI 40678226236](https://github.com/DaleXiao/codex-copilot-dx/actions/runs/40678226236): **25/25 effective jobs passed**. Windows no-Node bootstrap passed on its unchanged failed-job rerun; the first attempt timed out after the download message. An earlier candidate's Windows PAC fixture fetch also failed once; the original PAC checks passed on the final candidate. The exact initial causes are not proven; no speculative proxy/installer change or weaker assertion was introduced.
- Local `npm run verify`: 1,695 tests, 1,685 passed, 10 skipped, no failures; streaming smoke, performance/resource budgets and package-content checks passed.
- Real CLI subprocesses exercised source/client/settings actions through the protected loopback API, private key input, stale/old-service rejection, paused empty selection and restoration, native model naming and byte-preserved Codex auth. Interactive foreground startup checks Codex configuration evidence without creating a binding file. Memory-dependency and canonical-help safety omissions were reproduced before correction.
- Actual xterm replay passed 72 size/color combinations, 200 frames per combination, including 16-row, plain/NO_COLOR, resize and cursor/scroll behavior. Structured cancellation/incomplete outcomes stay distinct from failures; MCP discovery does not drive model activity.
- CI retains official native Codex ChatGPT sign-in, complete first model catalogs and old-session continuation, Claude protocol/capability replay, strict npm 12, proxy/private-CA behavior, browser regression and eight native package install/rollback gates. These are isolated synthetic-provider checks, not a claim that every real account or visible desktop App was exercised.
- Isolated verified 1.2.32 -> 1.2.33 installation and native sharp/broker loading passed. All eight complete packages matched the final standard package's 235 source files byte-for-byte before upload.
- Standard archive: 706,645 bytes; SHA256 `d0a1e3d613b72281bf85213dd894c4f0516ff0e7d0b81eb09bfae89b01824aa8`.

Publication and independent public npm/asset receipts are linked from the
[GitHub Release](https://github.com/DaleXiao/codex-copilot-dx/releases/tag/v1.2.33).
The release tag updates only this receipt relative to the green runtime tree.
Release work leaves the existing global service untouched. Finish active tasks
before installing/restarting normally; no source/model configuration needs to be
saved again just to adopt the terminal and command layout.
