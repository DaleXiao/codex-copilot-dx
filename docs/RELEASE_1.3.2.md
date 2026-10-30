# CCDX 1.3.2

Baseline: 1.3.1. Existing accounts, model selections and client configuration need no migration or repeat setup.

- First-time GitHub credential discovery hands its already-verified short-lived service token to the matching runtime. Matching credential/identity, expiry and existing cache/account/refresh guards prevent inappropriate reuse. Service tokens stay memory-only.
- Messages context observations consume the selected route's effective model window, including aliases and overrides. Legacy sources use cached metadata; unknown values stay unknown. No catalog refresh or extra inference is added.
- Claude App may protect its saved gateway key at rest. When the expected key is already owned by CCDX, model synchronization preserves the encrypted field and still reconciles owned, unchanged model settings. Changed profiles, foreign addresses, rotated keys and user edits remain protected. Encryption does not imply access verification; no decryption or new OS permission is added.
- Diagnostics reject oversized text before normalization/redaction and clip ordinary text on Unicode boundaries. Original protocol responses, error classifications and retry behavior remain unchanged.
- Identical concurrent reads of active usage logs share one scan of the observed file identities. Results are not retained after that scan, and the existing settled-file cache, filters and caller isolation remain. A cancelled waiter does not cancel other readers; a started bounded file scan may finish after all waiters leave.

Images, native input suggestions, client sign-in/configuration modes, source selection, streaming and supported Windows/macOS platforms retain their existing behavior. Responses WebSocket, content masking, automatic routing and extra cache/index systems are outside this patch.

Release gates include focused ownership/concurrency/protocol cases, full verification, browser and native-client/platform CI, performance comparisons, isolated 1.3.1 upgrade, strict/offline platform installs, and independent public package/download integrity checks.
