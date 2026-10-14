# CCDX 0.9.35: six bounded safety and reliability improvements

## Scope and architecture

1. Inference POSTs reject browser Origin headers before reading bodies or using
   credentials/providers. Native clients without Origin, explicit native LAN
   access and dashboard/image policies retain their existing boundaries. This
   is browser-request protection, not authentication against local programs.
2. Chat translation maps explicit reasoning effort, checks advertised efforts
   when available, and rejects malformed tools, forced undeclared functions,
   unsupported tool-choice strings and unknown text formats. It adds no model
   lookup or inference attempt and does not change native Responses/Fast routing.
3. Local compaction recovery shares overlapping source reads via the existing
   abort-aware singleflight, with independent caller cancellation, validation,
   admission and result objects. Settled plaintext is never cached. At most 32
   snapshot-bound failure-code entries can be reused for two seconds. Discovery
   still runs, changed sources invalidate reuse, and missing sources, unstable
   snapshots, deadlines and cancellation are not cached. Existing complete-source,
   ownership, byte/deadline and tool-pair checks remain mandatory. Admission may
   serialize reads; sharing does not override the memory gate.
4. A zero installer exit is followed by bounded target-package name/version
   verification, including the exact selected GitHub version. Missing or wrong
   target metadata fails verification; an undiscoverable target is explicitly
   unverified. No retry, registry/PATH/prefix change or service restart is added.
   This is version verification, not artifact-integrity or npm-latest validation.
5. Actual local HTTP streaming tests verify early text delivery and downstream
   cancellation for native Responses and Chat translation. A scalar
   `empty_stream_completions` diagnostic counts completed streams with no observed
   output and an explicit zero output-token count. It excludes unknown usage,
   unary replies and observed tool/refusal output and never changes outcomes or
   triggers retries. Existing empty-response behavior remains compatible.
6. After Ready, model refresh uses ordinary two-column runtime logs, with a
   concise catalog count. Shared status output removes terminal controls and
   newlines; the static banner and interactive prompts retain their presentation.
   The dashboard heading replaces `$` with its theme-aware favicon atom SVG,
   without an image request, dependency or change to dashboard data refresh.

HTTP policy stays in adapter dispatch, translation stays in the existing bridge,
source reuse stays inside lazy local recovery, update verification stays in the
explicit management command and terminal formatting stays in presentation.
README, reference and architecture documents describe the actual boundaries.
No framework, package dependency, transcript watcher, client program-file patch,
OS proxy/trust policy change or broad POST retry was introduced.

## Bounded verification and review

- Baseline: 1,189 passed, eight Windows-only skips, zero failures. The initial
  sandboxed attempt could not bind loopback ports; the same baseline passed when
  temporary HTTP/TLS listeners were permitted.
- Final local candidate: 1,203 passed, eight Windows-only skips, zero failures.
- Offline HTTP/idle-SSE and all nine isolated CLI startup/reuse scenarios passed.
  The disabled-image replay also verifies a real post-Ready background model
  refresh uses the two-column layout. Image failures/conflicts remain isolated
  from core inference, and invalid core configuration remains a real error.
- Synthetic source-read evidence: eight overlapping recoveries use one source
  open, not eight; each caller still validates its own retained prefix. Cancelling
  one waiter preserves another. Repeated stable-source failure skips a second
  decode; source replacement and TTL expiry recheck it. No real user transcript
  was used, and the original issue reporter's real-session acceptance is unchanged.
- One scoped review corrected a null-tool validation case, an exact timeline
  assertion for additive metadata and a test provider that ignored AbortSignal.
  The corrected actual-HTTP fixtures verify cancellation without weakening the
  production contract. No unrelated refactoring or optimization was added.
- Package and cross-platform gates must pass before stable publication. Windows
  CI explicitly includes the new Chat and actual-HTTP delivery tests, in addition
  to existing updater, NTFS/profile/trust and optional prediction tests. CI is not
  proof of live corporate-network routing or visible gray suggestions.

## Performance evidence

Both baseline and candidate pass existing relative/resource gates. Adapter-import
RSS is 58.4 -> 58.6 MiB; heap remains 7.1 MiB. SSE 1/2/4/8 MiB scan ratios remain
1.0, repeated 8 MiB tool-output parsing remains once, eight duplicate image uses
still invoke one optimizer and image ArrayBuffer net growth remains zero.

| Preparation scenario | Baseline time | Candidate time | Baseline / candidate peak RSS delta |
| --- | ---: | ---: | ---: |
| 5 MiB x4 | 200.6 ms | 106.9 ms | 102.7 / 103.8 MiB |
| 30 MiB x1 | 253.7 ms | 156.5 ms | 162.2 / 170.8 MiB |
| 30 MiB x2 | 290.6 ms | 270.8 ms | 228.9 / 228.6 MiB |

These are single local samples under varying machine load, not statistical
speedup/no-regression evidence or claims about upstream inference. Concrete gains
are verified rejection of unwanted browser dispatch, preserved translation
semantics, less repeated recovery I/O and truthful installation/status output.

## Publication

Pending the candidate's complete cross-platform CI and stable publication receipts.
