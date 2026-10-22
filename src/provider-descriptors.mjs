// Read-only presentation data; provider selection and account transactions stay in composition.
export function providerDescriptors({ state, githubRuntime, githubRegistry, githubClientConfigured,
  githubGeneration, m365Generation, claudeClients, claudeReason, gatewayRunning, lastClients, definitions }) {
  const ms = state.m365;
  const projections = [
    { id: "github", generation: githubGeneration, enabled: true, state: githubRuntime.token_cached ? "ready" : "unknown",
      auth: { state: "unknown", token_cached: githubRuntime.token_cached === true, expires_in_ms: githubRuntime.token_expires_in_ms ?? null },
      models: { count: githubRegistry?.models?.data?.length ?? null, source: githubRegistry?.source || "unknown" },
      clients: [{ id: "codex", name: "Codex App", selected: state.codex_provider === "github", state: githubClientConfigured ? "configured" : "unknown" }] },
    { id: "m365", generation: m365Generation, enabled: ms.enabled, state: ms.state, reason: ms.reason,
      network_diagnostic: ms.network_diagnostic, catalog_diagnostic: ms.catalog_diagnostic,
      auth: { state: ms.token_cached ? "authorized" : !ms.enabled ? "disabled" : ms.reason ? "unavailable" : "unknown",
        account: ms.account?.login || "", tenant: ms.account?.tenant || "", selection_source: ms.account?.selection_source || null,
        token_cached: ms.token_cached === true, expires_in_ms: ms.token_expires_in_ms ?? null, checked_at: ms.token_checked_at || null },
      models: { count: ms.models?.total ?? null, source: ms.models?.source || "unavailable", checked_at: ms.models?.refreshed_at || null },
      clients: [{ id: "codex", name: "Codex App", selected: state.codex_provider === "m365", state: state.codex_provider === "m365" ? ms.state : "standby" },
        ...[["code", "Claude Code"], ["app", "Claude App"]].map(([id, name]) => ({ id: `claude_${id}`, name,
          selected: ms.enabled, state: claudeClients[id], gateway: gatewayRunning ? "running" : "unavailable", reason: claudeReason,
          last_request_at: lastClients[`claude_${id}`] || null }))],
      requests: ms.claude.requests, request_scope: "Claude Messages" },
  ];
  return definitions.map(definition => ({ ...projections.find(source => source.id === definition.id),
    id: definition.id, name: definition.name, selection: { codex: definition.codex, models_required: definition.modelSelection } }));
}
