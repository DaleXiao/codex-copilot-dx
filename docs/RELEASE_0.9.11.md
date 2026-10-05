# CCDX 0.9.11 verification report

Date: 2026-10-05. Baseline: `0f1bb1a` (0.9.10).

## Scope

- Harden only existing diagnostic redaction: Basic authorization payloads, URL
  userinfo and escaped quotes inside sensitive JSON values. Preserve ordinary
  Basic-related prose, safe endpoint hosts/paths and useful error codes. Do not
  rewrite forwarded upstream request/response bodies or claim arbitrary error
  prose is guaranteed free of sensitive content.
- After measuring the baseline, add one process-local plain-summary cache.
  Concurrent queries of settled, unchanged retained logs share a scan. File path,
  device/inode, size and nanosecond modification/change times identify the input;
  recent writes within two seconds bypass reuse. Compare inputs again after scans.
- Cache at most 128 model groups and 256 KiB of serialized summary data, not raw
  records. Larger results remain complete and uncached. Returned summaries are
  independently cloned. Warnings, changed inputs, metadata/read errors and custom
  warning callbacks do not become cached clean snapshots.
- Analytics callbacks retain their original streaming path. No new persistent
  index, database, dependency, background poll, quota feature, conversation scan,
  client patch, model routing or image configuration work is included.

## Baseline and measured results

All 910 baseline tests and existing performance/resource gates passed.
Synthetic logs used the same records before and after, with four queries per case:

| Log | Query | Baseline warm queries | Candidate warm queries |
| --- | --- | --- | --- |
| 4 MiB | Plain summary | 43.085–48.084 ms | 0.050–0.092 ms |
| 32 MiB | Plain summary | 334.552–346.235 ms | 0.067–0.128 ms |
| 32 MiB | Analytics | 553.619–562.262 ms | 555.282–559.239 ms |

First 32 MiB plain reads were 364.052 vs 368.502 ms. The improvement is repeat
plain-summary work, not cold scans, chart analysis, standalone CLI invocations
across processes, model inference speed or upstream prompt-cache hit rate.
Streamed record counts and summary values remained identical. File-read spies
confirm four concurrent settled-file queries perform only one pair of log reads.

## Verification and bounded review

- Final local `npm run verify` passed all 920 tests, offline HTTP smoke,
  performance/resource checks and package dry-run. Isolated startup replay passed
  disabled-image, optional-image-conflict and invalid shared-config scenarios.
- Redaction fixtures use synthetic credentials only; they cover Basic casing,
  opaque labelled authorization, URL userinfo, JSON quoting, nested diagnostic
  strings, failure recording/log formatting and preservation of ordinary prose,
  identities, safe URLs and error codes. No real credential or account test used.
- Cache tests cover shared reads, independent results, append, same-size rewrite,
  file replacement, truncation, rotation/deletion, recent-write bypass, oversize
  bypass, custom callbacks, malformed records, read errors and mid-scan changes.
- The bounded source review found scheme-like text caused repeated unbounded
  prefix scanning in the first URL matcher. Bounding the scheme match removes
  that growth; the 2/4/8 KiB local probes became about 0.54/0.66/1.34 ms.
  Ordinary "Basic authentication" prose is preserved while labelled credentials
  are still removed. Added regression coverage for both cases.
- New fixture corrections retained the production limits: the oversize model
  fixture now actually exceeds the 256 KiB serialized budget, and long opaque
  prose expects the existing redaction result rather than unchanged text.
  No existing test was skipped or weakened; no unrelated scope was added.
- Native SSE parsing/copying, writes, backpressure and content/cancellation
  invariants are compared with the baseline by the existing resource probes.

## Publication and cleanup

Publication receipts and final cleanup are recorded after release verification.
