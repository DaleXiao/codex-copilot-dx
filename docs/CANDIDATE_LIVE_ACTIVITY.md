# Live activity candidate

Baseline: published 1.3.2. Candidate branch: `codex/live-activity-candidate`. This candidate is unpublished; the package version and current installation remain unchanged. The next stable patch version will be assigned only when release is authorized.

Scope: shared process-local activity notifications, visible-page SSE, reconnect snapshots, and TUI activity updates. Existing themes, animation shapes, routing, credentials, model selections, image/prediction behavior and installation policy are retained.

Acceptance: three applications/models update in a real browser and TUI; long requests remain live beyond the previous six-second expiry; disconnect/reconnect restores current activity and totals; Auto refresh OFF and hidden pages disconnect; slow consumers remain bounded; SSE never keeps work busy or forces normal shutdown. Retained recent records keep their existing limits; there is no event replay or cross-restart history guarantee.
