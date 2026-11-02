# CCDX 1.3.10

Fixes the 1.3.9 local-masking regression that could leave Codex and Claude requests repeatedly returning 503.

- Keep submitted local detection alive after request timeout or cancellation. Retries reuse in-flight work and valid completed batches; unused batches are skipped before submission. Invalid results never enter the detection cache.
- Preserve explicit zero usage and distinguish conflicting cache aliases. Keep native Messages prefixes, signed history and existing account/configuration ownership unchanged.
- Bound total unfinished stream-channel data and release delivered text without retaining duplicate deltas. Preserve tool restoration, event metadata and original upstream failures.
- Share masking preparation between WebUI and `config privacy` controls. Show effective readiness separately from the latest check; temporary waits include an accurate retry message.
- Verify real classifiers with real native clients and tool continuation on all four platform builders. Retain the separate simulated-classifier, browser, installation and historical regression gates.
- Resume interrupted publication from its original artifact without rebuilding, replacing shipping assets or uploading npm again. Verify delayed npm processing within a finite deadline.

The model component remains pinned to 1.3.9. Whole text entries retain their detection context; raw text splitting was not adopted after the isolated comparison showed additional cost. Complete model checks remain required before upstream dispatch.

Release work does not switch the active service or restart desktop applications. Native CLI and protocol replays do not establish acceptance of every signed Claude App UI workflow. Final public checks are recorded in the [release receipt](https://github.com/DaleXiao/codex-copilot-dx/releases/download/v1.3.10/release-receipt.json).
