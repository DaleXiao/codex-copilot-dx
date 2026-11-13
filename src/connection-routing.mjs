import { accessError } from "./access-settings.mjs";
import { gatewayClient } from "./client-gateway-keys.mjs";
import { createClaudeGatewayHandler } from "./claude-gateway.mjs";
import { codexClientCatalog, codexSourceCatalog } from "./clients/codex-models.mjs";
import { currentRequestContext } from "./request-context.mjs";

export function createConnectionRouting({ legacy, legacyClaudeAccess, isManaged, getSettings, binding, plan, permitted, getSource,
  resolveDeployment, codexAccessMode, codexRequiresKey, requireCodexKey, identities, track, guardConversation, messagesTransfer,
  acquireClaudeRequest, privacy, env, log, lastClients, capabilitySupport }) {
  const handlers = new Map();
  function requireSource(clientId, id) {
    if (!permitted(clientId, id)) throw accessError("ccdx_client_source_disabled", 503);
    if (id === "m365" && legacy.snapshot().m365.account_change_in_flight)
      throw accessError("m365_account_busy", 409);
    const source = getSource(id);
    if (!source) throw accessError("ccdx_api_not_ready", 503);
    return source;
  }
  function validateConversation(body, headers, source, signal, client = "codex") {
    if (!body || typeof body !== "object" || Array.isArray(body)) return;
    if (
      isManaged() &&
      (binding(client).history_isolation || source?.id.startsWith("api_") || client === "claude_app")
    ) {
      const transfer =
        client === "claude_app"
          ? {
              profiles: [...new Set(plan(client).models.map(model => model.source_id))].map(id =>
                getSource(id).profileId("messages")
              ),
              prepare: input =>
                messagesTransfer.prepare({
                  ...input,
                  countTokens: currentRequestContext()?.route === "messages_count_tokens",
                }),
            }
          : undefined;
      return guardConversation(
        client,
        source.profileId(client === "codex" ? "responses" : "messages"),
        body,
        headers,
        identities()[client],
        transfer,
        signal
      );
    }
  }
  return { requireSource, methods: {
    current(req) {
      if (!isManaged()) return legacy.current();
      const mode = codexAccessMode();
      if (mode === "paused" || mode === "disabled") throw accessError("ccdx_client_source_disabled", 503);
      const c = binding("codex"),
        compiled = plan("codex");
      if (Array.isArray(c.deployments) && req?.method === "GET") {
        if (codexRequiresKey()) requireCodexKey(req);
        return {
          id: "connections",
          registry: { models: { data: compiled.models.map(model => ({ ...model, id: model.public_id })) } },
          client: {
            listModels: async () => ({
              status: 200,
              body: JSON.stringify({
                data: compiled.models.map(model => ({ ...model, id: model.public_id })),
              }),
            }),
          },
          codexCatalog: codexClientCatalog(compiled, () => getSource("github")?.registry?.models),
        };
      }
      if (Array.isArray(c.deployments) && compiled.defaultUnavailable) {
        if (req && codexRequiresKey()) requireCodexKey(req);
        // Admission uses the common handler; resolveCodex must resolve the
        // explicitly requested model before any provider request is opened.
        return null;
      }
      const source = requireSource(
        "codex",
        Array.isArray(c.deployments) ? compiled.routes.get(compiled.defaultModel)?.source : c.source
      );
      if (source?.id.startsWith("api_") && req) requireCodexKey(req);
      return req?.method === "GET" && source?.configuredModels && source.id.startsWith("api_")
        ? { ...source, codexCatalog: codexSourceCatalog(source) }
        : source;
    },
    hasModelBindings(client = "codex") {
      return isManaged() && Array.isArray(binding(client).deployments);
    },
    resolveCodex(body, req) {
      if (!isManaged()) return null;
      const mode = codexAccessMode();
      if (mode === "paused" || mode === "disabled") throw accessError("ccdx_client_source_disabled", 503);
      if (!Array.isArray(binding("codex").deployments)) return null;
      if (codexRequiresKey()) requireCodexKey(req);
      const requested =
        body.model === "codex-auto-review"
          ? binding("codex").auto_review_model || plan("codex").defaultModel
          : body.model;
      if (body.model === "codex-auto-review") {
        delete body.service_tier;
        if (binding("codex").auto_review_effort)
          body.reasoning = { ...body.reasoning, effort: binding("codex").auto_review_effort };
      }
      const record = resolveDeployment("codex", requested),
        context = currentRequestContext();
      if (context) {
        context.finishProvider?.();
        context.finishProvider = track(record.provider);
        context.provider = record.provider.id;
        context.streamPerformance?.setProvider?.(record.provider.id);
        Object.assign(context, this.historyContext(req.headers, record.provider));
      }
      body.model = record.upstreamModel;
      return record.provider;
    },
    track,
    validateConversation,
    historyContext(headers, target) {
      if (target.id === "connections") return {};
      if (!target.id.startsWith("api_")) return legacy.historyContext(headers, target);
      // Opaque Responses state never transfers to another API/key/configuration.
      return { historyNamespace: target.profileId() };
    },
    async handleClaude(req, res) {
      if (!isManaged()) {
        if (!legacyClaudeAccess) throw accessError("ccdx_client_source_disabled", 503);
        return legacy.handleClaude(req, res);
      }
      if (!getSettings().claude_private_keys) {
        if (["claude_app", "claude_code"].every(id => permitted(id, "m365") && binding(id).source === "m365"))
          return legacy.handleClaude(req, res);
        throw accessError("ccdx_client_source_disabled", 503);
      }
      const id = gatewayClient(req.headers, identities());
      if (!id || id === "codex") throw accessError("ccdx_client_credential_required", 401);
      const compiled = plan(id);
      if (!binding(id).enabled || !compiled.models.length)
        throw accessError("ccdx_client_source_disabled", 503);
      // A request resolves once after its bounded body read. Its source and
      // capability snapshot stay pinned while catalogs/configuration change.
      const catalog = { id: "connections", configuredModels: true, models: () => compiled.models };
      let cached = handlers.get(id);
      if (cached?.compiled !== compiled) {
        const handler = createClaudeGatewayHandler({
          provider: catalog,
          acquireRequest: acquireClaudeRequest,
          apiKey: identities()[id],
          privacy,
          privacyClient: id,
          env,
          log,
          performance: legacy.claudePerformance,
          desktopAliases: id === "claude_app",
          appContract: id === "claude_app" ? capabilitySupport?.app_contract : undefined,
          messagesSystemMode: id === "claude_app" ? "legacy" : "passthrough",
          resolveRequest(body) {
            const record = resolveDeployment(id, body.model),
              finish = track(record.provider);
            return {
              provider: record.provider,
              model: record.upstreamModel,
              capability: record.model.capability,
              finish,
            };
          },
          validateConversation: (body, headers, source, signal) => validateConversation(body, headers, source, signal, id),
          onRequest() {
            lastClients[id] = new Date().toISOString();
          },
        });
        cached = { compiled, handler };
        handlers.set(id, cached);
      }
      const headers = req.headers;
      req.headers = { ...headers, "x-ccdx-client": id === "claude_app" ? "claude-app" : "claude-code" };
      try {
        return await cached.handler(req, res);
      } finally {
        req.headers = headers;
      }
    },
  } };
}
