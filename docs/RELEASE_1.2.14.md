# CCDX 1.2.14

This patch fixes the manual API model-selection flow introduced in 1.2.13.

## Changes

- Reading an ID-only catalog no longer makes every returned row mandatory.
  The editor has explicit model checkboxes and saves only selected models.
  Choosing an interface also selects its model. A selected model without an
  interface receives an inline explanation before any save request.
- Manual model-ID entry is an optional collapsed path for models absent from
  the catalog. Reading/selecting models does not require typing an ID.
- Manual sources appear in a client's current-source choices only after models
  for its protocol have been saved. Source grants remain separate and intact.
  Claude App/Code need Messages; Codex needs Responses, on the same main port.
- Disabling a source interface removes that interface from draft model choices;
  inactive interfaces cannot be selected on model rows. Existing backend checks
  continue to reject removal of models used by active client bindings.
- HTTP 404 during catalog reading now points to the API prefix, such as `/v1`.
  Addresses, keys and current client sources are never silently changed.
- README, reference, architecture, bilingual copy and bootstrap targets match
  the implementation. Runtime dependencies, themes, proxy/CA policy and
  installation behavior are unchanged.

## Verification

The regression was first reproduced on 1.2.13: an eight-model ID-only catalog,
with two chosen interfaces, left the editor open with `ccdx_api_models_invalid`.
The same interaction now saves only those two models and subsequently binds
Claude App and Codex without entering model IDs. The replay also checks a selected
model missing an interface, six ignored rows, collapsed manual entry, no key
exposure, disabled/re-enabled sources, and no automatic route selection.

Chromium/WebKit passed all 12 palette/mode/viewport/language connection cases.
The only upstream reads were explicit synthetic catalog requests: zero live
provider or inference calls. App configuration in this replay is isolated and
stubbed; it is not a restarted visible Claude App or proof of a specific API's
Messages compatibility.

Local `npm run verify` passed 1,498 tests: 1,488 passed, ten platform/optional
skips and zero failures, plus HTTP/SSE smoke, resource budgets and package checks.
The new backend regression confirms active model selections cannot be removed
and saved settings remain unchanged after rejection. Full platform CI, isolated
1.2.13 → 1.2.14 upgrade, publication and fresh asset/registry receipts are recorded
with the GitHub Release.
