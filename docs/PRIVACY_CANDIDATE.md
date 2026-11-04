# 1.3.12 privacy candidate

This document records the initial candidate stage. Current delivery is described in [release notes](RELEASE.md).

Reference: Magpie 7c115f6f5b838c5c57ab3f5fb2942f540a86a971. Read its masking wrapper, detector, per-piece cache and exact native window reuse, in-flight ownership, execution turns, JSON contexts and streaming writer together. CCDX keeps its existing complete-check-before-send policy, private per-client mappings, optional ABI 1 and bounded memory; Magpie's partial-model fallback and disk detection cache are not adopted.

Initial work and acceptance:

1. Reproduce stream boundary failures with isolated synthetic Responses and Messages events; verify original frame order, tool argument escaping/types, terminal/error events and no premature tool execution.
2. Add bounded diagnostics for exact privacy error and event/channel types; verify that no request/response text, argument value, mapping or credential enters diagnostics.
3. Add exact native token-window caching and shared work; verify unchanged offsets/margin decoding, cancellation acknowledgement, incremental reuse, bounded memory and short-request responsiveness. The first byte-piece draft showed cold regressions and is not the selected strategy.
4. Integrate cold-check waiting and misleading-secret filters with existing controls; verify disabled behavior and real-secret positive cases.
5. Verify real component plus actual clients in isolated profiles, full local verification, native platform CI and isolated package upgrade; report unavailable signed-App validation separately.
6. Freeze the candidate artifact and receipts for review; do not tag a release, publish npm/GitHub assets, update user installations or restart Apps.

The first draft passed protocol/platform checks but its extra byte overlaps regressed cold detection by 35–69% in some measured cases. It was rejected as the final strategy. The selected native-window cache preserves tokenization and natural overlap boundaries; final platform results replace the work list after validation.
