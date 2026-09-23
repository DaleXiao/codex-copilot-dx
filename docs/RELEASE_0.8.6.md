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

- Release commit/tag: `9c873c7` / `v0.8.6`.
- GitHub CI passed on Node 22.15.0 and 24.x:
  `https://github.com/DaleXiao/codex-copilot-dx/actions/runs/35847478080`.
- GitHub Release:
  `https://github.com/DaleXiao/codex-copilot-dx/releases/tag/v0.8.6`.
- The one-shot npm workflow passed, including its `prepublishOnly` verification:
  `https://github.com/DaleXiao/codex-copilot-dx/actions/runs/35847699773`.
- The workflow published `codex-copilot-dx@0.8.6` under `latest`. Its SHA-1
  `0891e602c953031d44fa8efd05d7b1415d2039f5` and 92-file, 240.1 kB
  package summary match the local dry-run.
- Direct anonymous registry verification from this host failed with
  `ENOTCONN`; the successful publish workflow and matching package digest
  are the publication evidence. Publication was not repeated.
