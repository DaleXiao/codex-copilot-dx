# CCDX 1.2.29

This patch adds the approved GitHub-code copy and M365 app-grant controls,
fixes protocol-equivalent history being rejected during an owned tool turn,
and makes M365 model-directory network/cache evidence visible. Other WebUI
modules retain their layout. Codex authentication/provider configuration is not
changed by ordinary app grants.

## Changes

- GitHub verification has a small SVG copy button and a Copy & open GitHub
  action. An explicit sign-in click prepares one asynchronous clipboard write
  for the future short user code. Polls do not keep overwriting the clipboard;
  failed writes do not claim success. Click-to-copy/selectable-text fallback,
  cancellation, obsolete results and late account reads are handled. Clipboard
  reads are never requested and device tokens are never copied. The verification
  link remains the fixed GitHub URL with native click activation.
- M365 Allowed apps supports zero, one or several clients. Discovery/sign-in
  alone no longer configures every client on first setup. Existing persisted
  grants and owned legacy setups are retained. Granting access does not choose
  models or replace a current source. Revocation removes M365 routes while
  retaining other selections and an unavailable default until explicitly
  replaced. Shared legacy Claude-key migration identifies retained consumers
  that need reopening. The explicit CLI M365 choice authorizes Codex only.
- Messages history comparison normalizes protocol-equivalent string/text-block
  forms, JSON field ordering and same-role grouping. Forwarded text, code
  whitespace, arrays and tool arguments remain unchanged. Current-source
  reasoning/tool state stays intact at a proved prefix. Semantic receipts live
  beside the unchanged legacy format, bound to its owner/count/hash; paired
  atomic commits and stale-proof rejection protect rollback. Legacy proofs
  upgrade only after verification. Real pending/unmatched tool work, unknown
  source-owned state and foreign-account history retain their protections.
  Rejections expose fixed, non-content source/prefix/tool reasons.
- Explicit M365 directory reads request network/HTTP revalidation even with a
  valid local model cache. The existing refresh cadence is unchanged. The source
  page summarizes online/cache origin, model totals, GPT/Claude counts and data
  time. Collapsed details retain bounded HTTP/cache facts and sanitized upstream
  and client correlation IDs, including on account-binding commit. Failed reads
  preserve prior evidence. A valid smaller network list replaces an older larger
  cache rather than borrowing hidden models from it.

## Evidence and limits

The preceding investigation observed five GPT entries in a Windows 1.2.28 raw
Loki response and fifteen entries (five GPT/ten Claude) on Mac with the same
account as reported by the user. A Mac read with the Windows User-Agent still
returned fifteen. The exact upstream/authentication/device/network policy was
not established. This release reports that distinction without claiming it
restores missing Windows Claude entries. HTTP revalidation requests are not a
guarantee that every intermediary complied, and they do not force a new Microsoft
SSO token or change enterprise proxy/certificate/account policy.

Another Mac report's subsequent Details identified a local HTTP 503 wrapping
`m365_catalog_http_403`: directory discovery was rejected, rather than a proven
Opus inference/quota refusal. Legacy gateway errors now carry the fixed directory
cause and bounded correlation evidence. A valid directory with no Claude models
also says so explicitly. This does not grant access refused by Microsoft; the
specific account policy is not assumed. Catalog access and model inference remain
separate. Offline checks cover a successful catalog followed by a preserved
inference refusal without replay, and the directory-403 gateway error shape.

## Verification

Local verification passed 1,656 tests: 1,646 passed, ten platform/optional skips
and zero failures, followed by HTTP/SSE smoke, performance budgets and pack checks.
The 48 Chromium/WebKit bilingual/theme/narrow dashboard combinations and twelve
application-connection combinations passed. Release receipts also record focused
protocol/grant/cache regressions,
native Codex auth/full-first-list/old-session replays, service handoff/rollback,
isolated 1.2.28 upgrade, exact-commit platform CI and independent npm/GitHub
artifact checks. No real model inference is needed for these checks. The current
user service is preserved during implementation and release.
