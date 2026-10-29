# State orchestration in 1.3.0

The approved local refactor is implemented. Storage schemas, account bindings, client authentication modes and the data-plane protocols are unchanged.

| Area | Included change | Protected behavior |
| --- | --- | --- |
| Connection operations | Named preparation/selection handlers inside the existing runtime | Same serial queue, revision validation, secret commit/cleanup points and synchronization order |
| Client synchronization | Separate Codex writing, Claude preparation/writing and shared capability reconciliation | Same await point for desktop inspection; App/Code shared fields are still coordinated together |
| Full snapshots | Obtain each client's cached plan once within that snapshot and reuse it for source impacts | Same public values and property order, isolated public objects, no credential/transport initialization |
| Access state | Keep `codexAccessMode` as the existing authority | Disabled/paused/native/gateway distinctions and paused-before-credentials rejection remain |
| Graph persistence | Use the existing compare-before-atomic-write helper under the existing lock | v1 backup keeps original bytes; identical serialized content keeps mtime/mode; explicit sync actions still execute |
| CLI loading | Load startup composition after help/version/management/local tools exit | Same command grammar, exit codes, stdout/JSON and offline image/prediction status |

## Evidence and boundaries

A paired synthetic snapshot comparison returned identical public data before/after. With three clients selecting 800 models, 20 reads reduced plan lookups from 48,660 to 60. The local median changed from about 23.2ms to 10.0ms; this is a control-plane benchmark, not an inference-latency claim. Small legacy snapshots also retained their data and avoided repeated plan compilation. No global cache was added.

Five fresh CLI processes per command, with the local filesystem warm, measured median `version` at about 65.7ms before / 32.0ms after, and `help` at 62.0ms / 29.5ms. These are local observations, not cross-platform timing guarantees.

Meaningful regression cases cover original-byte v1 backup, unchanged graph timestamps/mode, native auth bytes, stable local gateway keys/source identity, retained selections/manual sync, and an actual synthetic request consuming the retained key, reasoning effort and output limit. The current native client, protocol, platform, streaming and install gates remain required.

## Upstream references

- [Magpie account-local preservation](https://github.com/yetone/magpie/commit/5ed6669cec2a377e385d7047dc6cdc8ff23c6ef4) and kept-connection behavior informed the preservation boundaries. No account/quota-driven takeover or automatic fallback was imported.
- [cc-switch plan/ownership separation](https://github.com/farion1231/cc-switch/blob/cd9c721086fbee36a1d9b1d986a8f3e14ac69147/src-tauri/src/services/provider/codex_editor.rs) informed local preparation versus effect boundaries. CCDX retains its existing ownership journals and writers.
- Versioned-result reuse and deterministic timestamp boundaries informed the benchmark/fixture design. CCDX's existing usage cache and stream deadlines were not replaced.

## Deferred work

Further cache/index layers, selective invalidation beyond the existing targeted-sync policy, new routing behavior and DNS-level self-forwarding detection remain outside this release. Images, prediction, account/tenant isolation, request admission, stream cancellation/backpressure and conversation ownership keep their current implementations.
