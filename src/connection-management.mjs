import { prepareSourceAccess, accessError, CLIENT_IDS } from "./access-settings.mjs";
import { publicModelCatalog } from "./provider-metadata.mjs";
import { createConnectionPolicy } from "./connection-policy.mjs";

const validObject = (value, keys) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).every(key => keys.includes(key));
export function createConnectionManagement({ binding, catalogRefresh, save, discoveries, getSettings, env,
  imageModels, enabled, getSource, legacy, capabilitySupport, capabilitySupportForSync, plan, snapshot, options, permitted, sourceImpact,
  isManaged, isClosed, clientRevision, editable, syncClients, clientAccessChanged, setup, secrets, lifecycle, retire, memoryModel, enqueue, catalogVisibility }) {
  const { removeApi, prepareApiSave, applyClientSelection, applyProviderEnabled } = createConnectionPolicy({
    validObject, binding, catalogRefresh, save, discoveries, getSettings, env, imageModels, enabled, getSource, legacy,
    capabilitySupport, capabilitySupportForSync, plan, snapshot, options, permitted, sourceImpact });

  async function change(input) {
    if (isClosed()) throw accessError("ccdx_connections_closed", 503);
    if (
      !validObject(input, [
        "operation",
        "id",
        "config",
        "key",
        "allowed",
        "source",
        "enabled",
        "replacements",
        "impact_revision",
        "model",
        "auto_review_model",
        "auto_review_effort",
        "deployments",
        "default_model",
        "auto_sync",
        "image_model",
        "client_revision",
      ])
    )
      throw accessError("ccdx_connections_action_invalid");
    if (
      ["client", "preview_client", "sync_client", "client_state", "image_model"].includes(input.operation) &&
      input.client_revision !== undefined &&
      (!CLIENT_IDS.includes(input.id) || input.client_revision !== clientRevision(input.id))
    )
      throw accessError("ccdx_connections_conflict", 409);
    if (
      !["client", "preview_client", "sync_client", "client_state", "image_model"].includes(input.operation) &&
      input.impact_revision !== undefined &&
      input.impact_revision !== sourceImpact(input.id).revision
    )
      throw accessError("ccdx_connections_conflict", 409);
    if (input.operation === "image_model") {
      if (!validObject(input, ["operation", "id", "model", "client_revision"]) || input.id !== "codex"
        || !imageModels().models.some(model => model.id === input.model)) throw accessError("ccdx_api_model_unavailable");
      const next = editable();next.clients.codex.image_model = input.model;save(next);
      await syncClients(["codex"]);
      return snapshot();
    }
    if (input.operation === "sync_client") {
      if (
        !validObject(input, ["operation", "id", "client_revision"]) ||
        !CLIENT_IDS.includes(input.id) ||
        typeof input.client_revision !== "string"
      )
        throw accessError("ccdx_connections_action_invalid");
      await syncClients([input.id], { manual: true });
      return snapshot();
    }
    if (input.operation === "client_state") {
      if (
        !validObject(input, ["operation", "id", "enabled", "client_revision"]) ||
        !CLIENT_IDS.includes(input.id) ||
        typeof input.enabled !== "boolean" ||
        typeof input.client_revision !== "string"
      )
        throw accessError("ccdx_connections_action_invalid");
      const next = editable();
      next.clients[input.id].enabled = input.enabled;
      save(next);
      await syncClients([input.id]);
      if (input.id === "codex") await clientAccessChanged?.(input.enabled);
      return snapshot();
    }
    const next = editable();
    let freshRef, previousRef;
    if (input.operation === "source_access") {
      const { targets, migrateClaude } = prepareSourceAccess(input, next);
      save(next);
      await syncClients([...targets]);
      const retained = migrateClaude
        ? [...targets].filter(
            id => id !== "codex" && next.clients[id].enabled && next.clients[id].source === "m365"
          )
        : [];
      return {
        ...snapshot(),
        client_refresh: retained.filter(id => setup[id] === "configured"),
        client_review: retained.filter(id =>
          ["preserved", "partially_preserved", "manual_sync", "configuration_unavailable"].includes(setup[id])
        ),
      };
    } else if (input.operation === "remove_api") {
      previousRef = removeApi(input, next);
    } else if (input.operation === "save_api") {
      ({ input, freshRef, previousRef } = prepareApiSave(input, next));
      try {
        if (freshRef) await secrets.set(freshRef, input.key);
        save(next);
      } catch (error) {
        if (freshRef) await secrets.remove(freshRef).catch(() => {});
        throw error;
      }
    } else if (["client", "preview_client"].includes(input.operation)) {
      const preview = applyClientSelection(input, next);
      if (input.operation === "preview_client") return preview;
    } else if (input.operation === "provider") {
      applyProviderEnabled(input, next);
      if (input.id === "m365") {
        if (input.enabled) await legacy.action({ action: "on" });
        else {
          const source = await legacy.pauseM365();
          if (source) retire(source);
        }
      }
    } else throw accessError("ccdx_connections_action_invalid");
    await syncClients();
    if (input.operation === "client" && input.id === "codex")
      await clientAccessChanged?.(binding("codex").enabled);
    if (previousRef && (freshRef || input.config?.key_env || input.operation === "remove_api")) {
      lifecycle.retireSecret(input.id, previousRef);
    }
    return snapshot();
  }
  return {
    async manageConnections(input) {
      if (!input) {
        if (binding("codex").enabled) void memoryModel.refresh();
        return snapshot();
      }
      if (validObject(input, ["operation", "id"]) && input.operation === "source_catalog") {
        if (!["github", "m365", ...getSettings().apis.map(api => api.id)].includes(input.id))
          throw accessError("ccdx_connections_action_invalid");
        const source = getSource(input.id),
          raw = source?.catalog?.() || source?.registry?.models?.data;
        return catalogVisibility({
          source: input.id,
          loaded: Array.isArray(raw),
          evidence: input.id.startsWith("api_") ? "configured" : "cached",
          access_checked: false,
          models: publicModelCatalog(raw || []).map(({ selectable, clients, ...model }) => model),
        }, input.id);
      }
      if (validObject(input, ["operation", "id"]) && input.operation === "discover") {
        const models = await catalogRefresh.refresh(input.id, true);
        return { ...snapshot(), discovered: models };
      }
      if (validObject(input, ["operation", "id"]) && input.operation === "cancel_discovery") {
        catalogRefresh.cancel(input.id);
        return snapshot();
      }
      const result = await enqueue(() => change(input));
      if (input.operation === "save_api") {
        const id =
          input.id || result.providers.find(api => !api.builtin && api.name === input.config.name)?.id;
        if (enabled(id)) void catalogRefresh.refresh(id).catch(() => {});
      } else if (input.operation === "provider" && input.enabled && input.id?.startsWith("api_"))
        void catalogRefresh.refresh(input.id).catch(() => {});
      return input.operation === "save_api" ? snapshot() : result;
    },
    async action(input) {
      if (isManaged() && input.action === "auto-review" && Array.isArray(binding("codex").deployments)) {
        const c = binding("codex"),
          compiled = plan("codex");
        if (!c.enabled || input.provider !== c.source) throw accessError("ccdx_client_source_mismatch", 409);
        const record = [...compiled.routes.values()].find(
          record => record.source === input.provider && record.upstreamModel === input.model
        );
        if (!record) throw accessError("ccdx_api_model_unavailable");
        if (input.effort && !record.model.capability.values.reasoning_efforts?.includes(input.effort))
          throw accessError("ccdx_api_effort_unavailable");
        const next = editable();
        next.clients.codex.auto_review_model = record.model.route_id;
        next.clients.codex.auto_review_effort = input.effort || null;
        save(next);
        return this.snapshot();
      }
      if (
        isManaged() &&
        input.action === "auto-review" &&
        input.provider &&
        input.provider !== this.selection().codex
      )
        throw accessError("ccdx_client_source_mismatch", 409);
      if (
        isManaged() &&
        input.action === "auto-review" &&
        (!binding("codex").enabled || !binding("codex").source)
      )
        throw accessError("ccdx_client_source_disabled", 503);
      if (isManaged() && ["on", "off", "remove"].includes(input.action)) {
        if (input.action === "remove" && legacy.snapshot().m365.active_requests > 0)
          throw accessError("ccdx_source_busy", 409);
        const replacements = Object.fromEntries(
          CLIENT_IDS.filter(id => binding(id).source === "m365" && binding(id).enabled).map(id => [id, null])
        );
        await this.manageConnections({
          operation: "provider",
          id: "m365",
          enabled: input.action === "on",
          replacements,
        });
        if (input.action === "remove") legacy.removeM365SavedProfile();
        return this.snapshot();
      }
      if (isManaged() && input.action === "switch" && !binding("codex").enabled)
        throw accessError("ccdx_client_source_disabled", 503);
      const { history_isolation, ...clientInput } = binding("codex");
      if (input.action === "switch" && input.provider?.startsWith("api_")) {
        await this.manageConnections({
          operation: "client",
          id: "codex",
          ...clientInput,
          deployments: null,
          default_model: null,
          source: input.provider,
          model: input.model,
          auto_review_model: input.auto_review_model,
          auto_review_effort: input.auto_review_effort,
        });
        return this.snapshot();
      }
      if (input.action === "auto-review" && isManaged() && binding("codex").source !== "github") {
        await this.manageConnections({
          operation: "client",
          id: "codex",
          ...clientInput,
          auto_review_model: input.model,
          auto_review_effort: input.effort,
        });
        return this.snapshot();
      }
      if (input.action === "auto-review" && isManaged() && legacy.selection().codex !== "github")
        await legacy.action({ action: "switch", provider: "github" });
      if (isManaged() && input.action === "switch" && !enabled(input.provider))
        throw accessError("ccdx_client_source_disabled", 503);
      const result = await legacy.action(input);
      if (isManaged() && input.action === "switch") {
        const next = editable();
        if (next.clients.codex.source !== input.provider) next.clients.codex.history_isolation = true;
        next.clients.codex.allowed = [...new Set([...next.clients.codex.allowed, input.provider])];
        next.clients.codex.source = input.provider;
        next.clients.codex.deployments = null;
        next.clients.codex.default_model = null;
        for (const key of ["model", "auto_review_model", "auto_review_effort"])
          delete next.clients.codex[key];
        if (input.provider === "m365") Object.assign(next.clients.codex, legacy.selection().m365);
        save(next);
        await syncClients(["codex"]);
      }
      return result;
    },
  };
}
