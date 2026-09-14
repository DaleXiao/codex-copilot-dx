# CCDX 0.7.8 verification report

Date: 2026-09-14. Baseline: `c19ed60` (0.7.7).

## Responses failure recovery

GitHub Copilot can accept a native Responses request with HTTP 200 and later
terminate its SSE stream with `response.failed`. CCDX now captures the upstream
error code, message, response ID, request ID, and retry outcome in a redacted,
ten-entry process-local diagnostic ring shown by `ccdx status`.

When that terminal error exactly matches the existing encrypted-state
compatibility policy, CCDX retries once with unavailable encrypted reasoning or
encrypted function-output content removed. Stored-thread history is rematerialized
before sanitization, so the retry keeps the visible conversation and current
input. The failed pre-output prelude is not sent to Codex App.

The recovery is deliberately narrow: normal streams keep their existing direct
forwarding path, unrelated failures pass through, and a stream is never replayed
after visible model output. Prelude buffering for eligible encrypted continuations
is capped at 256 KiB. This avoids duplicate answers, unbounded retention, and
retry loops.

## Optional image generation

Image generation remains disabled unless the user runs `ccdx enable-image`.
That command validates an HTTPS provider, stores its credential separately with
mode `0600`, and installs a marked local MCP entry for Codex App. `ccdx
disable-image` removes both CCDX-owned pieces and `ccdx image-status` reports the
configuration without exposing the API key.

The image tool runs inside the existing adapter, is loopback-only, limits
concurrency and body sizes, and accepts only public HTTPS generated-image
downloads. Ordinary Responses, model discovery, authentication, Fast,
Auto-review, compaction, and image-input behavior do not use the optional
provider. A real provider check covered model discovery, protocol detection,
generation, and image decoding without persisting the test credential.

## Verification

- Full `npm run verify` passed locally on Node 22.20.0: **685 tests, 0 failures**,
  offline HTTP smoke, performance/resource checks, and a 79-entry npm package
  dry run.
- Responses tests cover HTTP 200 `response.failed` in streaming and unary modes,
  stored-history rehydration, encrypted function-output repair, redacted
  diagnostics, single-use retry policy, and the no-retry-after-output boundary.
- Existing stream contract, message identity, history, compaction, cancellation,
  timeout, backpressure, image-input, model catalog, Fast, and Auto-review tests
  remain green.
- Image tests cover disabled-by-default behavior, reversible Codex configuration,
  hidden credential input, protocol detection, OpenAI base64 and URL-based image
  results, SSRF and size controls, MCP lifecycle, and secret-safe errors.
- Publishing remains gated by the GitHub CI matrix for Node 22.15.0 and 24.x.
