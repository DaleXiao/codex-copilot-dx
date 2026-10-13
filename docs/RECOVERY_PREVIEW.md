# CCDX 0.9.28-recovery.1 validation candidate

## Acceptance

The affected user's original chat must resume while retaining facts and tool
results from before the rejected compaction. Removing the compaction alone,
changing the error message, or opening a fresh chat does not satisfy this goal.
The actual user history remains untested until the user verifies this package.

## Scope and safety

- Add one lazy local-file recovery after the exact connection-ownership error.
  Complete, matching source records are required; source files are not changed.
- Preserve healthy paths, route/model/effort/Fast settings, image preparation,
  existing cache limits, native predictions and the current client installation.
- No MCP, Hook, client patch, transcript upload endpoint, history watcher,
  disk plaintext copy, npm dependency or provider credential change is added.
- Reuse native UUID identity and exact compaction evidence, not titles or text
  similarity. Remote/browser callers, LAN-enabled services and ambiguous,
  incomplete, referenced or rolled-back sources fail closed.
- Decode JSONL/Zstandard locally using Node built-ins. A five-second deadline,
  finite directory/candidate counts, active decoded-byte limit and admission
  reservations bound work. Only pre-output requests can retry, once.

## Verification

- Baseline 0.9.27: 1,110 passing tests, four Windows-only skips, zero failures;
  HTTP/SSE, performance/resource and package gates passed.
- Isolated official Codex `0.162.0-alpha.17.2` generated a native encrypted
  compaction and recorded it locally. After a synthetic ownership rejection,
  the original thread continued and retained an earlier assistant fact omitted
  from the compacted request. One recovery, zero real-provider calls.
- Focused tests cover HTTP 400, HTTP-200 failed JSON and pre-output SSE recovery;
  earlier messages, tool results, current instructions, custom tools and images;
  wrong thread/content, broken pairs, missing opaque tool text, malformed files,
  Zstandard expansion, byte limits, symlinks, rollback and referenced histories,
  cancellation, admission release and refusal to retry after visible output.
- Full candidate and cross-platform receipts will be added after their gates.

## User validation

1. Preserve the original chat and stop the old CCDX service. Do not clean its
   history cache, edit its rollout or delete compaction records.
2. In PowerShell, use the package directory and run:

   ```powershell
   npm.cmd install -g .\codex-copilot-dx-0.9.28-recovery.1.tgz
   ccdx.cmd version
   ccdx.cmd
   ```

   On macOS/Linux, use `npm install -g ./codex-copilot-dx-0.9.28-recovery.1.tgz`,
   then `ccdx version` and `ccdx`.
3. Continue the original affected chat. Verify an early decision/tool result
   still exists in context, then send another input. Also check a healthy chat.
4. Report the package and running-adapter versions, whether both continuations
   worked, recovery count/source/status and any upstream request ID. Do not
   share raw transcripts, encrypted blobs, tokens or private filesystem paths.

If `recovery.local_status` reports a missing source, incomplete history or
retained-prefix mismatch, the original data remains unchanged. A source on a
different machine, a referenced history prefix, or a full replay above the model
window is not supported by this preview. Do not describe these as successful
recovery. Keep issue #1 open until the actual affected chat is confirmed.

This implements verified plaintext rebuilding, not decryption. The official
[compaction guide](https://developers.openai.com/api/docs/guides/compaction#standalone-compact-endpoint)
describes opaque state and retained context; the healthy canonical window is
not pruned by this recovery feature.
