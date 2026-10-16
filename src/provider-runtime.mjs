import fs from "node:fs";
import { createGithubProvider } from "./providers/github.mjs";
import { readProviderSettings, writeProviderSettings } from "./provider-settings.mjs";
import { readM365Settings, updateM365Settings, m365Paths, ensureM365GatewayKey } from "./m365-settings.mjs";

const unavailable = reason => Object.assign(new Error(`Microsoft 365 is unavailable (${reason}); GitHub routing was not substituted`),
  { code: reason, statusCode: 503 });

// Composition owns source selection. Providers never modify Codex, prediction,
// image configuration or each other's credentials.
export function createProviderRuntime({ githubClient, githubRegistry, githubCredentialFingerprint = "", home, env = process.env, platform = process.platform,
  log = () => {}, createM365, startGateway, configureClients, restoreClients } = {}) {
  const options = { home, env, platform }, github = { ...createGithubProvider({ client: githubClient,
    profileId: () => { const value = typeof githubCredentialFingerprint === "function" ? githubCredentialFingerprint() : githubCredentialFingerprint;
      return value ? `codex:${value}` : "codex"; } }), registry: githubRegistry };
  let selection = readProviderSettings(options), m365 = null, gateway = null, pending = null, closed = false, serial = null;
  let reason = null, claudeReason = null, clients = { code: "not_configured", app: "not_configured" }, lastClients = {};
  const sessions = new Map();let priorNamespace = null, requestOrder = 0, activeM365Requests = 0;
  let enabled;
  try { enabled = readM365Settings(options).enabled && env.CCDX_M365 !== "0"; }
  catch { enabled = false;reason = "m365_config_invalid"; }

  async function startM365(forceRefresh = false) {
    if (closed || !enabled || !["darwin", "win32"].includes(platform)) return null;
    if (pending) return pending;
    if (!forceRefresh && m365?.snapshot().state === "ready") return m365;
    const operation = (async () => {
      if (!m365) {
        const factory = createM365 || (await import("./providers/m365.mjs")).createM365Provider;
        if (closed || !enabled) return null;
        m365 = factory({ home, env, log });
      }
      await m365.refresh();if (closed || !enabled) return null;
      const claudeModels = m365.models("claude");
      claudeReason = claudeModels.length ? null : "m365_no_claude_models";
      if (claudeModels.length) try {
        const apiKey = ensureM365GatewayKey(options);
        if (!gateway) {
          const start = startGateway || (await import("./claude-gateway.mjs")).startClaudeGateway;
          const opened = await start({ provider: m365, apiKey, env, log,
            onRequest({ client }) { lastClients[client] = new Date().toISOString(); } });
          if (closed || !enabled) { await opened.close();return null; }
          gateway = opened;
        }
        try {
          const integration = configureClients ? null : await import("./claude-client-config.mjs");
          const configure = configureClients || integration.configureClaudeClients;
          const desktopManaged = integration ? await integration.inspectClaudeDesktopPolicy(options) : false;
          if (closed || !enabled) return null;
          clients = configure({ ...options, desktopManaged, baseUrl: `http://127.0.0.1:${gateway.port}`, apiKey, models: claudeModels });
        } catch { clients = { code: "configuration_unavailable", app: "configuration_unavailable" };claudeReason = "m365_claude_config_unavailable"; }
      } catch (error) {
        claudeReason = error.code === "EADDRINUSE" ? "m365_gateway_port_busy" : "m365_claude_setup_unavailable";
        log("warn", `Claude setup unavailable: ${claudeReason}; M365 GPT routing is independent`);
      }
      reason = null;log("ok", `Microsoft 365 ready: ${claudeModels.length} Claude, ${m365.models("gpt").length} GPT models${gateway ? `; Claude gateway at http://127.0.0.1:${gateway.port}` : ""}`);
      return m365;
    })().catch(error => {
      reason = /^m365_[a-z0-9_]+$/.test(error.code || "") ? error.code : error.code === "EADDRINUSE" ? "m365_gateway_port_busy" : "m365_unavailable";
      log("info", `Microsoft 365 unavailable: ${reason}`);return null;
    }).finally(() => { if (pending === operation) pending = null; });
    pending = operation;return operation;
  }

  const snapshot = () => ({ codex_provider: selection.codex,
    github: { state: "configured", profile: "codex" },
    m365: { ...(m365?.snapshot() || {}), enabled, state: !enabled ? "disabled" : pending ? "checking"
      : !["darwin", "win32"].includes(platform) ? "unsupported" : m365?.snapshot().state || (reason ? "unavailable" : "idle"),
      reason: reason || m365?.snapshot().reason || null,
      preference: selection.m365 || null,
      active_requests: activeM365Requests,
      claude: { gateway: gateway ? "running" : "unavailable", reason: claudeReason, port: gateway?.port || null, clients: { ...clients },
        observed_clients: { ...lastClients }, requests: gateway?.snapshot?.() || null } } });

  function current() {
    if (selection.codex === "github") return github;
    if (!m365 || !enabled || m365.snapshot().state === "disabled") throw unavailable(reason || "m365_not_ready");
    return m365;
  }
  const serialize = task => {
    const next = (serial || Promise.resolve()).then(task);
    serial = next.catch(() => {});return next;
  };
  async function switchSource(provider, preference) {
    if (!["github", "m365"].includes(provider)) throw new Error("Provider must be github or m365");
    if (provider === "m365") {
      if (!enabled) throw unavailable("m365_disabled");
      const ready = await startM365();if (!ready) throw unavailable(reason || "m365_not_ready");
      const ids = new Set(m365.models("gpt").map(model => model.id));
      if (!preference || !ids.has(preference.model) || !ids.has(preference.auto_review_model)) {
        throw Object.assign(new Error("Choose available M365 GPT and auto-review models before switching"), { code: "m365_model_selection_required", statusCode: 400 });
      }
      if (!m365.models("gpt").find(model => model.id === preference.auto_review_model)?.capabilities?.supports?.reasoning_effort?.includes("low")) {
        throw Object.assign(new Error("Choose an M365 Auto-review model that advertises low reasoning"), { code: "m365_review_effort_unavailable", statusCode: 400 });
      }
    }
    if (closed) throw unavailable("m365_runtime_closed");
    let previous;try { previous = current().profileId(); } catch {}
    const next = writeProviderSettings(provider, preference, options);
    if (selection.codex !== provider) priorNamespace = previous || null;
    selection = next;return snapshot();
  }
  async function disable(remove) {
    if (remove && (activeM365Requests > 0 || gateway?.snapshot?.().active > 0)) {
      throw Object.assign(new Error("Microsoft 365 requests are active; finish them before removing its profile"), { code: "m365_profile_busy", statusCode: 409 });
    }
    await switchSource("github");
    updateM365Settings({ enabled: false }, options);enabled = false;
    m365?.close();await gateway?.close();gateway = null;
    await pending;m365 = null;
    const restore = restoreClients || (await import("./claude-client-config.mjs")).restoreClaudeClients;
    const result = restore(options);clients = { code: result.preserved ? "preserved" : "restored", app: result.preserved ? "preserved" : "restored" };
    if (remove) {
      if (result.remaining) throw Object.assign(new Error("User-modified Claude settings were preserved; M365 profile cleanup is incomplete"), { code: "m365_cleanup_preserved" });
      const paths = m365Paths(options);
      for (const file of [paths.account, paths.catalog, paths.gateway, paths.ownership]) {
        try { if (!fs.lstatSync(file).isFile()) throw Error();fs.unlinkSync(file); }
        catch (error) { if (error.code !== "ENOENT") throw new Error("M365 cleanup preserved an unexpected file"); }
      }
    }
    return snapshot();
  }
  return {
    github, current, snapshot, start: startM365, refresh: () => startM365(true),
    selection: () => selection,
    dashboardCatalog() {
      if (selection.codex !== "m365") return null;
      const models = [...(m365?.models("gpt") || []), ...(m365?.models("claude") || [])];
      return { source: "catalog", checkedAt: m365?.snapshot().models.refreshed_at || null,
        upstreamHost: "Microsoft 365", advertised: models.length,
        models: models.map(model => ({ id: model.id, vendor: model.publisher,
          endpoints: model.supported_endpoints.includes("/v1/messages") ? ["messages"] : ["responses"], preview: false })) };
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
      return { historyNamespace: namespace, historyTransferNamespace: previous && previous !== namespace ? previous : undefined,
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
        if (input.action === "models") { await startM365();return { state: snapshot(), models: m365?.models(input.family === "claude" ? "claude" : "gpt") || [] }; }
        if (input.action === "auto-review") {
          if (selection.codex !== "m365" || !m365) throw unavailable("m365_not_selected");
          const model = m365.models("gpt").find(model => model.id === input.model);
          if (!model || input.effort !== null && !model.capabilities?.supports?.reasoning_effort?.includes(input.effort)) {
            throw Object.assign(new Error("The selected M365 review model or effort is not available"), { statusCode: 400, code: "m365_review_effort_unavailable" });
          }
          const preference = { ...selection.m365, auto_review_model: input.model, auto_review_effort: input.effort };
          const changed = JSON.stringify(preference) !== JSON.stringify(selection.m365);
          selection = writeProviderSettings("m365", preference, options);return { changed, ...snapshot() };
        }
        if (input.action === "switch") return switchSource(input.provider, { model: input.model, auto_review_model: input.auto_review_model });
        if (input.action === "off" || input.action === "remove") return disable(input.action === "remove");
        if (input.action === "on") {
          updateM365Settings({ enabled: true }, options);enabled = env.CCDX_M365 !== "0";
          await startM365(true);return snapshot();
        }
        throw new Error("Unknown M365 action");
      });
    },
    async close() { closed = true;enabled = false;m365?.close();await gateway?.close();gateway = null;await pending; },
  };
}
