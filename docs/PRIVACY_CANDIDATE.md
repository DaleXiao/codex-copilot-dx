# 1.3.12 privacy candidate

This candidate is not published and does not replace the running service.

Reference: Magpie 7c115f6f5b838c5c57ab3f5fb2942f540a86a971. Read its masking wrapper, detector, per-piece cache, in-flight ownership, execution turns, JSON contexts and streaming writer together. CCDX keeps its existing complete-check-before-send policy, private per-client mappings, optional component ABI and bounded memory; Magpie's partial-model fallback and disk detection cache are not adopted.

Work and acceptance:

1. Reproduce stream boundary failures with isolated synthetic Responses and Messages events; verify original frame order, tool argument escaping/types, terminal/error events and no premature tool execution.
2. Add bounded diagnostics for exact privacy error and event/channel types; verify that no request/response text, argument value, mapping or credential enters diagnostics.
3. Add long-text piece caching and shared work with bounded turns; verify UTF-8 offsets/overlap, partial progress, cancellation recovery, incremental edits and short-request responsiveness.
4. Integrate cold-check waiting and misleading-secret filters with existing controls; verify disabled behavior and real-secret positive cases.
5. Verify real component plus actual clients in isolated profiles, full local verification, native platform CI and isolated package upgrade; report unavailable signed-App validation separately.
6. Freeze the candidate artifact and receipts for review; do not tag a release, publish npm/GitHub assets, update user installations or restart Apps.

Results will replace this work list when verification completes.
