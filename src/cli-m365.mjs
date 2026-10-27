import { createInterface } from "node:readline/promises";
import { readM365Settings, updateM365Settings } from "./m365-settings.mjs";
import { readProviderSettings } from "./provider-settings.mjs";
import { autoReviewPreference } from "./user-settings.mjs";
import { PROVIDER_MANAGEMENT_PATH } from "./provider-management.mjs";
import { adapterBaseUrl } from "./running-adapter.mjs";
import { isLoopbackHost } from "./security.mjs";
import { terminalCell } from "./terminal-text.mjs";
import { readBoundedResponseText } from "./upstream-body.mjs";
import { parseAdapterAddressOptions } from "./cli-options.mjs";
import { autoReviewReasoningEfforts } from "./models.mjs";
import { m365AccountMessage } from "./providers/m365-accounts.mjs";
import { m365CatalogDiagnostic, m365CatalogMessage } from "./providers/m365-catalog-diagnostic.mjs";
import { m365NetworkDiagnostic, m365NetworkMessage } from "./providers/m365-network-diagnostic.mjs";
import fs from "node:fs";
import { accessSettingsPath, readAccessSettings } from "./access-settings.mjs";

function codexSelection(options) {
  const settings = readProviderSettings(options), access = fs.existsSync(accessSettingsPath(options)) ? readAccessSettings(options) : null;
  const client = access?.clients.codex, provider = client ? client.enabled ? client.source : null : settings.codex;
  if (provider === null) throw new Error("Codex access is paused. Review Settings in the WebUI.");
  return { settings, access, client, provider };
}

export async function fetchActiveProviderModels({ control = providerControl, ...options } = {}) {
  const selected = codexSelection(options);
  if (selected.access) {
    const config = selected.access, client = selected.client;
    if (client.source.startsWith("api_")) {
      const api = config.apis.find(api => api.id === client.source && api.enabled);
      if (!api) throw new Error("The selected API is disabled. Review Settings in the WebUI.");
      const models = api.models.filter(model => model.protocols.includes("responses"));
      return { source: "configured", upstreamHost: new URL(api.base_url).hostname, advertised: models.length,
        models: models.map(model => ({ id: model.id, vendor: "Unknown", endpoints: ["responses"], preview: false })) };
    }
  }
  if (selected.provider !== "m365") {
    const { fetchLiveCopilotModels } = await import("./live-models.mjs");
    return fetchLiveCopilotModels(options);
  }
  const address = parseAdapterAddressOptions(options.env || process.env);
  const result = await control({ host: address.adapterHost, port: address.adapterPort, ...options, action: { action: "models", family: "gpt" } });
  let upstreamHost = "Microsoft 365";
  try { const origin = new URL(result.state?.m365?.service_origin);if (origin.protocol === "https:") upstreamHost = origin.hostname; } catch {}
  return { source: "catalog", upstreamHost, advertised: result.models.length,
    models: result.models.map(model => ({ id: model.id, vendor: model.publisher, endpoints: ["responses"], preview: false })) };
}

