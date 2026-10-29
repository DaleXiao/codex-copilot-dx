# State-code review and proposed work

Status: proposal for discussion. The 1.3 candidate changes presentation and command entrypoints; it does not replace these state machines.

| Area | Current risk | Smallest useful change | Acceptance check |
| --- | --- | --- | --- |
| `connection-runtime.mjs`: `change` | Validation, graph mutation, key retirement and synchronization share a large dispatcher | Extract one mutation at a time into a named local function. Keep the existing queue, revision checks and atomic writer | Same before/after graph, conflict result and secret cleanup; no extra synchronization |
| `connection-runtime.mjs`: `performClientSync` | Nested client conditions make preservation and paused states hard to review | Separate the Codex and Claude branches into local functions. Keep the shared Claude capability plan and synchronization queue | Native login/config bytes stay intact; paused/disabled/manual/unavailable remain distinct; one client cannot restore another's fields |
| `connection-runtime.mjs`: `snapshot` | Repeated plan lookups and nested projections obscure data ownership | Read each cached plan once per client and name its public projections. Profile snapshot cost before adding another cache | Equivalent redacted snapshots; no key exposure, selection changes or extra catalog reads |
| Client access state | Authorization, configuration and presentation can drift if they rederive the same conditions | Retain `codexAccessMode` as the existing access authority. Audit consumers and remove duplicated access decisions only where found | Empty selections return paused 503 before credential checks; GitHub-only and mixed-source authentication remain separate |
| `bin/cli.mjs` | Many static imports make unrelated commands load startup components | Measure cold help/version/status first. Move only proven unnecessary command imports behind their dispatch branch | Same command output and exit codes; read-only commands never start services, apps or sign-in |
| TUI / Web UI projection | Setup, process activity and model availability are different facts | Reuse existing projections and name each fact consistently. Keep unknown states explicit; do not infer app identity from protocol | One source summary, one app setup view, actual request activity; no false ready/running claim |

## Protected boundaries

- Keep native account stores and user/managed configuration untouched.
- Keep all current image and prediction behavior, certificates, routes and setup/removal ownership.
- Keep request admission, stream cancellation/backpressure, conversation ownership and capability snapshots in the data path.
- Keep old saved configuration readable. Removing old CLI syntax does not authorize resetting profiles, selections or keys.
- Do not add a plugin framework, generic workflow engine or new cache without a measured need.

## Sequence and stop condition

1. Capture the affected state transitions and their current outputs.
2. Refactor one area, without a format-only repository rewrite.
3. Run its meaningful transition tests and the existing native client regression gates.
4. Stop when behavior matches and the responsibility is easier to review. Further extraction requires a new concrete problem.

Each future change should report its own scope and evidence. This document does not claim that these proposals are implemented or that a performance gain has been measured.
