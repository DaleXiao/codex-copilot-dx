// Client files have their own ownership and policy lifecycle, independent of
// source authentication, catalog discovery and inference transport.
export function createClaudeClientLifecycle({ options, configureClients, restoreClients } = {}) {
  let clients = { code: "not_configured", app: "not_configured" }, reason = null, pending = null;
  return {
    snapshot: () => ({ clients: { ...clients }, reason }),
    sync({ source, baseUrl, apiKey, current = () => true }) {
      if (pending) return pending;
      pending = (async () => {
        try {
          const integration = configureClients ? null : await import("./claude-client-config.mjs");
          const desktopManaged = integration ? await integration.inspectClaudeDesktopPolicy(options) : false;
          if (!current()) return;
          clients = (configureClients || integration.configureClaudeClients)({ ...options, desktopManaged, baseUrl,
            apiKey: apiKey(), models: source.models("claude") });
          reason = null;
        } catch {
          if (!current()) return;
          clients = { code: "configuration_unavailable", app: "configuration_unavailable" };
          reason = "m365_claude_config_unavailable";
        }
      })().finally(() => { pending = null; });
      return pending;
    },
    async restore() {
      await pending;
      const restore = restoreClients || (await import("./claude-client-config.mjs")).restoreClaudeClients;
      const result = restore(options);
      clients = { code: result.preserved ? "preserved" : "restored", app: result.preserved ? "preserved" : "restored" };
      reason = null;return result;
    },
  };
}