export async function providerControl({ host = "127.0.0.1", port = 2026, action, fetchImpl = fetch, timeoutMs = 35000 } = {}) {
  const url = `${adapterBaseUrl(isLoopbackHost(host) ? host : "127.0.0.1", port)}${PROVIDER_MANAGEMENT_PATH}`;
  const response = await fetchImpl(url, { method: action ? "POST" : "GET", headers: { Accept: "application/json", ...(action ? { "Content-Type": "application/json" } : {}) },
    ...(action ? { body: JSON.stringify(action) } : {}), redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
  const value = JSON.parse(await readBoundedResponseText(response, { maxBytes: 4 * 1024 * 1024, label: "Provider status" }));
  if (!response.ok) throw Object.assign(new Error(value.error?.message || "Provider management is unavailable; restart the updated CCDX service"), { code: value.error?.code || "ccdx_provider_management_unavailable" });
  return value;
}

export function formatM365Status(state) {
  const m = state.m365 || {}, claude = m.claude || {}, models = m.models || {};
  const network = m365NetworkDiagnostic(m.network_diagnostic);
  const catalog = m365CatalogDiagnostic(m.catalog_diagnostic);
  return [
    `Microsoft 365: ${terminalCell(m.state || "not running")}${m.reason ? ` (${terminalCell(m.reason)})` : ""}`,
    ...(m.account?.login ? [`Account: ${terminalCell(m.account.login)}`] : []),
    ...(m.account?.tenant ? [`Tenant: ${terminalCell(m.account.tenant)} / ${terminalCell(m.account.selection_source || "legacy")}`] : []),
    ...(network ? [`Network: ${network.source} / ${network.stage} / ${network.cause_code}`, m365NetworkMessage(network)] : m.reason ? [m365AccountMessage(m.reason)] : []),
    `Models: ${models.claude || 0} Claude / ${models.gpt || 0} GPT (${models.source || "unavailable"})`,
    `Claude gateway: ${claude.gateway || "not running"}${claude.base_url ? ` / ${claude.base_url}` : ""}`,
    ...(catalog ? [`Catalog: ${m365CatalogMessage(catalog)} (HTTP ${catalog.http_status})`,
      `Checked: ${catalog.checked_at || "unknown"} / Last success: ${catalog.last_success_at || "unknown"}`,
      ...(catalog.request_id ? [`Service request: ${catalog.request_id}`] : [])] : []),
    ...(claude.reason ? [`Claude detail: ${terminalCell(claude.reason)}`] : []),
    ...(claude.requests ? [`Claude requests: ${claude.requests.completed} completed / ${claude.requests.incomplete} incomplete / ${claude.requests.failed} failed / ${claude.requests.active} active`] : []),
    `Claude Code: ${claude.clients?.code || "unknown"}; Claude App: ${claude.clients?.app || "unknown"}`,
    `Codex provider: ${state.codex_provider === null ? "off" : terminalCell(state.connections?.providers?.find(provider => provider.id === state.codex_provider)?.name || state.codex_provider || "github")} (default: github)`,
  ].join("\n");
}

export async function runProviderAutoReviewCommand(options = {}) {
  const { runAutoReviewModelCommand } = await import("./auto-review-model.mjs");
  const selected = codexSelection(options), settings = selected.settings;
  if (selected.provider.startsWith("api_")) {
    const api = selected.access.apis.find(api => api.id === selected.provider && api.enabled);
    if (!api) throw new Error("The selected API is disabled. Review Settings in the WebUI.");
    const state = await providerControl(options);if (state.codex_provider !== selected.provider) throw new Error("Saved and active sources differ. Restart CCDX before changing review settings.");
    const preference = selected.client, models = api.models.filter(model => model.protocols.includes("responses"));
    return runAutoReviewModelCommand({ ...options, env: { ...(options.env || process.env), CCDX_AUTO_REVIEW_MODEL: "" }, followClientLabel: "follow client (no override)",
      loadCatalog: async () => ({ modelIds: models.map(model => model.id), source: api.name, reasoningEfforts: Object.fromEntries(models.map(model => [model.id, model.reasoning_efforts || []])) }),
      getPreference: () => ({ model: preference.auto_review_model || preference.model, source: api.name, reasoningEffort: preference.auto_review_effort ?? null }),
      savePreference: (model, { reasoningEffort }) => providerControl({ ...options, action: { action: "auto-review", provider: selected.provider, model, effort: reasoningEffort } }),
    });
  }
  if (selected.provider !== "m365") return runAutoReviewModelCommand(options);
  const state = await providerControl(options);
  if (state.codex_provider !== "m365") throw new Error("Saved and active sources differ.\nRestart CCDX before changing review settings.");
  const preference = selected.client?.auto_review_model ? selected.client : state.m365?.preference || settings.m365;
  return runAutoReviewModelCommand({ ...options, env: { ...(options.env || process.env), CCDX_AUTO_REVIEW_MODEL: "" },
    loadCatalog: async () => {
      const result = await providerControl({ ...options, action: { action: "models", family: "gpt" } });
      return { modelIds: result.models.map(model => model.id), source: "Microsoft 365",
        reasoningEfforts: Object.fromEntries(result.models.map(model => [model.id, autoReviewReasoningEfforts(model)])) };
    },
    getPreference: () => ({ model: preference.auto_review_model, source: "m365", reasoningEffort: preference.auto_review_effort === undefined ? "low" : preference.auto_review_effort }),
    savePreference: (model, { reasoningEffort }) => providerControl({ ...options, action: { action: "auto-review", model, effort: reasoningEffort } }),
  });
}

export async function runM365Command({ action = "status", provider, model, autoReviewModel, accountId, host, port, home,
  env = process.env, input = process.stdin, output = process.stdout, prompt, control = providerControl } = {}) {
  const options = { home, env };
  let readline;
  const ask = prompt || (question => { if (!input.isTTY || !output.isTTY) throw new Error("Choose the source and models with command arguments.");
    readline ||= createInterface({ input, output });return readline.question(question); });
  const request = value => control({ host, port, action: value, ...(value?.action === "account" ? { timeoutMs: 65000 } : {}) });
  try {
    if (action === "accounts" || action === "account") {
      const result = await request({ action: "accounts" });
      const accounts = result.accounts || [];
      if (!accounts.length) throw new Error("No company account found. Connect your work account in Windows or macOS, then check again.");
      if (action === "accounts") {
        output.write(accounts.map(value => `${terminalCell(value.login)} / ${terminalCell(value.tenant)}${value.selected ? " [selected]" : value.current_windows ? " [Windows sign-in]" : ""}\n  ID: ${value.id}`).join("\n") + "\n");
        return result;
      }
      if (!accountId) {
        if (!prompt && (!input.isTTY || !output.isTTY)) throw new Error("Use ccdx m365 account --id ID from ccdx m365 accounts.");
        output.write(accounts.map((value, index) => `  ${index + 1}. ${terminalCell(value.login)} / ${terminalCell(value.tenant)}${value.selected ? " [selected]" : value.current_windows ? " [Windows sign-in]" : ""}`).join("\n") + "\n");
        const answer = String(await ask("Choose an account, or q to cancel: ")).trim();
        if (answer === "q") return { cancelled: true };
        const index = Number(answer) - 1;
        if (!Number.isInteger(index) || !accounts[index]) throw new Error("Choose a listed account");
        accountId = accounts[index].id;
      }
      if (!accounts.some(value => value.id === accountId)) throw new Error("Account list changed. Check again and select a listed account.");
      output.write("Applies to Microsoft 365 in Codex and Claude. Use a new conversation after changing accounts.\n");
      const state = await request({ action: "account", account_id: accountId });
      output.write(formatM365Status(state) + "\n");return state;
    }
    if (action === "status") {
      try { const state = await request();output.write(formatM365Status(state) + "\n");return state; }
      catch (error) {
        const saved = readM365Settings(options), selected = readProviderSettings(options);
        output.write(`Microsoft 365 preference: ${saved.enabled ? "auto" : "off"}\nCodex provider: ${selected.codex}\nRuntime status unavailable; start or restart ccdx to inspect it.\n`);
        return { saved: true, runtime: "unavailable" };
      }
    }
    if (action === "switch") {
      if (!provider) {
        const graph = fs.existsSync(accessSettingsPath(options)) ? readAccessSettings(options) : null;
        const choices = graph ? [{ id: "github", name: "GitHub Copilot" }, { id: "m365", name: "Microsoft 365" }, ...graph.apis.filter(api => api.enabled && api.models.some(model => model.protocols.includes("responses")))
          .map(api => ({ id: api.id, name: api.name }))].filter(source => graph.clients.codex.allowed.includes(source.id) && (source.id.startsWith("api_") || graph.providers[source.id]))
          : [{ id: "github", name: "GitHub Copilot (default)" }, { id: "m365", name: "Microsoft 365 (backup)" }];
        if (!choices.length) throw new Error("No enabled Codex source. Review Settings in the WebUI.");
        output.write("Codex provider:\n" + choices.map((source, index) => `  ${index + 1}. ${terminalCell(source.name)}\n`).join(""));
        const answer = String(await ask(choices.length === 2 ? "Choose 1 or 2; q cancels: " : "Choose a source, or q to cancel: ")).trim();
        if (answer === "q") return { cancelled: true };
        const index = Number(answer) - 1;if (!Number.isInteger(index) || !choices[index]) throw new Error("Choose a listed source");provider = choices[index].id;
      }
      if (provider === "m365") {
        const available = await request({ action: "models", family: "gpt" });
        const models = available.models || [], ids = models.map(entry => entry.id);
        if (!ids.length) throw new Error("No M365 GPT models available. The current source is unchanged.");
        const saved = readProviderSettings(options).m365;
        const choose = async (label, supplied, preferred) => {
          if (supplied) { if (!ids.includes(supplied)) throw new Error(`${label} model is not available: ${terminalCell(supplied)}`);return supplied; }
          const current = ids.includes(preferred) ? preferred : null;
          if (!prompt && (!input.isTTY || !output.isTTY)) {
            if (current) return current;
            throw new Error(`Specify --${label === "Auto-review" ? "auto-review-model" : "model"} with an available M365 model: ${ids.join(", ")}`);
          }
          output.write(`${label} model:\n${ids.map((id, index) => `  ${index + 1}. ${id}${id === current ? " [current]" : ""}`).join("\n")}\n`);
          const answer = String(await ask(`Select a model${current ? ` [${ids.indexOf(current) + 1}]` : ""}, or q to cancel: `)).trim();
          if (answer === "q") return null;
          const index = answer === "" && current ? ids.indexOf(current) : Number(answer) - 1;
          if (!Number.isInteger(index) || !ids[index]) throw new Error("Invalid model selection");return ids[index];
        };
        model = await choose("Codex", model, saved?.model);if (!model) return { cancelled: true };
        autoReviewModel = await choose("Auto-review", autoReviewModel, saved?.auto_review_model || autoReviewPreference(options).model);
        if (!autoReviewModel) return { cancelled: true };
        output.write("M365 fast tier is not verified. Use Standard in Codex; existing threads keep their selected model until you change it.\n");
      }
      const state = await request({ action: "switch", provider, model, auto_review_model: autoReviewModel });
      if (provider.startsWith("api_")) {
        const api = state.connections?.providers.find(source => source.id === provider), client = state.connections?.clients.find(client => client.id === "codex");
        output.write(`Codex source: ${terminalCell(api?.name || provider)}\nModel: ${terminalCell(client?.model)}\nReview: ${terminalCell(client?.auto_review_model)} / ${terminalCell(client?.auto_review_effort || "follow client")}\n`);return state;
      }
      output.write(formatM365Status(state) + "\n");
      if (provider === "m365") output.write(`Select ${model} in Codex. Auto-review uses ${autoReviewModel} / low on this provider.\n`);
      return state;
    }
    if (action === "models") {
      const value = await request({ action: "models", family: "claude" });
      output.write((value.models || []).map(model => terminalCell(model.id)).join("\n") + "\n");return value;
    }
    if (["on", "off", "remove"].includes(action)) {
      try { const state = await request({ action });output.write(formatM365Status(state) + "\n");return state; }
      catch (error) {
        if (error.cause?.code !== "ECONNREFUSED") throw error;
        if (action === "on") { updateM365Settings({ enabled: true }, options);output.write("M365 auto-discovery enabled. Run ccdx to start it.\n");return; }
        const { createProviderRuntime } = await import("./provider-runtime.mjs");
        const runtime = createProviderRuntime({ ...options });
        try { const state = await runtime.action({ action });output.write(formatM365Status(state) + "\n");return state; }
        finally { await runtime.close(); }
      }
    }
    throw new Error("Unknown M365 action");
  } finally { readline?.close(); }
}
