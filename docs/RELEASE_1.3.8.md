# CCDX 1.3.8

WebUI now owns normal prediction, image, update and diagnostic workflows. CLI remains available for automation and recovery. Existing model sources, native search/MCP configuration, privacy transport and account bindings retain their behavior.

Prediction controls synchronize native Show predictions and the local integration. Fresh cold startup attempts setup when Codex is closed and preserves saved off choices. An open App records a pending display change; WebUI can continue configuration after App closure, open Codex, reconfigure, remove or repair without terminal commands. Only desktop prediction preference and its legacy equivalent are changed in App configuration; no running App is forcibly closed. Reconfiguration replaces the bridge after trust commits. Warm version handoff never performs first-time setup or pending display writes.

Image setup offers address, masked key input, model discovery, save and removal. It uses the existing missing-prompt protocol check and atomic credential/config/guidance transaction, generates no image during setup, and retains an empty key only for the same origin. Disabled/unbound API deletion and decoded request limits are available in WebUI. Environment-controlled limits stay read-only.

Manual WebUI and `ccdx update apply --yes` updates share the existing staged verification, immutable worker and rollback path. Active work defers a switch; duplicate clicks do not duplicate installation; manual updates do not enable overnight updates or downgrade. Matched writable installed launches support this path. Unmanaged launches show the installer/installed-command requirement. Core update notices run after cold startup, so optional setup does not consume their network deadline.

The confirmed Codex compatibility test uses the same CLI/WebUI checker. It supports vendor Responses model IDs, uses local client credentials only on loopback, refuses redirects, redacts diagnostics and requires WebUI confirmation for quota use. UI labels describe Codex Responses/stream/compaction coverage.

Validation distinguishes native execution, synthetic accounts and visible App behavior. Native App-bundled Codex config/account reads verified on/off/on display values, unchanged model and preserved synthetic ChatGPT sign-in/auth bytes. This is not a visible-prediction or real-account-entitlement test. Native Codex privacy-on/off MCP and terminal execution/return/continuation passed locally. Signed Claude App validation remains user-owned from the authorized 1.3.7 handoff; it is not recorded as passed. Cross-platform CI, package installation/upgrade and public download receipts are recorded separately.

See [control mapping](REFERENCE.md#webui-and-cli-controls) and the verification receipt for final publication evidence. The active service is not changed by publication.
