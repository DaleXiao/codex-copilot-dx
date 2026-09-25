# CCDX 0.8.7 verification report

Date: 2026-09-25. Baseline: `50bd85d` (0.8.6).

## Scope

- Reject Chat-compatibility message content that cannot be represented faithfully
  instead of silently serializing unsupported parts such as audio and files into
  text. Keep supported text, images, and function tools unchanged.
- Map Chat `length` and `content_filter` finish reasons to incomplete Responses,
  including streamed terminal events and output-item status.
- Separate bounded model terminal outcomes from HTTP request counts. Attribute
  upstream and transport errors without inventing a model `failed` event.
- Expose response-history tree concentration and actual lookup misses in local
  status. Near-limit CLI warnings clarify that eviction markers are not failed
  requests.

The history byte and entry limits, eviction policy, model routing, image setup,
stream backpressure, and retry policy are unchanged. This release does not add
automatic history compression or recovery of an evicted `previous_response_id`.

## Verification

- `npm run verify` passed: 841 unit tests, offline HTTP smoke,
  performance/resource checks, and npm package dry-run.
- Regression tests cover unsupported audio/file parts, valid Chat text/image
  conversion, streaming and non-streaming incomplete outcomes, per-model
  terminal metrics, error origins, history tree counts, and evicted lookup
  diagnostics.
- Nine isolated startup/reuse scenarios passed without real provider calls;
  disabled image profiles issued zero image requests, and image failures did
  not block core Responses.
- The local package dry-run contains 92 files and has SHA-1
  `19089ffcecb051527cee6229f7b6a51aeae5887b`.

## Publication

Pending successful CI, GitHub Release, and one-shot npm workflow.
