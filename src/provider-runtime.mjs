import fs from "node:fs";
import { providerDescriptors } from "./provider-descriptors.mjs";
import { autoReviewPreference, writeAutoReviewModel } from "./user-settings.mjs";
import { autoReviewReasoningEfforts, DEFAULT_CODEX_AUTO_REVIEW_MODEL, responsesModelIdsFromCopilotModels } from "./models.mjs";
import { publicModelCatalog } from "./provider-metadata.mjs";
import { createGithubProvider } from "./providers/github.mjs";
import { readProviderSettings, writeProviderSettings } from "./provider-settings.mjs";
import { readM365Settings, updateM365Settings, m365Paths, ensureM365GatewayKey, readM365Account, m365AccountKey } from "./m365-settings.mjs";
import { requestM365Accounts } from "./providers/m365-auth.mjs";
import { publicM365Accounts, accountChoiceId, m365AccountMessage } from "./providers/m365-accounts.mjs";
import { providerRegistry } from "./provider-registry.mjs";
import { createClaudeClientLifecycle } from "./claude-client-lifecycle.mjs";
import { m365NetworkMessage } from "./providers/m365-network-diagnostic.mjs";
import { createConnectionRuntime } from "./connection-runtime.mjs";
import { accessSettingsPath, readAccessSettings } from "./access-settings.mjs";
import { createStreamPerformanceMetrics } from "./stream-performance.mjs";

const unavailable = reason => Object.assign(new Error(`Microsoft 365 is unavailable (${reason}); GitHub routing was not substituted`),
  { code: reason, statusCode: 503 });

// Composition owns source selection. Providers never modify Codex, prediction,
// image configuration or each other's credentials.
export function createProviderRuntime(options = {}) {
  options = { ...options, corePort: options.corePort ?? Number((options.env || process.env).ADAPTER_PORT || 2026) };
  let connections;
  const legacy = createBuiltinProviderRuntime({ ...options, managedClaude: () => {
    if (!fs.existsSync(accessSettingsPath(options))) return false;
    const graph = readAccessSettings(options);
    return graph.claude_private_keys || !["claude_app", "claude_code"].every(id => graph.clients[id].enabled && graph.clients[id].source === "m365" && graph.clients[id].allowed.includes("m365"));
  },
    onClaudeReady: () => connections?.syncClients() });
  connections = createConnectionRuntime({ ...options, legacy });return connections;
}

