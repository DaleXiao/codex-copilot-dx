# CCDX 0.7.3 verification report

Date: 2026-09-05. Baseline: `42134ed3dfc483d9bc8fbbaae8f141f48c13674e` (0.7.2).

## Scope and result

Fix native Responses message identity drift: bind each confirmed message's full
`output_index` to its first upstream `output_item.added.item.id`. Apply that ID to
the message's content events, item completion, and terminal response snapshot.
The same normalized snapshot is cached for continuation. No text deduplication,
generated IDs, or opaque-ID decoding is involved.

Only `src/responses-proxy.mjs` changes production behavior. Tool IDs/call IDs,
reasoning/encrypted content, phases, annotations, usage, unknown event types,
model catalogs, Fast routing, compaction, non-streaming requests, and existing
history are not rewritten by this change. Failed/incomplete responses remain
uncached. The binding is local to one response stream.

Stable SSE events preserve their original bytes. Modified events preserve their
JSON fields except the relevant message identity and retain SSE metadata.
Parsing remains single-pass and bounded by the existing 8 MiB event limit.
Writes are batched within each upstream read in 64 KiB slices and await drain.
Completed large fragment buffers transfer ownership, preventing both a redundant
large copy and corruption of buffers retained by an asynchronous downstream.

## Verification

- `npm run verify`: passed on Node 22.20.0: **625 tests, 0 failures**, offline HTTP
  smoke, performance/resource gates, and npm package dry run (70 entries).
  The initial restricted-shell smoke attempt could not bind loopback (`EPERM`);
  the complete gate passed with loopback permission. No assertions were relaxed.
- Added 14 focused tests: identity drift; multiple messages interleaved with
  tools/reasoning; phase, annotations, usage, Fast parameters, and encrypted
  field preservation; previous-response and explicit-history continuation;
  refusal and failure terminals; unknown/malformed identity boundaries;
  concurrency isolation; byte-exact stable SSE; UTF-8/CRLF/multiline data;
  backpressure/cancellation/buffer ownership; and 8 MiB linear processing.
- Baseline negative controls failed on identity drift, while stable pass-through
  controls passed. The new implementation passes both.
- Installed `codex-cli 0.153.1` offline app-server replay passed. Direct drifting
  SSE produced started/delta A but completed/history B. Through CCDX, commentary
  and final-answer items consistently used A, with complete text and one history
  item per phase. Temporary Codex directories were automatically removed.
- Four minimal live Copilot requests: GPT-6 Astra and GPT-5.6 Sol, each with a
  first turn and continuation. All returned HTTP 200 and response.completed,
  with **no compatibility retry**. All four reproduced upstream message-ID
  drift and were normalized successfully. Continuations replayed the normalized
  message ID. Only synthetic arithmetic prompts were sent. Saved account/config
  files were not modified; the release PAT was not used for model requests.
- Independent bounded reviews found no release-blocking defects, including a
  targeted final review of buffer ownership and backpressure after batching.

## Performance and evidence limits

Fixed synthetic comparison, three runs per case, median milliseconds:

| Input | 0.7.2 | 0.7.3 |
| --- | ---: | ---: |
| 5000 stable 256-byte deltas, 16 KiB chunks | 13.129 | 16.696 |
| 5000 drifting 256-byte deltas, 16 KiB chunks | 7.738 | 12.793 |
| 1 MiB stable event, fragmented | 3.309 | 2.970 |
| 8 MiB stable event, fragmented | 22.513 | 22.217 |
| 8 MiB drifting event, fragmented | 22.440 | 42.038 |

The 5000-delta workloads retained 121 writes, with no additional upstream calls.
The comparison includes JIT/warm-up variation; it is not a production-latency
claim. Identity checks and changed-event serialization are not zero-cost.
Large stable events remain close to baseline; modified large events incur linear
JSON serialization work. No full-response buffering or quadratic rescanning was
introduced, and complete events do not wait for a subsequent upstream read.

The runtime replay checks actual app-server notifications/history, not a full
desktop visual test, and tested 0.153.1 rather than the reviewer's 0.153.3.
The four live responses did not contain encrypted reasoning, so their success
does not establish live encrypted-reasoning round-trip coverage. Existing
encrypted-history/compaction tests and new field-preservation tests passed.
This fix addresses identity drift, not every possible source of duplicated UI.
