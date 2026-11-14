import fs from "node:fs";
import {
  accessSettingsPath,
  readAccessSettings,
  updateAccessSettings,
  accessError,
  CLIENT_IDS,
} from "./access-settings.mjs";
import { createApiSecretStore } from "./api-secrets.mjs";
import { createApiCatalogRefresh } from "./api-catalog-refresh.mjs";
import { createSourceLifecycle } from "./source-lifecycle.mjs";
import { createConnectionClientSync } from "./connection-client-sync.mjs";
import { createConnectionView } from "./connection-view.mjs";
import { createConnectionManagement } from "./connection-management.mjs";
import { createConnectionRouting } from "./connection-routing.mjs";
import { createApiProvider } from "./providers/api.mjs";
import { createApiModelDisplayStore } from "./api-model-display.mjs";
import { createCodexMemoryModel } from "./codex-memory-model.mjs";
import { readClientGatewayKeys, gatewayClient } from "./client-gateway-keys.mjs";
import { createLocalPrivacy } from "./local-privacy.mjs";
import {
  configureClaudeClients,
  restoreClaudeClients,
  inspectClaudeDesktopPolicy,
} from "./claude-client-config.mjs";
import { configureCodexApi } from "./codex-api-config.mjs";
import { createRequestAdmission } from "./request-admission.mjs";
import { createConversationSourceGuard } from "./conversation-source-guard.mjs";
import { createMessagesHistoryTransfer } from "./messages-history-transfer.mjs";
import { compileClientModels } from "./client-model-plan.mjs";
import { currentRequestContext } from "./request-context.mjs";
import { inspectClaudeCapabilitySupport } from "./claude-capability-config.mjs";
import { inspectClaudeAppContract, watchClaudeAppContract } from "./claude-app-contract.mjs";
import { deploymentModelId, deploymentRevision } from "./model-capabilities.mjs";
import { m365Paths } from "./m365-settings.mjs";
import { createUpstreamErrorCapture } from "./upstream-error-capture.mjs";