function createBuiltinProviderRuntime({ githubClient, githubRegistry, githubCredentialFingerprint = "", githubClientConfigured = true, home, env = process.env, platform = process.platform,
  corePort = Number(env.ADAPTER_PORT || 2026), log = () => {}, createM365, startGateway, configureClients, restoreClients,
  discoverM365 = requestM365Accounts, managedClaude, onClaudeReady, preserveClientConfiguration } = {}) {
  const options = { home, env, platform }, github = { ...createGithubProvider({ client: githubClient,
    profileId: () => { const value = typeof githubCredentialFingerprint === "function" ? githubCredentialFingerprint() : githubCredentialFingerprint;
      return value ? `codex:${value}` : "codex"; } }), registry: githubRegistry };
  let selection = readProviderSettings(options), m365 = null, gateway = null, pending = null, closed = false, serial = null;
  let reason = null, claudeReason = null, lastClients = {};
  let changingAccount = false;
  const clientLifecycle = createClaudeClientLifecycle({ options, configureClients, restoreClients });
  const claudePerformance = createStreamPerformanceMetrics({ routeNames: ["messages"] });
  const sources = new Map([[github.id, github]]);
  const dashboardProfiles = new Map();
  const dashboardGeneration = provider => {
    const profile = provider.profileId(), previous = dashboardProfiles.get(provider.id);
    if (!previous || previous.profile !== profile) dashboardProfiles.set(provider.id, { profile, generation: (previous?.generation || 0) + 1 });
    return dashboardProfiles.get(provider.id).generation;
  };
  const sessions = new Map();let priorNamespace = null, requestOrder = 0, activeM365Requests = 0;
  let enabled;
  try { enabled = readM365Settings(options).enabled && readAccessSettings(options).providers.m365 && env.CCDX_M365 !== "0"; }
  catch { enabled = false;reason = "m365_config_invalid"; }

  async function syncClaudeClients() {
    if (preserveClientConfiguration?.()) return;
    if (managedClaude?.()) { await onClaudeReady?.();return; }
    const source = m365, profile = source?.profileId();
    if (!source || !gateway || closed || !enabled) return;
    await clientLifecycle.sync({ source, baseUrl: `http://127.0.0.1:${corePort}/anthropic`, apiKey: () => ensureM365GatewayKey(options),
      current: () => !closed && enabled && source === m365 && source.profileId() === profile && Boolean(gateway) });
    claudeReason = clientLifecycle.snapshot().reason || (source.models("claude").length ? null : "m365_no_claude_models");
  }

  async function startM365(forceRefresh = false) {
    if (closed || !enabled || !["darwin", "win32"].includes(platform)) return null;
    if (pending) return pending;
    if (!forceRefresh && m365?.snapshot().state === "ready") return m365;
    const operation = (async () => {
      if (!m365) {
        const factory = createM365 || (await import("./providers/m365.mjs")).createM365Provider;
        if (closed || !enabled) return null;
        m365 = factory({ home, env, log, onCatalog() {
          // Reconcile after refresh, outside inference serialization and without a watcher.
          setImmediate(() => { if (!pending && gateway && !closed && enabled) void syncClaudeClients(); });
        } });
        sources.set(m365.id, m365);
      }
      await m365.refresh();if (closed || !enabled) return null;
      const claudeModels = m365.models("claude");
      claudeReason = !claudeModels.length ? "m365_no_claude_models" : null;
      if (claudeModels.length && !claudeReason) try {
        const apiKey = ensureM365GatewayKey({ ...options, create: !preserveClientConfiguration?.() });
        if (!gateway) {
          const start = startGateway || (await import("./claude-gateway.mjs")).createClaudeGateway;
          const opened = await start({ provider: m365, apiKey, port: corePort, env, log, performance: claudePerformance,
            onRequest({ client }) { lastClients[client] = new Date().toISOString(); } });
          if (closed || !enabled) { await opened.close();return null; }
          gateway = opened;
        }
        await syncClaudeClients();
      } catch (error) {
        claudeReason = error.code === "EADDRINUSE" ? "m365_gateway_port_busy" : "m365_claude_setup_unavailable";
        log("warn", `Claude setup unavailable: ${claudeReason}; M365 GPT routing is independent`);
      }
      reason = null;log("ok", `Microsoft 365 ready: ${claudeModels.length} Claude, ${m365.models("gpt").length} GPT models${gateway ? `; Claude at http://127.0.0.1:${corePort}/anthropic` : ""}`);
      return m365;
    })().catch(error => {
      reason = /^m365_[a-z0-9_]+$/.test(error.code || "") ? error.code : error.code === "EADDRINUSE" ? "m365_gateway_port_busy" : "m365_unavailable";
      log("info", m365NetworkMessage(m365?.snapshot().network_diagnostic) || m365AccountMessage(reason));return null;
    }).finally(() => { if (pending === operation) pending = null; });
    pending = operation;return operation;
  }

  const snapshot = () => ({ codex_provider: selection.codex,
    github: { state: "configured", profile: "codex", preference: autoReviewPreference(options) },
    m365: { ...(m365?.snapshot() || {}), enabled, state: !enabled ? "disabled" : pending ? "checking"
      : !["darwin", "win32"].includes(platform) ? "unsupported" : m365?.snapshot().state || (reason ? "unavailable" : "idle"),
      reason: reason || m365?.snapshot().reason || null,
      account_change_in_flight: changingAccount,
      preference: selection.m365 || null,
      active_requests: activeM365Requests,
      claude: { gateway: gateway ? "running" : "unavailable", reason: claudeReason, port: gateway ? corePort : null,
        base_url: gateway ? `http://127.0.0.1:${corePort}/anthropic` : null, clients: clientLifecycle.snapshot().clients,
        observed_clients: { ...lastClients }, requests: gateway?.snapshot?.() || null } } });

  function current() {
    if (selection.codex === "m365" && changingAccount) throw Object.assign(new Error(m365AccountMessage("m365_account_busy")), { code: "m365_account_busy", statusCode: 409 });
    const source = sources.get(selection.codex);
    if (!source || selection.codex === "m365" && (!enabled || source.snapshot().state === "disabled")) throw unavailable(reason || "m365_not_ready");
    return source;
  }
  const serialize = task => {
    const next = (serial || Promise.resolve()).then(task);
    serial = next.catch(() => {});return next;
  };
  async function discoverAccounts() {
    if (!["darwin", "win32"].includes(platform)) throw unavailable("m365_platform_unsupported");
    const result = await discoverM365({ env });
    return { ...result, binding: readM365Account(options) };
  }
  async function selectAccount(id) {
    if (typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id)) throw Object.assign(new Error("Use an account ID from ccdx m365 accounts"), { statusCode: 400 });
    if (!enabled) throw unavailable("m365_disabled");
    if (activeM365Requests > 0 || gateway?.snapshot?.().active > 0 || pending) {
      throw Object.assign(new Error(m365AccountMessage("m365_account_busy")), { code: "m365_account_busy", statusCode: 409 });
    }
    changingAccount = true;
    let candidate, opened;
    try {
      const discovered = await discoverAccounts();
      const chosen = discovered.accounts.find(value => accountChoiceId(value) === id);
      if (!chosen) throw Object.assign(new Error("Account list changed. Check again and select an available account."), { code: "m365_account_selection_stale", statusCode: 409 });
      const switched = discovered.binding && m365AccountKey(discovered.binding) !== m365AccountKey(chosen);
      const factory = createM365 || (await import("./providers/m365.mjs")).createM365Provider;
      candidate = factory({ home, env, log, persist: false,
        account: { ...chosen, selection_source: "manual", ...(switched || discovered.binding?.history_isolation ? { history_isolation: true } : {}) },
        onCatalog() { if (candidate === m365 && !closed) setImmediate(() => { if (candidate === m365 && !closed) void syncClaudeClients(); }); } });
      await candidate.refresh();
      if (closed) throw unavailable("m365_runtime_closed");
      if (candidate.models("claude").length) {
        const start = startGateway || (await import("./claude-gateway.mjs")).createClaudeGateway;
          opened = await start({ provider: candidate, apiKey: ensureM365GatewayKey(options), port: corePort, env, log, performance: claudePerformance,
          onRequest({ client }) { lastClients[client] = new Date().toISOString(); } });
      }
      candidate.commitSelection(discovered.binding);
      const previous = m365, previousGateway = gateway;
      m365 = candidate;gateway = opened || null;sources.set("m365", m365);reason = null;
      candidate = null;opened = null;
      try { await previousGateway?.close();previous?.close(); }
      catch { log("warn", "Previous Microsoft 365 connection cleanup failed; the selected account is active"); }
      claudeReason = gateway ? null : "m365_no_claude_models";
      await syncClaudeClients();
      changingAccount = false;
      return snapshot();
    } finally { await opened?.close();candidate?.close();changingAccount = false; }
  }
  async function switchSource(provider, preference) {
    if (!providerRegistry.get(provider)?.codex) throw new Error("Choose a listed Codex source");
    if (provider === "m365") {
      if (!enabled) throw unavailable("m365_disabled");
      const ready = await startM365();if (!ready) throw unavailable(reason || "m365_not_ready");
      const ids = new Set(m365.models("gpt").map(model => model.id));
      if (!preference || !ids.has(preference.model) || !ids.has(preference.auto_review_model)) {
        throw Object.assign(new Error("Choose available M365 GPT and auto-review models before switching"), { code: "m365_model_selection_required", statusCode: 400 });
      }
      const review = m365.models("gpt").find(model => model.id === preference.auto_review_model);
      const effort = preference.auto_review_effort === undefined ? "low" : preference.auto_review_effort;
      if (effort !== null && !autoReviewReasoningEfforts(review).includes(effort)) {
        throw Object.assign(new Error("Choose an M365 review model with the selected thinking level"), { code: "m365_review_effort_unavailable", statusCode: 400 });
      }
    }
    if (closed) throw unavailable("m365_runtime_closed");
    let previous;try { previous = current().profileId(); } catch {}
    const next = writeProviderSettings(provider, preference, options);
    if (selection.codex !== provider) priorNamespace = previous || null;
    selection = next;return snapshot();
  }
  async function disable(remove) {
    if (activeM365Requests > 0 || gateway?.snapshot?.().active > 0) {
      throw Object.assign(new Error("Microsoft 365 requests are active; finish them before disabling or removing its profile"), { code: "m365_profile_busy", statusCode: 409 });
    }
    await switchSource("github");
    updateM365Settings({ enabled: false }, options);enabled = false;
    await gateway?.close();gateway = null;m365?.close();
    await pending;sources.delete("m365");m365 = null;
    const result = await clientLifecycle.restore();
    if (remove) {
      if (result.remaining) throw Object.assign(new Error("User-modified Claude settings were preserved; M365 profile cleanup is incomplete"), { code: "m365_cleanup_preserved" });
      const paths = m365Paths(options);
      for (const file of [paths.account, paths.catalog, paths.gateway, paths.ownership, paths.conversations]) {
        try { if (!fs.lstatSync(file).isFile()) throw Error();fs.unlinkSync(file); }
        catch (error) { if (error.code !== "ENOENT") throw new Error("M365 cleanup preserved an unexpected file"); }
      }
    }
    return snapshot();
  }
  return {
    claudePerformance,
    source: id => sources.get(id),
    async pauseM365() {
      updateM365Settings({ enabled: false }, options);enabled = false;
      // Existing handlers retain their source until their request finishes.
      const previous = m365, oldGateway = gateway;m365 = null;gateway = null;sources.delete("m365");
      await pending;await oldGateway?.close();return previous;
    },
    removeM365SavedProfile() {
      if (activeM365Requests > 0) throw Object.assign(new Error("M365 requests are active; finish them before removing the account"), { code: "m365_profile_busy", statusCode: 409 });
      const paths = m365Paths(options);
      for (const file of [paths.account, paths.catalog, paths.gateway, paths.conversations]) {
        try { if (!fs.lstatSync(file).isFile()) throw Error();fs.unlinkSync(file); } catch (error) { if (error.code !== "ENOENT") throw new Error("M365 cleanup preserved an unexpected file"); }
      }
    },
    github, current, snapshot, start: startM365, refresh: () => startM365(true),
    handleClaude(req, res) {
      if (changingAccount) { res.writeHead(409, { "Content-Type": "application/json", "Cache-Control": "no-store" });res.end(JSON.stringify({ error: { code: "m365_account_busy", message: m365AccountMessage("m365_account_busy") } }));return; }
      if (!enabled || !gateway?.handle) {
        res.writeHead(503, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ type: "error", error: { type: "api_error", code: claudeReason || reason || "m365_claude_unavailable", message: "Claude is unavailable; check the model service settings." } }));return;
      }
      return gateway.handle(req, res);
    },
    selection: () => selection,
    dashboardProviders() {
      return providerDescriptors({ state: snapshot(), githubRuntime: githubClient.runtimeStatus?.() || {}, githubRegistry,
        githubClientConfigured, githubGeneration: dashboardGeneration(github), m365Generation: m365 ? dashboardGeneration(m365) : 0,
        claudeClients: clientLifecycle.snapshot().clients, claudeReason, gatewayRunning: Boolean(gateway), lastClients,
        definitions: providerRegistry.list() });
    },
    async dashboardCatalog({ provider = selection.codex } = {}) {
      if (provider === "github") return null;
      if (provider !== "m365") throw Object.assign(new Error("Unknown provider"), { statusCode: 400 });
      if (!enabled || !["darwin", "win32"].includes(platform)) throw unavailable(!enabled ? "m365_disabled" : "m365_unsupported");
      if (!m365) throw unavailable(reason || "m365_not_ready");
      const source = m365;
      await source.refresh();
      if (closed || !enabled || source !== m365 || changingAccount) throw unavailable("m365_refresh_cancelled");
      reason = null;
      const eligible = new Set([...source.models("gpt"), ...source.models("claude")]);
      return { source: "catalog", checkedAt: m365.snapshot().models.refreshed_at, upstreamHost: "Microsoft 365",
        advertised: m365.catalog().length, models: publicModelCatalog(m365.catalog(), {
          selectable: model => eligible.has(model),
          clients: model => !eligible.has(model) ? [] : model.publisher?.toLowerCase() === "anthropic" ? ["claude_code", "claude_app"] : ["codex"],
        }) };
    },
    track(target) {
      if (target.id !== "m365") return undefined;
      activeM365Requests++;let finished = false;
      return () => { if (!finished) { finished = true;activeM365Requests--; } };
    },
    historyContext(headers, target) {
      const namespace = target.profileId(), raw = headers.session_id || headers["session-id"];
      // Internal bounded correlation only; IDs are never exposed or persisted.
      const key = typeof raw === "string" && raw.length <= 512 ? raw : null;
      const previous = key && sessions.get(key)?.namespace || priorNamespace, order = ++requestOrder;
      return { historyNamespace: namespace, historyTransferNamespace: previous && previous !== namespace
          && !(previous.startsWith("m365:") && namespace.startsWith("m365:")) ? previous : undefined,
        onHistoryStored() {
          if (!key) return;
          const record = sessions.get(key);
          if (record?.order > order) return;
          if (record) { record.namespace = namespace;record.order = order; }
          sessions.delete(key);sessions.set(key, record || { namespace, order });
          while (sessions.size > 1024) sessions.delete(sessions.keys().next().value);
        } };
    },
    async action(input) {
      return serialize(async () => {
        if (closed) throw unavailable("m365_runtime_closed");
        if (input.action === "accounts") {
          const result = await discoverAccounts();
          return { accounts: publicM365Accounts(result.accounts, result), state: snapshot() };
        }
        if (input.action === "account") return selectAccount(input.account_id);
        if (input.action === "models") { await startM365();return { state: snapshot(), models: m365?.models(input.family === "claude" ? "claude" : "gpt") || [] }; }
        if (input.action === "auto-review") {
          if (input.provider && input.provider !== selection.codex) throw new Error("Save the source before changing review settings");
          if (selection.codex === "github") {
            if (String(env.CCDX_AUTO_REVIEW_MODEL || "").trim()) throw new Error("Review model is controlled by CCDX_AUTO_REVIEW_MODEL");
            const models = githubRegistry?.models?.data || [];
            const model = models.find(model => model.id === input.model);
            if (!responsesModelIdsFromCopilotModels(models).includes(input.model)
              || input.effort !== null && !autoReviewReasoningEfforts(model).includes(input.effort)) throw new Error("Choose an available review model and thinking level");
            const result = writeAutoReviewModel(input.model === DEFAULT_CODEX_AUTO_REVIEW_MODEL ? "" : input.model, { ...options, reasoningEffort: input.effort });
            return { changed: result.changed, ...snapshot() };
          }
          if (!m365) throw unavailable("m365_not_selected");
          const model = m365.models("gpt").find(model => model.id === input.model);
          if (!model || input.effort !== null && !autoReviewReasoningEfforts(model).includes(input.effort)) {
            throw Object.assign(new Error("The selected M365 review model or effort is not available"), { statusCode: 400, code: "m365_review_effort_unavailable" });
          }
          const preference = { ...selection.m365, auto_review_model: input.model, auto_review_effort: input.effort };
          const changed = JSON.stringify(preference) !== JSON.stringify(selection.m365);
          selection = writeProviderSettings("m365", preference, options);return { changed, ...snapshot() };
        }
        if (input.action === "switch") return switchSource(input.provider, { model: input.model, auto_review_model: input.auto_review_model ?? selection.m365?.auto_review_model, ...(input.auto_review_effort !== undefined ? { auto_review_effort: input.auto_review_effort } : selection.m365?.auto_review_effort !== undefined ? { auto_review_effort: selection.m365.auto_review_effort } : {}) });
        if (input.action === "off" || input.action === "remove") return disable(input.action === "remove");
        if (input.action === "on") {
          updateM365Settings({ enabled: true }, options);enabled = env.CCDX_M365 !== "0";
          await startM365(true);return snapshot();
        }
        throw new Error("Unknown M365 action");
      });
    },
    async close() { closed = true;enabled = false;await gateway?.close();gateway = null;m365?.close();await pending; },
  };
}
