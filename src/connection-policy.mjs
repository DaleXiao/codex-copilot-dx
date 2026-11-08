import { randomBytes } from "node:crypto";
import { checkedApi, checkedAccessSettings, accessError, CLIENT_IDS } from "./access-settings.mjs";
import { checkedApiKey } from "./api-secrets.mjs";
import { imageModelSelection } from "./image-models.mjs";
import { compileClientModels, sourceModels } from "./client-model-plan.mjs";
import { deploymentModelId } from "./model-capabilities.mjs";
import { autoReviewReasoningEfforts } from "./models.mjs";
import { claudeSharedCapabilityPlan, inspectClaudeCapabilityConfiguration } from "./claude-capability-config.mjs";

export function createConnectionPolicy({ validObject, binding, catalogRefresh, save, discoveries, getSettings, env, imageModels, enabled,
  getSource, legacy, capabilitySupport, capabilitySupportForSync, plan, snapshot, options, permitted, sourceImpact }) {
  function removeApi(input, next) {
    const existing = next.apis.find(api => api.id === input.id);
    if (
      !validObject(input, ["operation", "id", "impact_revision"]) ||
      !existing ||
      existing.enabled ||
      CLIENT_IDS.some(
        id =>
          binding(id).source === input.id || binding(id).deployments?.some(item => item.source === input.id)
      )
    )
      throw accessError("ccdx_source_in_use", 409);
    const previousRef = existing.secret_ref;
    catalogRefresh.cancel(input.id);
    next.apis = next.apis.filter(api => api.id !== input.id);
    for (const id of CLIENT_IDS)
      next.clients[id].allowed = next.clients[id].allowed.filter(source => source !== input.id);
    save(next);
    discoveries.delete(input.id);
    return previousRef;
  }
  function prepareApiSave(input, next) {
    let freshRef, previousRef;
    const existing = next.apis.find(api => api.id === input.id);
    if (!existing && next.apis.length >= 16) throw accessError("ccdx_api_limit");
    if (
      !validObject(input.config, [
        "name",
        "base_url",
        "endpoints",
        "auth_header",
        "models",
        "key_env",
        "model_display",
      ])
    )
      throw accessError("ccdx_api_config_invalid");
    // Existing clients round-trip catalog data. New display-only fields must
    // remain readable without becoming editable connection configuration.
    const { model_display, ...editableConfig } = input.config;
    input = {
      ...input,
      config: {
        ...editableConfig,
        models: Array.isArray(editableConfig.models)
          ? editableConfig.models.map(model => {
              if (!model || typeof model !== "object" || Array.isArray(model)) return model;
              const { display, ...editable } = model;
              return editable;
            })
          : editableConfig.models,
      },
    };
    const id = existing?.id || "api_" + randomBytes(8).toString("hex");
    if (input.key !== undefined && input.key !== "") {
      checkedApiKey(input.key);
      freshRef = randomBytes(16).toString("hex");
    }
    if ((input.config.key_env && freshRef) || (!input.config.key_env && !freshRef && !existing?.secret_ref))
      throw accessError("ccdx_api_key_invalid");
    const config = checkedApi({
      ...input.config,
      id,
      enabled: existing?.enabled ?? true,
      ...(!input.config.key_env ? { secret_ref: freshRef || existing.secret_ref } : {}),
    });
    if (!Array.isArray(input.allowed) || input.allowed.some(id => !CLIENT_IDS.includes(id)))
      throw accessError("ccdx_connections_action_invalid");
    for (const id of CLIENT_IDS) {
      const c = next.clients[id];
      if (
        c.deployments?.some(
          item =>
            item.source === config.id &&
            (!input.allowed.includes(id) ||
              !config.models.some(
                model =>
                  model.id === item.model &&
                  model.protocols.includes(id === "codex" ? "responses" : "messages")
              ))
        )
      )
        throw accessError("ccdx_source_in_use", 409);
      if (c.source === config.id && !input.allowed.includes(id)) throw accessError("ccdx_source_in_use", 409);
      if (
        c.source === config.id &&
        c.enabled &&
        !Array.isArray(c.deployments) &&
        (!config.models.some(model => model.protocols.includes(id === "codex" ? "responses" : "messages")) ||
          (id === "codex" &&
            [c.model, c.auto_review_model]
              .filter(Boolean)
              .some(
                value =>
                  !config.models.some(model => model.id === value && model.protocols.includes("responses"))
              )))
      )
        throw accessError("ccdx_api_model_unavailable");
      if (input.allowed.includes(id) && !config.endpoints[id === "codex" ? "responses" : "messages"])
        throw accessError("ccdx_api_protocol_required");
      c.allowed = [
        ...new Set([
          ...c.allowed.filter(value => value !== config.id),
          ...(input.allowed.includes(id) ? [config.id] : []),
        ]),
      ];
    }
    if (existing) {
      previousRef = existing.secret_ref;
      next.apis[next.apis.indexOf(existing)] = config;
    } else next.apis.push(config);
    checkedAccessSettings(next);
    return { input, freshRef, previousRef };
  }
  function applyClientSelection(input, next) {
    if (
      !CLIENT_IDS.includes(input.id) ||
      typeof input.enabled !== "boolean" ||
      !Array.isArray(input.allowed) ||
      (input.source !== null && input.source !== undefined && !input.allowed.includes(input.source))
    )
      throw accessError("ccdx_connections_action_invalid");
    const old = next.clients[input.id],
      retained = { ...old };
    if (old.source !== input.source || (Array.isArray(old.deployments) && input.deployments === null))
      for (const key of ["model", "auto_review_model", "auto_review_effort"]) delete retained[key];
    next.clients[input.id] = {
      ...retained,
      enabled: input.enabled,
      allowed: input.allowed,
      source: input.enabled ? (input.source ?? old.source) : null,
      ...(input.deployments !== undefined
        ? {
            deployments: input.deployments,
            default_model: input.default_model ?? null,
            auto_sync: input.auto_sync ?? true,
          }
        : old.source !== input.source
          ? { deployments: null, default_model: null }
          : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.auto_review_model ? { auto_review_model: input.auto_review_model } : {}),
      ...(input.auto_review_effort !== undefined ? { auto_review_effort: input.auto_review_effort } : {}),
    };
    if (input.image_model !== undefined) {
      if (input.id !== "codex" || input.image_model !== old.image_model && !imageModels().models.some(model => model.id === input.image_model)) throw accessError("ccdx_api_model_unavailable");
      next.clients.codex.image_model = input.image_model;
    }
    if (input.id !== "codex") next.claude_private_keys = true;
    if (old.source !== input.source) next.clients[input.id].history_isolation = true;
    const c = next.clients[input.id];
    if (Array.isArray(input.deployments)) {
      checkedAccessSettings(next);
      for (const item of c.deployments || []) {
        if (
          !enabled(item.source) ||
          !sourceModels(getSource(item.source), input.id).some(model => model.id === item.model)
        )
          throw accessError("ccdx_api_model_unavailable");
      }
      const names = Object.fromEntries(next.apis.map(api => [api.id, api.name]));
      const compiled = compileClientModels({
        client: input.id,
        binding: c,
        source: getSource,
        enabled,
        names,
        desktopEffortAliases: capabilitySupport.app,
      });
      if (c.default_model && !compiled.routes.has(c.default_model))
        throw accessError("ccdx_api_model_unavailable");
      c.default_model = compiled.routes.get(compiled.defaultModel)?.model.route_id || null;
      c.source = c.enabled ? compiled.routes.get(c.default_model)?.source || null : null;
      c.history_isolation = true;
      if (input.id === "codex") {
        c.model = compiled.routes.get(c.default_model)?.upstreamModel;
        const review =
          compiled.routes.get(old.auto_review_model) ||
          [...compiled.routes.values()].find(
            record => record.source === old.source && record.upstreamModel === old.auto_review_model
          );
        if (c.default_model)
          c.auto_review_model = review?.source === c.source ? review.model.route_id : c.default_model;
        else delete c.auto_review_model;
        if (review?.source === c.source && old.auto_review_effort !== undefined)
          c.auto_review_effort = old.auto_review_effort;
        else delete c.auto_review_effort;
      }
    }
    if (c.source && !Array.isArray(input.deployments)) {
      if (!enabled(c.source)) throw accessError("ccdx_client_source_disabled", 503);
      const target = getSource(c.source),
        family = input.id === "codex" ? "gpt" : "claude";
      const api = getSettings().apis.find(api => api.id === c.source);
      if (api?.key_env && !env[api.key_env]) throw accessError("ccdx_api_environment_key_missing", 503);
      if (
        (input.id !== "codex" && c.source === "github") ||
        (c.source !== "github" && !target?.models(family).length)
      )
        throw accessError("ccdx_api_model_unavailable");
      if (input.id === "codex" && c.source !== "github") {
        const previous = c.source === "m365" ? legacy.selection().m365 : null;
        c.model = input.model || previous?.model || target.models("gpt")[0].id;
        c.auto_review_model = input.auto_review_model || previous?.auto_review_model || c.model;
        if (![c.model, c.auto_review_model].every(id => target.models("gpt").some(model => model.id === id)))
          throw accessError("ccdx_api_model_unavailable");
        const efforts = api
          ? sourceModels(target, "codex").find(model => model.id === c.auto_review_model)?.capability.values
              .reasoning_efforts || []
          : autoReviewReasoningEfforts(target.models("gpt").find(model => model.id === c.auto_review_model));
        if (
          c.auto_review_effort !== undefined &&
          c.auto_review_effort !== null &&
          !efforts.includes(c.auto_review_effort)
        )
          throw accessError("ccdx_api_effort_unavailable");
      }
    }
    if (input.operation === "preview_client") {
      const proposed = compileClientModels({
        client: input.id,
        binding: c,
        source: getSource,
        enabled,
        desktopEffortAliases: capabilitySupport.app,
      });
      const shared =
        input.id === "codex"
          ? null
          : claudeSharedCapabilityPlan({
              app: input.id === "claude_app" ? proposed.models : plan("claude_app").models,
              code: input.id === "claude_code" ? proposed.models : plan("claude_code").models,
              support: capabilitySupportForSync(),
            });
      return {
        ...snapshot(),
        preview: {
          ...(input.id === "codex" ? { image: imageModelSelection(imageModels().models, c.image_model) } : {}),
          models: proposed.models.map(model => ({
            source: model.source_id,
            id: model.id,
            public_id: model.public_id,
            capability: model.capability,
          })),
          shared,
          current:
            input.id === "codex" ? null : inspectClaudeCapabilityConfiguration(proposed.models, options),
          saved: false,
        },
      };
    }
    save(next);
  }
  function applyProviderEnabled(input, next) {
    if (
      typeof input.enabled !== "boolean" ||
      !["github", "m365", ...next.apis.map(api => api.id)].includes(input.id)
    )
      throw accessError("ccdx_connections_action_invalid");
    if (input.id === "m365" && input.enabled && env.CCDX_M365 === "0")
      throw accessError("ccdx_provider_environment_disabled", 409);
    if (input.id === "m365" && !input.enabled && legacy.snapshot().m365.claude.requests?.active > 0)
      throw accessError("ccdx_source_busy", 409);
    if (!input.enabled) {
      const impact = sourceImpact(input.id);
      if (input.impact_revision !== undefined && input.impact_revision !== impact.revision)
        throw accessError("ccdx_connections_conflict", 409);
      const affected = impact.clients.filter(client => client.needs_replacement).map(client => client.id);
      if (affected.some(id => id !== "codex")) next.claude_private_keys = true;
      if (affected.length && !validObject(input.replacements, affected))
        throw accessError("ccdx_source_in_use", 409);
      for (const id of affected) {
        const replacement = input.replacements[id];
        if (
          replacement !== null &&
          (replacement === input.id ||
            !permitted(id, replacement) ||
            (replacement !== "github" &&
              !getSource(replacement)?.models(id === "codex" ? "gpt" : "claude").length))
        )
          throw accessError("ccdx_connections_action_invalid");
        next.clients[id].source = replacement;
        next.clients[id].history_isolation = true;
      }
    }
    if (!input.enabled)
      for (const id of CLIENT_IDS) {
        const c = next.clients[id];
        if (!Array.isArray(c.deployments)) continue;
        const had = c.deployments.some(item => item.source === input.id);
        if (!had) continue;
        c.deployments = c.deployments.filter(item => item.source !== input.id);
        if (input.replacements && Object.hasOwn(input.replacements, id)) {
          const replacement = input.replacements[id];
          if (!replacement) c.deployments = [];
          else if (!c.deployments.some(item => item.source === replacement)) {
            const model = sourceModels(getSource(replacement), id)[0];
            if (model) c.deployments.push({ source: replacement, model: model.id });
          }
          c.default_model = c.deployments.find(item => item.source === replacement)
            ? deploymentModelId(replacement, c.deployments.find(item => item.source === replacement).model)
            : null;
        }
      }
    if (input.id.startsWith("api_")) next.apis.find(api => api.id === input.id).enabled = input.enabled;
    else next.providers[input.id] = input.enabled;
    save(next);
  }
  return { removeApi, prepareApiSave, applyClientSelection, applyProviderEnabled };
}
