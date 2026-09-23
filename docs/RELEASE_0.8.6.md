# CCDX 0.8.6 verification report

Date: 2026-09-23. Baseline: `b2d2907` (0.8.5).

## Scope

- For identity-encoded JSON bodies with a declared length from 1 to 24 MiB,
  copy received chunks into one bounded buffer and decode once. Small,
  unbounded-length, compressed, and larger requests keep their prior paths.
- Count long JSON history strings using the native UTF-8 byte-length path for
  an unescaped prefix. Escapes and unpaired surrogates keep exact JSON sizing.

This release does not change the 64 MiB default history limit, eviction
policy, model catalog authorization/refresh, stream backpressure, image
optimization quality or concurrency, or optional image setup.

## Performance baseline and comparison

Repeated on Node 22.20.0 on the same host, in isolated processes. Values are
medians, not cross-machine limits.

| Scenario | 0.8.5 baseline | 0.8.6 candidate | Runs |
| --- | ---: | ---: | ---: |
| 18 MiB request with two real, high-entropy JPEGs: extra peak RSS | 146.9 MiB | 112.5 MiB | 5 each |
| Same request: local preparation time | 379.1 ms | 367.1 ms | 5 each |
| 18 MiB synthetic padded-image request: extra peak RSS | 68.0 MiB | 39.3 MiB | 5 each |
| 30 MiB inline-image history node: cache-write time | 81.9 ms | 23.8 ms | 7 each |

The existing four-by-5-MiB resource benchmark also improved from roughly
172 MiB to 163 MiB peak RSS. The 30 MiB request keeps the previous streaming
read path after preallocation increased its synthetic peak RSS in a trial.
The cached history's logical byte count, materialized content, and configured
capacity are unchanged. These benchmarks do not imply faster upstream model
inference or a larger history cache.

## Verification

- `npm run verify` passed: 830 unit tests, offline HTTP smoke, performance/
  resource checks, and npm package dry-run. The unit tests include large
  UTF-8 bodies with accurate, under-,
  and over-declared lengths, and exact history byte accounting.
- 500 deterministic UTF-16 cases matched `JSON.stringify` byte counts.
- Nine isolated startup/reuse scenarios passed with fake credentials and no
  real provider calls. Disabled image profiles made zero image requests;
  pending and failing image operations did not block core Responses.
- Offline tests required local loopback permission; package dry-run used an
  isolated temporary npm cache because this host's default cache is not
  writable in the task sandbox.
- No model-list cache-first shortcut was added: each discovery request still
  observes live upstream authorization failures, including 401/403.

## Publication

Pending GitHub CI, GitHub Release, and npm workflow verification.
