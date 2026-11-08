import { CLIENT_IDS } from "./access-settings.mjs";
import { claudeSharedCapabilityPlan, claudeSupportForSync, syncClaudeCapabilities } from "./claude-capability-config.mjs";

export function createConnectionClientSync({ options, corePort, configureCodex, configureClaude, restoreClaude, inspectDesktop,
  binding, plan, permitted, getSource, identities, codexAccessMode, capabilitySupport, clientVersionsSnapshot, setup, credentialStates,
  isManaged, isClosed, getSettings }) {
  let sharedSync = null, syncFlight = null, syncAgain = false;
  const syncTargets = new Set(), manualTargets = new Set();
  function capabilitySupportForSync() {
    try {
      return claudeSupportForSync(capabilitySupport, clientVersionsSnapshot?.());
    } catch { /* Optional observations cannot change routing or interrupt synchronization. */ }
    return capabilitySupport;
  }
  async function syncClients(ids = CLIENT_IDS, { manual = false } = {}) {
    if (!ids.length) return;
    for (const id of ids) {
      syncTargets.add(id);
      if (manual) manualTargets.add(id);
    }
    syncAgain = true;
    if (syncFlight) return syncFlight;
    syncFlight = (async () => {
      do {
        syncAgain = false;
        const targets = new Set(syncTargets);
        syncTargets.clear();
        const requested = new Set(manualTargets);
        manualTargets.clear();
        await performClientSync(targets, requested);
      } while (syncAgain && !isClosed());
    })();
    try {
      return await syncFlight;
    } finally {
      syncFlight = null;
    }
  }
  function syncCodexClient(codex, compiledCodex, requested, mode) {
    const explicit = Array.isArray(codex.deployments),
      native = mode === "native";
    try {
      if (mode === "paused" || mode === "disabled") {
        if (mode === "disabled" || codex.auto_sync !== false || requested.has("codex"))
          configureCodex({ ...options, restore: true });
        setup.codex = mode;
      } else if (codex.auto_sync === false && !requested.has("codex")) setup.codex = "manual_sync";
      else if (codex.enabled && compiledCodex.defaultUnavailable && !native)
        setup.codex = "default_unavailable";
      else {
        setup.codex = configureCodex({
          ...options,
          ...(codex.enabled &&
          (native || (explicit && codex.deployments.length) || codex.source?.startsWith("api_"))
            ? {
                baseUrl: `http://127.0.0.1:${corePort}/v1`,
                native,
                ...(native ? { nativeModels: compiledCodex.models } : {}),
                ...(!native ? { apiKey: identities().codex } : {}),
                ...(explicit || !native
                  ? {
                      model:
                        compiledCodex.defaultModel ||
                        (!compiledCodex.defaultUnavailable ? codex.model : undefined),
                    }
                  : {}),
              }
            : { restore: true }),
        }).state;
        if (codex.enabled && compiledCodex.defaultUnavailable && setup.codex === "configured")
          setup.codex = "default_unavailable";
      }
    } catch {
      setup.codex = "configuration_unavailable";
    }
  }
  function prepareClaudeSync(id, requested) {
    const selected = binding(id),
      compiled = plan(id);
    const source = selected.source && permitted(id, selected.source) ? getSource(selected.source) : null;
    try {
      if (selected.enabled && compiled.defaultUnavailable) {
        setup[id] = "default_unavailable";
        return null;
      }
      if (!selected.enabled || !compiled.models.length) {
        const result = restoreClaude({ ...options, client: id });
        setup[id] = result.preserved ? "preserved" : "not_configured";
        return null;
      }
      if (selected.auto_sync === false && !requested.has(id)) {
        setup[id] = "manual_sync";
        return null;
      }
      return { selected, compiled, source };
    } catch {
      setup[id] = "configuration_unavailable";
      return null;
    }
  }
  function writeClaudeSync(id, { selected, compiled, source }, desktopManaged) {
    const m365Only = compiled.models.every(model => model.source_id === "m365");
    const result = configureClaude({
      ...options,
      client: id,
      profileName: "CCDX",
      desktopAliases: id === "claude_app" && source?.id.startsWith("api_"),
      disableExperimentalBetas: m365Only,
      desktopManaged: id === "claude_app" ? desktopManaged : false,
      baseUrl: `http://127.0.0.1:${corePort}/anthropic`,
      apiKey: identities()[id],
      models: compiled.models,
      defaultModel: Array.isArray(selected.deployments) ? compiled.defaultModel : undefined,
    });
    setup[id] = result[id === "claude_app" ? "app" : "code"] || "not_configured";
    if (id === "claude_app" && result.app_credential) credentialStates[id] = result.app_credential;
  }
  function syncSharedClaudeCapabilities(targets) {
    if (["claude_app", "claude_code"].some(id => setup[id] === "default_unavailable")) {
      sharedSync = {
        ...sharedSync,
        state: "partially_preserved",
        limitations: [{ code: "default_model_unavailable" }],
      };
      return;
    }
    if (!["claude_app", "claude_code"].some(id => targets.has(id))) return;
    if (
      ["claude_app", "claude_code"].some(
        id => !targets.has(id) && !setup[id] && binding(id).enabled && plan(id).models.length
      )
    ) {
      sharedSync = { state: "partially_preserved", limitations: [{ code: "other_client_not_checked" }] };
      return;
    }
    const shared = claudeSharedCapabilityPlan({
      app: setup.claude_app === "configured" ? plan("claude_app").models : [],
      code: setup.claude_code === "configured" ? plan("claude_code").models : [],
      support: capabilitySupportForSync(),
    });
    if (["claude_app", "claude_code"].some(id => setup[id] === "manual_sync")) {
      sharedSync = {
        ...shared,
        state: "partially_preserved",
        limitations: [...shared.limitations, { code: "manual_sync" }],
      };
      return;
    }
    try {
      sharedSync = { ...shared, ...syncClaudeCapabilities(shared, options) };
    } catch {
      sharedSync = { state: "configuration_unavailable", limitations: shared.limitations };
    }
  }
  async function performClientSync(targets, requested = new Set()) {
    if (!isManaged() || isClosed()) return;
    for (const id of targets) delete credentialStates[id];
    if (options.preserveClientConfiguration?.()) {
      for (const id of targets) setup[id] = "preserved";
      return;
    }
    const codex = binding("codex"),
      compiledCodex = plan("codex"),
      mode = codexAccessMode();
    if (targets.has("codex")) syncCodexClient(codex, compiledCodex, requested, mode);
    if (!getSettings().claude_private_keys || !["claude_app", "claude_code"].some(id => targets.has(id))) return;
    let desktopManaged;
    for (const id of ["claude_app", "claude_code"]) {
      if (!targets.has(id)) continue;
      const sync = prepareClaudeSync(id, requested);
      if (!sync) continue;
      try {
        if (id === "claude_app") desktopManaged ??= await inspectDesktop(options);
        writeClaudeSync(id, sync, desktopManaged);
      } catch {
        setup[id] = "configuration_unavailable";
      }
    }
    syncSharedClaudeCapabilities(targets);
  }
  return { syncClients, capabilitySupportForSync, shared: () => sharedSync, busy: () => Boolean(syncFlight), pending: () => syncFlight };
}
