# CCDX 1.3.12

Reduces repeated local privacy work and preserves valid tool continuations, with a smaller WebUI copy change that keeps existing layouts, fonts, icons and controls.

- Restore streaming tool arguments incrementally with JSON escaping, content-part isolation and terminal validation. Preserve opaque protocol identities, signed state and complete client-visible values.
- Reuse exact natural classifier windows in bounded memory. A canceled caller leaves completed windows reusable; native admission remains held until physical acknowledgement. Older ABI-compatible components remain usable.
- Reuse CPU intermediate matrices within each inference and C-owned CoreML input arrays within the serialized model. Clear retained input arrays after successful and failed predictions; model mathematics and threading are unchanged.
- Keep the existing inexpensive startup preflight. Give uncached text beyond one 16 KiB batch, or a native plan with multiple pending windows, the existing bounded 60-second wait. Complete checks still precede every covered upstream request.
- Remove redundant branding, category tags and normal switch-state prefixes. Preserve unknown states, setup prerequisites, protection scope, errors, update effects and operation confirmations. WebUI and CLI share the same controls; command names remain unchanged.
- CI and new prebuilt assets cover macOS ARM64 and Windows x64/ARM64; Intel code remains available.

Fixed-Mac measurements found substantially faster long-text appends, with about 0.010 ms added to cached Chinese checks and 0.069 ms added to short-field appends. Timing differences are reported; use request records to observe local-check duration and errors after upgrading.

Unverified: sustained real-use performance and signed Claude App UI acceptance.
