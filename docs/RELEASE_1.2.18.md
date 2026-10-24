# CCDX 1.2.18

Fixes a 1.2.17 regression: saving Codex model bindings selected an unauthenticated
custom provider, hiding an existing ChatGPT account and its dependent features.
Native credentials were retained on disk but ignored by that configuration.
The prior native replay covered a fresh API-only profile and missed this case.

## Changes

- Preserve native OpenAI authentication when sign-in material, credential-store
  policy or native authentication restrictions are present. Model requests still
  use only the private loopback bearer; no upstream API key or native sign-in is
  copied, replaced, refreshed or deleted by configuration reconciliation.
- Keep a fresh API-only Codex profile usable without a ChatGPT login. Preserve
  user edits and migrate unchanged 1.2.17 owned provider sections on reconciliation.
  A user-selected default model is preserved independently and does not block
  repairing the still-owned authentication section.
- GitHub-only selected models accept existing native loopback callers that have
  not reloaded configuration. Mixed/non-GitHub sets still require the private
  Codex key for the whole catalog and inference scope. Unselected models fail.
  An old non-Codex bearer gets a local 403 rather than a ChatGPT refresh challenge.
- Serve bound catalogs from the selected deployment facade even when GitHub is
  the default. This avoids an unnecessary live catalog request and prevents raw
  unselected models from replacing the scoped list.
- Retain unavailable selected models in the WebUI draft and show their checkboxes.
  Saving an unavailable selection fails without replacing the saved graph; users
  can refresh or explicitly clear it. No silent deselection or automatic fallback.
- Add a signed-in native Codex replay to CI, including account read, model list,
  a complete synthetic turn, unchanged credential bytes and local-key assertions.

Reopen Codex after an owned provider/authentication configuration change. No
client binary patch, forced App restart, enterprise network-policy change,
credential deletion or automatic sign-in is introduced.

## Verification

Local `npm run verify` passed: 1,521 tests, 1,511 passed, ten optional/platform
skips and zero failures; HTTP/SSE smoke, performance budgets and pack checks
also passed. Twelve Chromium/WebKit cases covered all three palettes, both
appearance modes, missing-selection preservation and explicit removal. An
isolated 1.2.17 → 1.2.18 upgrade loaded sharp and the supported broker on Darwin
arm64 using the unchanged company registry. Platform CI gates publication.

Installed native Codex 0.163.0 passed both fresh API-only and existing ChatGPT
sign-in replays: account/read and getAuthStatus, selected catalog, complete
synthetic inference, unchanged credential bytes and local-key checks. Replays use
only synthetic credentials, a loopback account/catalog/API and blocked external
HTTPS. They do not establish the validity of a real account or every native App
feature. The affected real service's restored legacy route separately returned
11 Codex models including its default; that read was not a native App UI test.
