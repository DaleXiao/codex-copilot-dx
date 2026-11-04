# CCDX 1.3.14

Adds native GitHub Copilot image controls and restores Claude App reasoning controls after upgrading to 4.x.

- Use Copilot image generation and editing through Codex native Images integration. Image models stay separate from the conversation model picker.
- Choose an available image model in WebUI or TUI. Images are enabled by default while a saved disabled choice is preserved. Source controls, Codex settings and sync preview share the same selection.
- Retire the older CCDX image MCP/skill setup during installation or takeover, preserving historical images and user-modified configuration.
- Restore reasoning-compatible custom-model routes and capability synchronization for Claude App 4.x. Preserve old conversation routes, model ordering and long-context choices. Non-contiguous upstream effort declarations remain limited.
- Vertically center the sidebar atom icon and CCDX label while retaining the existing fonts, colors and motion.
- Show saved custom API source names in usage tables and model filters. Stable accounting keys are preserved; unknown or deleted sources retain their IDs. Protocol replays keep their records out of normal usage logs.

Unverified: signed Codex/Claude App UI acceptance, real image generation/editing and autonomous image-tool selection by a real conversation model.
