# CCDX 1.2.15

This patch improves manual API transport recovery and retains the evidence
needed to distinguish local forwarding failures from upstream HTTP errors.

## Changes

- A transport failure before response headers invalidates that transport.
  A later request rebuilds it using existing proxy/TLS policy. The failed
  request is never replayed, and unrelated active responses drain before the
  old transport closes. Service shutdown still closes retired transports.
- API network errors preserve a private cause and expose only a recognized
  local error code, observed phase and socket-reuse fact. Raw error messages,
  endpoint addresses, headers, credentials and request content are excluded.
  Claude gateway logs retain the bounded code and phase.
- Node response streams are read on demand. A local Node 22 regression covers
  cancellation before queued stream delivery, which otherwise can enqueue
  into an already-closed Web stream.
- Upstream HTTP denials, intentional cancellation, fixed target allowlists,
  provider grants and all existing credentials remain on their existing paths.
  Documentation distinguishes CCDX routing capability from Claude App's own
  model-name restrictions; this patch does not claim complete native App
  compatibility with non-Anthropic models.

## Verification

The focused regressions exercise the actual shared HTTP route, provider runtime
and API transport with synthetic upstreams. They cover a failed call without
replay, recovery on the next call, an unrelated stream draining during recovery,
DNS error metadata, denial/cancellation behavior and diagnostic redaction.

Local `npm run verify` passed: 1,505 tests, 1,495 passed, ten platform/optional
skips and zero failures, followed by HTTP/SSE smoke, performance budgets and
package checks. A real isolated 1.2.14 → 1.2.15 upgrade loaded sharp and the
supported native broker on Darwin arm64; the enterprise registry was preserved.

The updated local service was tested through its normal port 2026, rather than
only a direct provider or a second port. One configured Messages model returned
HTTP 200, `OK`, `message_stop` and `end_turn` for the same minimal request that
had failed on the prior process. API and Claude profile configuration hashes
were unchanged. This was a native-protocol HTTP check, not a visible Claude App
conversation or a tool-call verification.

Historical failures in the prior process discarded their underlying error;
restarting and applying the patch changed its runtime state. These results do
not retroactively prove the precise cause of that earlier process's failure.
Cross-platform CI, publication and downloaded-asset receipts accompany the
GitHub Release.