export function createConnectionRuntime({
  legacy,
  home,
  env = process.env,
  platform = process.platform,
  corePort = 2026,
  secretStore,
  createApi = createApiProvider,
  configureClaude = configureClaudeClients,
  restoreClaude = restoreClaudeClients,
  configureCodex = configureCodexApi,
  inspectDesktop = inspectClaudeDesktopPolicy,
  inspectAppContract = inspectClaudeAppContract,
  clientAccessChanged,
  preserveClientConfiguration,
  clientVersionsSnapshot,
  now = Date.now,
  log = () => {},
} = {}) {
  const options = { home, env, platform, preserveClientConfiguration },
    secrets = secretStore || createApiSecretStore(options),
    modelDisplay = createApiModelDisplayStore(options);
  const guardConversation = createConversationSourceGuard(options),
    acquireClaudeRequest = createRequestAdmission({ maxBytes: 16 * 1024 * 1024, maxQueued: 8 });
  const messagesTransfer = createMessagesHistoryTransfer({
    ...options,
    onTransfer: () => log("info", "Conversation continued on the selected source; original history kept"),
  });
  const memoryModel = createCodexMemoryModel({ ...options, corePort });
  const privacy = createLocalPrivacy(options);
  const errorCapture = createUpstreamErrorCapture({ now });
  let settings = readAccessSettings(options),
    managed = fs.existsSync(accessSettingsPath(options)),
    serial = Promise.resolve(),
    keys,
    closed = false;
  const legacyClaudeAccess = fs.existsSync(m365Paths(options).ownership);
  const instances = new Map(),
    setup = {},
    credentialStates = {},
    lastClients = {};
  const plans = new Map(),
    discoveries = new Map();
  const lifecycle = createSourceLifecycle({ legacy, secrets, log }), { track, retire } = lifecycle;
  const catalogRefresh = createApiCatalogRefresh({
    config: id => settings.apis.find(api => api.id === id),
    source: getSource,
    track,
    complete: api => modelDisplay.has(api.id, deploymentRevision(api, env)),
    revision: api => deploymentRevision(api, env),
    now,
    commit: (...args) => enqueue(() => applyCatalog(...args)),
    onState: (id, state) => (state ? discoveries.set(id, state) : discoveries.delete(id)),
  });
  const capabilitySupport = inspectClaudeCapabilitySupport(options);
  let capabilityFlight = null, capabilityWatch = null;
  const refreshClientCapabilities = ({ sync = true } = {}) => {
    if(closed||!managed||!binding("claude_app").enabled||!plan("claude_app").models.length)return Promise.resolve(structuredClone(capabilitySupport));
    if (capabilityFlight) return capabilityFlight;
    capabilityFlight = inspectAppContract(options).then(async contract => {
      if(closed)return;
      const next=inspectClaudeCapabilitySupport({...options,appContract:contract});
      const changed=capabilitySupport.app_contract?.fingerprint!==contract.fingerprint||capabilitySupport.app_contract?.installation!==contract.installation||capabilitySupport.app_version!==next.app_version||capabilitySupport.app!==next.app;
      await enqueue(()=>{Object.assign(capabilitySupport,next);if(changed){plans.delete("claude_app");plans.delete("claude_code")}});
      if(changed&&sync&&managed)await clientSync.syncClients(["claude_app","claude_code"]);
      return structuredClone(capabilitySupport);
    }).finally(()=>{capabilityFlight=null});
    return capabilityFlight;
  };
  let operations = 0;
  const identities = () => (keys ||= readClientGatewayKeys(options));
  const enabled = id =>
    id?.startsWith("api_")
      ? settings.apis.find(api => api.id === id)?.enabled === true
      : settings.providers[id] === true;
  const binding = id =>
    managed
      ? settings.clients[id]
      : {
          ...settings.clients[id],
          allowed: settings.clients[id].allowed.filter(
            source =>
              source !== "m365" ||
              legacyClaudeAccess ||
              (id === "codex" && legacy.selection().codex === "m365")
          ),
          source:
            id === "codex"
              ? legacy.selection().codex
              : legacyClaudeAccess && legacy.snapshot().m365.enabled
                ? "m365"
                : null,
        };
  // GitHub-only selections retain the existing native loopback access contract.
  // Any other deployment still requires the private per-client credential.
  function codexAccessMode() {
    const client = binding("codex");
    if (!client.enabled) return "disabled";
    if (Array.isArray(client.deployments)) {
      if (!client.deployments.length) return "paused";
      return client.deployments.every(item => item.source === "github") ? "native" : "gateway";
    }
    return !client.source ? "paused" : client.source === "github" ? "native" : "gateway";
  }
  const codexRequiresKey = () => codexAccessMode() === "gateway";
  function requireCodexKey(req) {
    if (gatewayClient(req.headers, identities()) === "codex") return;
    // An old native process may still send its ChatGPT bearer. A local access
    // denial must not trigger recovery/replacement of that unrelated sign-in.
    throw accessError("ccdx_client_credential_required", req.headers?.authorization ? 403 : 401);
  }
  const permitted = (id, source) =>
    binding(id)?.enabled && binding(id).allowed.includes(source) && enabled(source);
  function getSource(id) {
    if (!id?.startsWith("api_")) return legacy.source(id);
    const config = settings.apis.find(value => value.id === id);
    if (!config) return null;
    const previous = instances.get(id),
      revision = deploymentRevision(config, env);
    if (previous?.config === config && previous.revision === revision) return previous.source;
    const signature = JSON.stringify(config) + revision;
    if (previous?.signature === signature) return previous.source;
    const source = createApi({
      config,
      secrets,
      env: { ...env },
      platform,
      modelDisplay: model => modelDisplay.get(id, revision, model),
      errorCapture,
    });
    instances.set(id, { signature, source, config, revision });
    lifecycle.rememberSource(source, config.secret_ref);
    if (previous) retire(previous.source);
    return source;
  }
  function plan(id) {
    const selected = binding(id),
      definitions = selected.allowed
        .filter(enabled)
        .map(source => getSource(source))
        .filter(Boolean);
    const cached = plans.get(id),
      stamps = definitions.map(source => [
        source,
        source.registry?.generation,
        source.registry?.models,
        source.profileId(),
      ]);
    if (
      cached?.binding === selected &&
      cached.stamps.length === stamps.length &&
      stamps.every((stamp, index) => stamp.every((value, at) => cached.stamps[index][at] === value))
    )
      return cached.value;
    const value = compileClientModels({
      client: id,
      binding: selected,
      source: getSource,
      enabled,
      names: Object.fromEntries([
        ["github", "GitHub Copilot"],
        ["m365", "Microsoft 365"],
        ...settings.apis.map(api => [api.id, api.name]),
      ]),
      desktopEffortAliases: capabilitySupport.app && capabilitySupport.app_aliases !== false,
    });
    plans.set(id, { binding: selected, stamps, value });
    return value;
  }
  function resolveDeployment(id, model) {
    const value = plan(id),
      record = value.routes.get(model);
    if (!record) {
      const selected = binding(id),
        configured = selected.deployments || [{ source: selected.source, model: selected.model }];
      const matches = configured.filter(
        item => item.model === model || deploymentModelId(item.source, item.model) === model
      );
      const reason = !selected.enabled
        ? "ccdx_client_source_disabled"
        : matches.length > 1
          ? "ccdx_model_ambiguous"
          : matches.length && !permitted(id, matches[0].source)
            ? "ccdx_client_source_disabled"
            : matches.length
              ? "ccdx_model_catalog_unavailable"
              : "ccdx_model_not_selected";
      const error = accessError("ccdx_api_model_unavailable");
      error.jsonBody.error.reason = reason;
      currentRequestContext()?.onHttpError?.({ code: error.code, origin: "client_validation", reason });
      throw error;
    }
    const provider = requireSource(id, record.source);
    if (provider !== record.provider) {
      plans.delete(id);
      return resolveDeployment(id, model);
    }
    return record;
  }
  function editable() {
    if (managed) return structuredClone(settings);
    const next = structuredClone(settings);
    next.providers.m365 = legacy.snapshot().m365.enabled === true;
    for (const id of CLIENT_IDS) next.clients[id] = { ...binding(id) };
    return next;
  }
  function save(next) {
    plans.clear();
    settings = structuredClone(
      updateAccessSettings(current => {
        if (JSON.stringify(current) !== JSON.stringify(settings))
          throw accessError("ccdx_connections_conflict", 409);
        return next;
      }, options)
    );
    managed = true;
    catalogRefresh.invalidate();
    for (const [id, item] of instances) {
      const current = settings.apis.find(api => api.id === id);
      if (
        !current?.enabled ||
        JSON.stringify(current) + deploymentRevision(current, env) !== item.signature
      ) {
        instances.delete(id);
        retire(item.source);
      } else item.config = current;
    }
  }

  const clientSync = createConnectionClientSync({ options, corePort, configureCodex, configureClaude, restoreClaude, inspectDesktop,
    binding, plan, permitted, getSource, identities, codexAccessMode, capabilitySupport, clientVersionsSnapshot, setup, credentialStates,
    isManaged: () => managed, isClosed: () => closed, getSettings: () => settings });
  const { syncClients, capabilitySupportForSync } = clientSync;
  const view = createConnectionView({ legacy, env, binding, plan, getSource, enabled, editable, modelDisplay, discoveries,
    setup, credentialStates, lastClients, memoryModel, capabilitySupport, sharedSync: () => clientSync.shared(),
    isManaged: () => managed, getSettings: () => settings, corePort, permitted });
  const { imageModels, snapshot, sourceImpact, clientRevision, catalogVisibility } = view;
  const management = createConnectionManagement({
    binding, catalogRefresh, save, discoveries, getSettings: () => settings, env, imageModels, enabled, getSource, legacy,
    capabilitySupport, capabilitySupportForSync, plan, snapshot, options, permitted, sourceImpact, isManaged: () => managed, isClosed: () => closed,
    clientRevision, editable, syncClients, clientAccessChanged, setup, secrets, lifecycle, retire, memoryModel, enqueue, catalogVisibility });
  const { requireSource, methods: routing } = createConnectionRouting({ legacy, legacyClaudeAccess, isManaged: () => managed,
    getSettings: () => settings, binding, plan, permitted, getSource, resolveDeployment, codexAccessMode, codexRequiresKey, requireCodexKey,
    identities, track, guardConversation, messagesTransfer, acquireClaudeRequest, privacy, env, log, lastClients, capabilitySupport });


  async function applyCatalog(id, models, revision, checkedAt, active) {
    if (!active()) throw accessError("ccdx_connections_conflict", 409);
    const next = editable(),
      current = next.apis.find(api => api.id === id);
    if (!current?.enabled || deploymentRevision(current, env) !== revision)
      throw accessError("ccdx_connections_conflict", 409);
    const byId = new Map(models.map(model => [model.id, model]));
    let displayChanged = false;
    try {
      displayChanged = modelDisplay.set(id, revision, models);
    } catch {
      log("warn", "Model display metadata could not be saved; routing is unchanged");
    }
    for (const model of current.models)
      if (byId.get(model.id)?.metadata) model.metadata = byId.get(model.id).metadata;
    current.checked_at = checkedAt;
    const changed = JSON.stringify(current) !== JSON.stringify(settings.apis.find(api => api.id === id));
    if (changed) save(next);
    if (changed || displayChanged) {
      plans.clear();
      await syncClients(
        CLIENT_IDS.filter(
          client =>
            binding(client).source === id || binding(client).deployments?.some(model => model.source === id)
        )
      );
    }
  }
  function enqueue(work) {
    operations++;
    const job = serial.then(work).finally(() => {
      operations--;
    });
    serial = job.catch(() => {});
    return job;
  }
  const refreshApis = () =>
    !closed && managed && !preserveClientConfiguration?.()
      ? catalogRefresh.refreshAll(settings.apis.filter(api => api.enabled).map(api => api.id))
      : Promise.resolve();


  return {
    ...legacy,
    managesClaude() {
      return !managed
        ? !legacyClaudeAccess
        : settings.claude_private_keys ||
            !["claude_app", "claude_code"].every(
              id =>
                binding(id).enabled && binding(id).source === "m365" && binding(id).allowed.includes("m365")
            );
    },
    syncSourceClients(source) {
      return syncClients(
        CLIENT_IDS.filter(
          id => binding(id).source === source || binding(id).deployments?.some(item => item.source === source)
        )
      );
    },
    source: getSource,
    connections: snapshot,
    errorCaptureSnapshot: () => errorCapture.snapshot(),
    captureUpstreamError({ operation, source, model }) {
      if (operation === "cancel") return errorCapture.cancel();
      const config = settings.apis.find(api => api.id === source && api.enabled);
      if (operation !== "arm" || !config?.models.some(entry => entry.id === model && entry.protocols.includes("messages")))
        throw accessError("ccdx_connections_action_invalid");
      return errorCapture.arm(source, model);
    },
    privateScopes: id =>
      [...new Set(plan(id).models.map(model => model.source_id))]
        .sort()
        .map(source => [source, getSource(source).profileId(id === "codex" ? "responses" : "messages")]),
    validateLocalKeys() {
      if (
        managed &&
        CLIENT_IDS.some(
          id =>
            binding(id).enabled &&
            plan(id).models.some(
              model => model.source_id.startsWith("api_") || (id !== "codex" && settings.claude_private_keys)
            )
        )
      )
        keys = readClientGatewayKeys({ ...options, create: false });
    },
    exportPrivateState: () => {
      const credentials =
        secrets.exportState?.(
          settings.apis.filter(api => api.enabled && api.secret_ref).map(api => api.secret_ref)
        ) || [];
      return {
        credentials,
        bytes: credentials.reduce((sum, [ref, key]) => sum + 2 * Buffer.byteLength(ref + key) + 64, 0),
      };
    },
    importPrivateState: state =>
      secrets.importState?.(
        state?.credentials || [],
        settings.apis.filter(api => api.enabled && api.secret_ref).map(api => api.secret_ref)
      ),
    privacy,
    busy: () => privacy.busy() ||
      Boolean(capabilityFlight) ||
      operations > 0 ||
      lifecycle.busy() ||
      clientSync.busy() ||
      catalogRefresh.busy() ||
      legacy.snapshot().m365.account_change_in_flight === true ||
      legacy.snapshot().m365.state === "checking",
    syncClients,
    refreshClientCapabilities,
    manageConnections: management.manageConnections,
    imageModels,
    async start() {
      const capabilities = refreshClientCapabilities({sync:false});
      capabilityWatch ||= watchClaudeAppContract({ ...options, onChange: refreshClientCapabilities });
      if (binding("codex").enabled) void memoryModel.refresh();
      const old = legacy.start();
      await capabilities;
      if (managed) await syncClients();
      const result = await old;
      if (managed) await syncClients();
      void refreshApis();
      return result;
    },
    async refresh() {
      await refreshClientCapabilities();
      const result = await Promise.allSettled([
        !managed || settings.providers.m365 ? legacy.refresh() : Promise.resolve(),
        refreshApis(),
      ]);
      if (result[0].status === "rejected") throw result[0].reason;
    },
    selection() {
      return { ...legacy.selection(), codex: binding("codex").enabled ? binding("codex").source : null };
    },
    providerPreference(id) {
      const c = settings.clients.codex;
      return managed && c.source === id && c.auto_review_model
        ? {
            ...c,
            auto_review_model:
              plan("codex").routes.get(c.auto_review_model)?.upstreamModel || c.auto_review_model,
          }
        : legacy.selection().m365;
    },
    snapshot: view.methods.snapshot,
    ...routing,
    dashboardProviders: view.methods.dashboardProviders,
    dashboardCatalog: view.methods.dashboardCatalog,
    action: management.action,
    async close() {
      closed = true;
      capabilityWatch?.close();
      await capabilityFlight;
      privacy.close();
      await memoryModel.close();
      await catalogRefresh.close();
      await serial;
      await clientSync.pending();
      for (const { source } of instances.values()) source.close();
      await lifecycle.close();
      secrets.close();
      await legacy.close();
    },
  };
}
