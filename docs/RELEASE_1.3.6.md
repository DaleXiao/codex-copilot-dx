# CCDX 1.3.6

Baseline: 1.3.5. This release adds opt-in local masking and closes two transport/configuration boundaries without changing native sign-in, model selections, image setup or prediction routing.

Settings → Advanced retains the existing themes, controls and disclosure layout. Masking is off by default. First activation downloads and verifies a small platform component plus about 39 MB of model/tokenizer files. Protection activates after loading. Personal information is optional; a local sample check, progress, cancellation, retry and separate component deletion are available. Source/model forms retain drafts and commit input before validation; no additional catalog or account polling is introduced.

Covered requests use rules and a local classifier, then restore reply text and tool arguments. Unknown/signed/encrypted protocol state is not rewritten. Policies remain pinned for retries. Incomplete checks never contact the upstream service. Bounded background classification can warm shared metadata for a later retry. Ordinary installations contain no model weights and need no compiler, Python or GPU package.

Unaliased Messages streams now forward complete frames rather than raw partial transport chunks. Valid final events without a trailing newline remain deliverable. Old capability field restoration and replacement budgets share one journal transaction. Failed writes preserve the previous configuration and ownership record.

Existing settings backups remain readable with masking off as the inherited default. Reset backs up masking choices and retains accounts, keys, model selections, app routes, images and predictions. Masking metadata contains counts/timing rather than original values.

Required verification includes fault-reproduction tests, full verify, native four-target component builds/inference, browser replay, strict/offline installation and isolated 1.3.5 upgrade. Publication must verify the exact npm artifact and every GitHub asset. The active local service is not switched by publication.
