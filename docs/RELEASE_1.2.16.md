# CCDX 1.2.16

This patch completes automatic Claude App compatibility routes for custom
Messages APIs and corrects disabled-item placement in Settings.

## Changes

- CCDX writes stable opaque model routes and real display names into owned
  Claude App configuration. Standard Claude IDs keep their native identity.
  Routes do not change when a catalog is reordered or grows. Users need not
  type aliases in the App.
- The authenticated App gateway advertises the same routes, resolves them
  against its current source's Messages models, sends real IDs upstream, and
  maps JSON and SSE message-start model fields back to the requested route.
  Token-count requests use the same resolver. Unknown routes cannot expand
  model or protocol access. Usage and performance retain real model identities.
- Bounded SSE framing preserves non-model frames, UTF-8, tool data and
  signatures, with backpressure and existing cancellation/timeouts. Code/Codex,
  M365 routing, declared capabilities, private keys, source/history isolation
  and managed/custom configuration protection retain their existing scope.
- Settings now places **Disabled sources** inside **Model sources**, and
  **Disabled clients** inside **Clients**. Each collapsed list is hidden when
  empty and keeps its own **Enable again** action.
- README, offline reference, architecture, bilingual copy inventory and both
  bootstrap installation versions match this patch. No runtime dependency or
  enterprise network-policy change is added.

## Verification

Local `npm run verify` passed: 1,510 tests, 1,500 passed, ten platform/optional
skips and zero failures, plus HTTP/SSE smoke, performance budgets and pack
checks. Focused regressions cover cross-platform owned-config migration,
alias stability/collisions, client impersonation, protocol grants, JSON and
token counting, fragmented multiline SSE, opaque data and bounded buffering.

Twelve Chromium/WebKit browser cases passed across green/Klein/pink palettes,
light/dark modes, English/Chinese and 360/1280 widths. They verify model
selection, saving, assignment and independent disable/restore lists without
live provider calls. A real isolated 1.2.15 → 1.2.16 upgrade loaded sharp and
the supported native broker on Darwin arm64 using the existing company registry.

The local service's normal port 2026 returned a catalog matching all four
automatically written profile entries. One minimal streaming request through
the first compatibility route returned HTTP 200, `OK`, `message_stop` and
`end_turn`, with the requested alias in the response and the real upstream
identity retained locally. This was a protocol request, not a native UI chat.
Native App model-name acceptance, a connection check and full conversation/tool
compatibility are distinct checks; this patch does not promise that every
Messages model implements Claude App's full tool/thinking behavior. CI and
publication receipts accompany the GitHub Release.
