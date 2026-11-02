# CCDX 1.3.11

Completes the verified publication flow when npm permits latest promotion but denies removal of a temporary verification tag.

- Record denied verification-tag cleanup without failing an already verified publication. Keep the registry permission policy and report the retained tag in the public receipt. Unexpected cleanup errors still fail closed.
- Retain 1.3.10's privacy timeout recovery, valid-result caching, whole-text batch progress, bounded stream restoration, accurate usage and shared WebUI/CLI masking controls.
- Retain the measured Intel short-window backend policy and idle, ABI/model-verified component migration. The optional component remains pinned to 1.3.10; model weights are reused.
- Keep exact-source full CI, real classifier/native-client gates on four targets, installation upgrades and downloaded public npm/GitHub byte verification.

No active service or desktop application is restarted by publication. Signed Claude App UI acceptance remains separate from CLI/protocol coverage. Public shipping proofs and cleanup status are in the [release receipt](https://github.com/DaleXiao/codex-copilot-dx/releases/download/v1.3.11/release-receipt.json).
