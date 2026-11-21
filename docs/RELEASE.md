# CCDX 1.4.14

- Antigravity's GitHub Copilot requests now wait up to 180 seconds for response headers by default. Saved settings and explicit startup overrides still take priority.

- Antigravity compression keeps the last confirmed conversation model when a model change fails. Older requests completing late cannot override the newer confirmed choice.
- Dashboard status refreshes skip full provider diagnostics. Local masking avoids copying request bodies when nothing needs replacing and reports phase timings for large text checks.

Unverified: live Copilot response-header waits near the new limit.
