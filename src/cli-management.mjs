import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { dashboardToolRequest } from "./cli-tools.mjs";
import { readAdapterStatus } from "./cli-status.mjs";
import { CLI_CLIENTS } from "./cli-command-spec.mjs";
import { projectTerminalState, retainedRequests, clientSetup, TERMINAL_CLIENT_NAMES, terminalUptime, terminalRequestState } from "./terminal-state.mjs";
import { formatResponsiveCliTable, cliOutputWidth, terminalCell } from "./cli-table.mjs";
import { redactDiagnosticText } from "./diagnostic-text.mjs";
import { settingsPreferencesSnapshot, writeSettingsPreferences, checkedPreferenceValues } from "./settings-preferences.mjs";
import { checkedApi } from "./access-settings.mjs";
import { hiddenQuestion } from "./cli-secret.mjs";
import { readBoundedFileSync } from "./bounded-file.mjs";
import { deploymentModelId } from "./model-capabilities.mjs";
import { TERMINAL_COLOR_THEMES } from "./terminal-colors.mjs";
import { previewSourceImport } from "./source-import.mjs";
import { readAccessSettings } from "./access-settings.mjs";

async function readSecretInput(input) {
  const chunks = [];let bytes = 0;
  for await (const chunk of input) { const data = Buffer.from(chunk);bytes += data.length;if (bytes > 8192) throw new Error("API key input is too large");chunks.push(data); }
  return Buffer.concat(chunks).toString("utf8").trim();
}

const apiConfig = source => Object.fromEntries(["name", "base_url", "endpoints", "auth_header", "models", "key_env"].filter(key => source[key] !== undefined).map(key => [key, source[key]]));
const publicValue = value => JSON.parse(JSON.stringify(value, (key, item) => /^(?:api_key|access_token|refresh_token|authorization|password|secret_ref|key|secret)$/.test(key) ? undefined
  : typeof item === "string" ? redactDiagnosticText(item) : item));
export function formatManagement(value, { format, output = process.stdout, columns } = {}) {
  const safe = publicValue(value);
  if (format === "json") return JSON.stringify(safe, null, 2);
  const rows = Array.isArray(safe) ? safe : [safe];
  if (!rows.length) return "No retained records.";
  if (columns && (format === "table" || format === undefined && output.isTTY === true)) {
    const data = rows.map(row => Object.fromEntries(columns.map(([key]) => [key, Array.isArray(row[key]) ? row[key].join(", ") : typeof row[key] === "object" && row[key] !== null ? JSON.stringify(row[key]) : row[key] ?? "—"])));
    const table = formatResponsiveCliTable({ columns: columns.map(([key, label]) => ({ key, label })), rows: data, width: cliOutputWidth(output) });
    if (!table.overflow) return table.output;
  }
  const scalar = value => value === null || value === undefined ? "Not observed" : value === true ? "Yes" : value === false ? "No" : terminalCell(String(value));
  const lines = (item, indent = "") => Object.entries(item).flatMap(([key, value]) => {
    const label = terminalCell(key.replaceAll("_", " ").replace(/^./, char => char.toUpperCase()));
    if (Array.isArray(value)) {
      if (!value.length) return [`${indent}${label}: None`];
      if (value.every(row => row === null || typeof row !== "object")) return [`${indent}${label}: ${value.map(scalar).join(", ")}`];
      return [`${indent}${label}:`, ...value.flatMap(row => typeof row === "object" && row ? lines(row, indent + "  ") : [indent + "  " + scalar(row)])];
    }
    if (value && typeof value === "object") return [`${indent}${label}:`, ...lines(value, indent + "  ")];
    return [`${indent}${label}: ${scalar(value)}`];
  });
  return rows.map(row => lines(row).join("\n")).join("\n\n");
}
export async function runManagementCommand(command, options = {}) {
  const { group, ids = {}, flags = {}, path } = command, action = path.at(-1), input = options.input || process.stdin, output = options.output || process.stdout;
  const io = { format: flags.format, output }, rawRequest = options.request || (args => dashboardToolRequest({ host: options.host, port: options.port, detailedErrors: true, ...args }));
  const request = async args => {
    try { return await rawRequest(args); }
    catch (error) {
      const messages = { ccdx_connections_conflict: "Settings changed. Reload and review before saving again.", ccdx_settings_changed: "Service preferences changed. Reload and review before saving again.", ccdx_source_in_use: "This source is still selected. Review replacements or pause the affected clients.",
        ccdx_source_busy: "This source has active work. Wait for it to finish before changing access.", ccdx_api_model_unavailable: "A selected model is unavailable. Saved selections were kept.",
        ccdx_client_source_disabled: "Model access is paused. Review the client, source and model selection.", ccdx_api_protocol_required: "This source does not provide the required client interface." };
      if (error.code && error.code !== "ccdx_tool_unavailable") error.message = messages[error.code] || `Operation rejected: ${error.code}. ${error.code.startsWith("ccdx_settings_") ? "Review service preferences and their backup; existing files were kept." : "Review the selected source or client."}`;
      throw error;
    }
  };
  const readStatus = options.readStatus || (() => readAdapterStatus({ host: options.host, port: options.port }));
  const ask = options.prompt || (async question => {
    if (!input.isTTY || !output.isTTY) throw new Error("This edit needs an interactive terminal or explicit file/options.");
    const prompt = createInterface({ input, output });try { return await prompt.question(question); } finally { prompt.close(); }
  });
  const print = (value, columns) => formatManagement(value, { ...io, columns });
  const confirm = async message => {
    if (flags.preview) return false;
    if (flags.yes) return true;
    if (!/^y(?:es)?$/i.test((await ask(`${message} [y/N]: `)).trim())) throw new Error("Change cancelled; existing settings kept.");
    return true;
  };
  const choose = async (rows, selected = [], title = "Select numbers, separated by commas") => {
    rows.forEach((row, index) => output.write(`${String(index + 1).padStart(3)} ${selected.includes(index) ? "[x]" : "[ ]"} ${terminalCell(row)}\n`));
    const value = (await ask(`${title} (Enter keeps selection; none clears it): `)).trim();
    if (!value) return selected;if (value === "none") return [];
    const numbers = value.split(",").map(item => item.trim());
    if (!numbers.every(item => /^\d+$/.test(item) && Number(item) >= 1 && Number(item) <= rows.length) || new Set(numbers).size !== numbers.length) throw new Error("Choose listed, unique numbers.");
    return numbers.map(item => Number(item) - 1);
  };
  let managementVersion = 0;
  const connection = async () => {
    const graph = await request({ path: "connections" });
    if (graph.source !== "connections" || !Array.isArray(graph.clients) || !Array.isArray(graph.providers)) throw new Error("Incompatible connection status; existing settings were kept.");
    managementVersion = graph.management_version || 0;return graph;
  };
  const requireManagement = () => { if (managementVersion !== 1) throw new Error("This command needs the updated running service. Finish tasks, then restart CCDX normally; no settings changed."); };
  const save = body => { requireManagement();return request({ path: "connections", body, timeoutMs: 30000 }); };
  const getClient = (graph, id) => { const client = graph.clients.find(item => item.id === id);if (!client) throw new Error("Client is not registered.");return client; };
  const getSource = (graph, id) => { const source = graph.providers.find(item => item.id === id);if (!source) throw new Error("Source is not registered.");return source; };
  const clientBody = client => ({ operation: "client", id: client.id, client_revision: client.revision, enabled: client.enabled, allowed: client.allowed, source: client.source,
    ...(Array.isArray(client.deployments) ? { deployments: client.deployments, default_model: client.default_model, auto_sync: client.auto_sync, ...(client.image_model ? { image_model: client.image_model } : {}) } : {}) });
  const readFile = () => JSON.parse(readBoundedFileSync(flags.file, { encoding: "utf8", maxBytes: 256 * 1024 }));
  if (group === "status") {
    const { data, baseUrl } = await readStatus();
    if (flags.details) {
      if (flags.format === "json") return print(data);
      const { formatAdapterStatus } = await import("./cli-status.mjs");const diagnostic = formatAdapterStatus({ data, baseUrl }, { cliVersion: options.version || data.version, scoped: true });
      const settings = await request({ path: "settings" });
      return diagnostic + (settings.terminal?.last_notice ? `\nLatest terminal notice: ${terminalCell(settings.terminal.last_notice)}` : "");
    }
    const view = projectTerminalState(data);
    const result = { service: "Listening", address: baseUrl, running_version: data.version, ...(options.version !== data.version ? { installed_version: options.version } : {}),
      enabled_sources: view.sources?.map(source => source.name) ?? null, apps: view.clients, model_requests: { total: view.requests, active: view.active, ...view.outcomes } };
    if (flags.format === "json") return print(result);
    const sourceNames = view.sources?.map(source => source.name).join(" · ");
    return [`CCDX ${data.version}${options.version && options.version !== data.version ? ` · installed CLI ${options.version}` : ""}`,
      `Running · up ${terminalUptime(data.uptime_ms)}`, `Web UI: ${baseUrl}`, `Enabled sources: ${view.sources?.length ?? "unknown"}`,
      ...(sourceNames ? [sourceNames] : []), "", print(view.clients, [["name", "Client"], ["setup", "Setup"], ["active", "Active"]]), "",
      `Model requests: ${view.requests ?? "unknown"} total · ${view.active ?? "unknown"} active · ${view.outcomes.failed} failed`].join("\n");
  }
  if (group === "compact") {
    const live = await request({ path: "settings" });
    if (action === "status") return print(live.compaction || { enabled: false, state: "unsupported" });
    if (!live.compaction) throw new Error("This command needs the updated running service; no settings changed.");
    const enabled = action === "enable";
    if (flags.preview) return print({ enabled, saved: false, source_policy: "current source and model", uses_quota: enabled });
    await confirm(enabled ? "Enable bounded compression recovery using the current source and model? It can use quota." : "Disable gateway compression fallback?");
    const result = await request({ path: "settings", body: { action: "preference", key: "context_compaction_enabled", value: enabled } });
    return print(result.compaction);
  }
  if (group === "requests") {
    if (action === "tools") {
      const { data } = await readStatus();
      const parts = [data.stream_performance, (data.providers?.claude || data.providers?.m365?.claude)?.requests?.performance].filter(Boolean);
      if (!parts.some(part => part.tool_activity)) throw new Error("This command needs the updated running service; no settings changed.");
      const items = parts.flatMap(part => part.tool_activity?.items || []).filter(row => !flags.active || ["preparing", "waiting"].includes(row.state));
      return print(items, [["application", "Client"], ["provider", "Source"], ["model", "Model"], ["name", "Tool"], ["state", "State"]]);
    }
    if (action === "diagnose") {
      if (flags.source || flags.model || flags.cancel) {
        if (!flags.cancel && (!flags.source || !flags.model)) throw new Error("Use --source ID and --model ID together.");
        if (flags.cancel && (flags.source || flags.model)) throw new Error("Use --cancel alone.");
        if (flags.preview) return print({ source: flags.source, model: flags.model, operation: flags.cancel ? "cancel" : "arm", saved: false, error_limit: 512, expires_minutes: 10 });
        await confirm(flags.cancel ? "Cancel the pending capture?" : "Capture one redacted technical error (up to 512 characters)? It may contain a request fragment; no prompt body is saved.");
        const result = await request({ path: "settings", body: { action: "error_capture", operation: flags.cancel ? "cancel" : "arm", ...(flags.cancel ? {} : { source: flags.source, model: flags.model }) } });
        return print(result.error_capture);
      }
      return print((await request({ path: "settings" })).error_capture || { state: "unsupported" });
    }
    let rows = retainedRequests((await readStatus()).data);
    if (ids.request) {
      const found = rows.find(row => row.request_id === ids.request);if (!found) throw new Error("Request not retained. No full-history lookup is available.");return print(found);
    }
    rows = rows.filter(row => (!flags.active || row.active) && (!flags.failed || row.state !== "cancelled" && (row.state === "failed" || row.error))
      && (!flags.purpose || (row.purpose || "unknown") === flags.purpose) && (!flags.source || row.provider === flags.source) && (!flags.app || (flags.app === "codex" ? ["codex", "codex_app", "codex_cli"].includes(row.application) : row.application === (flags.app === "antigravity" ? "gemini_app" : CLI_CLIENTS[flags.app])))).slice(-(flags.limit || 20));
    return print(flags.format === "json" ? rows : rows.map(row => ({ ...row, state_label: terminalRequestState(row) })), [["request_id", "Request"], ["application", "Client"], ["provider", "Source"], ["model", "Model"], ["route", "Route"], ["state_label", "State"]]);
  }
  if (group === "usage") {
    if (flags.scope === "run") {
      if (flags.purpose || flags.model || flags.days || flags.from || flags.to || flags.time_zone) throw new Error("Model and date filters require --scope all; current-run totals support only --provider.");
      const usage = (await readStatus()).data.runtime_usage;
      if (!usage) throw new Error("Current-run usage is unavailable.");
      return print(flags.provider ? usage.by_provider?.[flags.provider] || { records: 0 } : usage);
    }
    const { summarizeUsageLogs } = await import("./usage-store.mjs");
    const { createUsageQuery } = await import("./usage-query.mjs");
    const selection = createUsageQuery({ provider: flags.provider, model: flags.model, purpose: flags.purpose, days: flags.days, from: flags.from, to: flags.to, timeZone: flags.time_zone });
    const filtered = selection.filters.purpose || selection.filters.model || selection.filters.from || selection.filters.to;
    const summary = await summarizeUsageLogs(undefined, { ...(flags.provider ? { provider: flags.provider } : {}), ...(filtered ? { recordFilter: selection.matches } : {}) });
    summary.filters = selection.filters;
    if (flags.format === "json") return print(summary);
    const { formatUsageSummary } = await import("./usage.mjs");
    return formatUsageSummary(summary, { format: flags.format || "auto", output });
  }
  if (group === "update") {
    const { dashboardUpdateStatus } = await import("./dashboard-updates.mjs");return print(await dashboardUpdateStatus());
  }
  if (group === "config") {
    const changePrivacy = async (operation, extra = {}) => {
      const state = await request({ path: "privacy" });
      if (typeof state.revision !== "string") throw new Error("Update the running CCDX service to manage local masking.");
      return request({ path: "privacy", body: { action: operation, revision: state.revision, ...extra } });
    };
    if (path[1] === "privacy") {
      if (action === "status") return print(await request({ path: "privacy" }));
      if (flags.preview) return print({ operation: action, saved: false, effect: action === "enable" ? "Download and prepare before activation" : "Existing protected replies retain restoration" });
      await confirm(action === "enable" ? "Download and prepare local masking before enabling it?" : action === "remove" ? "Disable masking and delete its downloaded component and model?" : "Disable masking for later requests?");
      return print(await changePrivacy(action));
    }
    const preferenceOptions = { ...options, backupScope: "service" }, local = settingsPreferencesSnapshot(preferenceOptions);
    const effective = live => Object.fromEntries(Object.entries(live.effective || {}).filter(([key]) => Object.hasOwn(local.defaults, key)));
    if (action === "show") {
      if (!flags.effective) return print({ saved: local.values, backup: local.backup, backup_error: local.backup_error });
      const live = await request({ path: "settings" });return print({ saved: local.values, effective: effective(live), nightly_update: live.nightly_update, terminal_mode: live.terminal?.mode ?? "Not observed" });
    }
    let values, operation = "preferences", backup_id;
    if (path[1] === "set") {
      if (!Object.hasOwn(local.defaults, ids.key)) throw new Error("Unknown service preference. Use ccdx config show.");
      let value = ids.value;
      if (typeof local.defaults[ids.key] === "boolean") { if (!["true", "false"].includes(value)) throw new Error("Use true or false for this setting.");value = value === "true"; }
      values = { [ids.key]: value };
    } else if (action === "terminal") {
      const themes = TERMINAL_COLOR_THEMES, pick = (await ask(`Terminal color [${local.values.terminal_color_theme}] (${themes.join("/")}): `)).trim() || local.values.terminal_color_theme;
      if (!themes.includes(pick)) throw new Error("Choose " + themes.join(", ") + ".");values = { terminal_color_theme: pick };
    } else if (["reset", "restore"].includes(action)) {
      operation = action === "reset" ? "reset_preferences" : "restore_preferences";
      backup_id = action === "reset" ? randomUUID() : local.backup?.id;
      if (!backup_id) throw new Error("No service preference backup is available.");
    } else throw new Error("Unsupported settings action.");
    if (values) checkedPreferenceValues(values);
    const preview = { operation, scope: "Service and terminal preferences only; browser colors, accounts, keys, models and chats stay unchanged", values: values || (action === "reset" ? local.defaults : "Current pre-reset service backup"), revision: local.revision };
    if (flags.preview) return print(preview);
    output.write(print(preview) + "\n");
    let running;
    try { running = await readStatus(); } catch (error) {
      if (!/not running/.test(error.message)) throw error;
    }
    if (running && operation !== "preferences") { await connection();requireManagement(); }
    const risk = values?.privacy_enabled ? "Download and prepare local masking before enabling it?" : values?.nightly_updates ? "Overnight updates can interrupt task continuation. Save this preference?" : "Save these service preferences?";
    await confirm(risk);
    if (running && values && Object.hasOwn(values, "privacy_enabled")) return print(await changePrivacy(values.privacy_enabled ? "enable" : "disable"));
    if (running && values && Object.hasOwn(values, "privacy_personal")) return print(await changePrivacy("personal", { personal: values.privacy_personal }));
    const body = { action: operation, revision: local.revision, ...(values ? { values } : { backup_id, scope: "service" }) };
    if (running) { const result = await request({ path: "settings", body });return print({ saved: result.preferences.values, effective: effective(result), nightly_update: result.nightly_update, effect: "Saved; restart requirements are shown in effective state" }); }
    writeSettingsPreferences(body, preferenceOptions);return print({ saved: settingsPreferencesSnapshot(preferenceOptions).values, effect: "Saved for the next CCDX start; no service was started" });
  }
  if (group === "app") {
    if (["gemini", "antigravity"].includes(path[1])) {
      if (["enable", "disable"].includes(action)) {
        const preview = { action, background_source: "GitHub Copilot (all Antigravity summaries, searches and image generation)", ordinary_Gemini_chat: "Google; no routing change" };
        if (flags.preview) return print(preview);
        output.write(print(preview) + "\n");await confirm(action === "enable" ? "Enable this Antigravity-only routing scope?" : "Pause Copilot access? Reopen Gemini afterward to restore its native route.");
      }
      if(action==="models"&&flags.edit){
        const state=await request({path:"gemini"});
        let ids;
        if(flags.file){
          const listed=readFile().models;if(!Array.isArray(listed))throw new Error("Model files require a models array.");
          ids=listed.flatMap(id=>state.model_groups?.find(model=>model.id===id)?.efforts.map(item=>item.id)||[id]);
        }
        else if(Array.isArray(state.model_groups)){
          const groups=state.model_groups,selected=await choose(groups.map(model=>model.name),groups.flatMap((model,index)=>model.efforts.some(item=>item.selected)?[index]:[]));
          ids=[];
          for(const index of selected){
            const model=groups[index],previous=model.efforts.flatMap((item,i)=>item.selected?[i]:[]);
            const efforts=await choose(model.efforts.map(item=>model.name+" / "+item.effort),previous.length?previous:model.efforts.map((_,i)=>i));
            ids.push(...efforts.map(i=>model.efforts[i].id));
          }
        }else ids=(await choose(state.models.map(model=>model.name),state.models.flatMap((model,index)=>model.selected!==false?[index]:[]))).map(index=>state.models[index].id);
        if(!Array.isArray(ids)||new Set(ids).size!==ids.length||ids.some(id=>!state.models.some(model=>model.id===id)))throw new Error("Choose listed Antigravity model IDs.");
        if(flags.preview)return print({models:ids,saved:false});
        await confirm("Save Antigravity model selection? Reopen Gemini afterward to reload it.");
        return print(await request({path:"gemini",body:{action:"models",models:ids}}));
      }
      const state = await request({ path: "gemini", ...(["status", "models"].includes(action) ? {} : { body: { action: flags.preview ? "preview" : action, ...(action === "enable" ? { accept_background_copilot: true } : {}) }, timeoutMs: 20000 }) });
      if(action==="models"&&flags.format!=="json"&&state.model_groups)return print(state.model_groups.map(model=>({model:model.name,id:model.id,source:"GitHub Copilot",context:model.context_window,
        efforts:model.efforts.map(item=>item.effort+(item.selected?" ✓":"")).join(" / ")})),[["model","Model"],["id","ID"],["source","Source"],["context","Context"],["efforts","Reasoning (selected ✓)"]]);
      return print(action === "models" ? state.models : state);
    }
    const graph = await connection(), snapshot = (await readStatus()).data, view = projectTerminalState(snapshot);
    if (action === "list") {
      const clients=[...view.clients];
      if(!clients.some(client=>client.id==="antigravity"))clients.push({id:"antigravity",name:"Antigravity",setup:"Not checked",active:null});
      return print(clients, [["id", "ID"], ["name", "Client"], ["setup", "Setup"], ["active", "Active"]]);
    }
    const id = ids.app ? CLI_CLIENTS[ids.app] : "codex", client = getClient(graph, id), modelPlan = client.model_plan;
    if (!flags.preview && (flags.edit || ["sync", "enable", "disable"].includes(action))) requireManagement();
    const feature = path.length > 3 ? path[2] : null;
    if (feature || action === "status") {
      const settings = id === "codex" && (flags.details || feature) ? await request({ path: "settings" }) : null;
      const preference = settings?.providers?.[client.source || "github"]?.preference || {};
      const reviewId = client.auto_review_model || preference.auto_review_model || preference.model || null;
      const reviewModel = modelPlan?.models.find(model => [model.id, model.public_id, model.route_id].includes(reviewId));
      const details = { predictions: snapshot.client_integrations?.prediction || null, images: settings?.effective?.image_enabled || null,
        auto_review: { model: reviewModel?.id || reviewId, source: reviewModel?.source || client.source, effort: client.auto_review_effort ?? preference.auto_review_effort ?? preference.reasoningEffort ?? "Follows client" }, memory_model: client.memory_model || { model: null } };
      if (feature) return print({ client: "Codex", feature, state: details[{ prediction: "predictions", image: "images", review: "auto_review" }[feature]] });
      const observed = retainedRequests(snapshot).filter(row => id === "codex" ? ["codex", "codex_app", "codex_cli"].includes(row.application) : row.application === id).at(-1);
      return print({ id: ids.app, access: client.enabled ? clientSetup(client) === "Paused" ? "Paused" : "Enabled" : "Disabled", setup: view.clients.find(row => row.id === id)?.setup || clientSetup(client),
        selected_models: Array.isArray(client.deployments) ? client.deployments.length : modelPlan?.models.length ?? null, unavailable_selection: (modelPlan?.unavailable || []).filter(model => !modelPlan?.available.some(candidate => candidate.source === model.source && candidate.id === model.id)),
        app_adoption: view.clients.find(row => row.id === id)?.active > 0 ? "Active gateway request observed; process liveness not checked" : observed ? `Gateway request observed${observed.at || observed.time ? ` at ${observed.at || observed.time}` : ""}; process liveness not checked` : client.observed_at ? `Gateway request observed at ${client.observed_at}; process liveness not checked` : "Not observed",
        active: view.clients.find(row => row.id === id)?.active ?? null, ...(id.startsWith("claude_") && flags.details ? { capability_support: modelPlan?.support, capability_adoption: client.capability_adoption, capability_sync: modelPlan?.sync } : {}), ...(id === "codex" && flags.details ? { features: details, chatgpt_sign_in: "Managed by Codex; not inferred from GitHub credentials" } : {}) });
    }
    if (action === "models" && !flags.edit) {
      if (flags.format === "json") return print(modelPlan);
      return print([...(modelPlan?.models || []).map(model => ({ source: model.source, model: model.display_name || model.id, id: model.id, state: "Selected", default: [model.route_id, model.public_id].includes(modelPlan.default_model) })),
        ...(id === "codex" ? (modelPlan?.image?.models || []).map(model => ({ source: "github", model: model.name, id: model.id, state: modelPlan.image.selected_model === model.id ? "Selected image" : "Image", default: false })) : []),
        ...(id === "codex" && modelPlan?.image?.selected_model && !modelPlan.image.selected_available ? [{ source: "github", model: modelPlan.image.selected_model, id: modelPlan.image.selected_model, state: "Image unavailable; retained", default: false }] : []),
        ...(modelPlan?.unavailable || []).map(model => ({ source: model.source, model: model.id, id: model.id, state: !client.enabled && modelPlan?.available.some(item => item.source === model.source && item.id === model.id) ? "Retained; access disabled" : "Unavailable; retained", default: model.route_id === modelPlan.default_model }))], [["model", "Model"], ["source", "Source"], ["state", "Selection"], ["default", "Default"]]);
    }
    if (action === "sync") {
      const preview = { client: ids.app, models: modelPlan?.models.map(model => ({ source: model.source, model: model.display_name || model.id, id: model.id, context_window: model.capability?.values.context_window ?? null, reasoning_efforts: model.capability?.values.reasoning_efforts ?? null })), unavailable: modelPlan?.unavailable, default_model: modelPlan?.default_model, image: modelPlan?.image,
        current_setup: clientSetup(client), note: "Model/configuration plan only, not a byte-level file diff. Ownership is rechecked on sync; no App is restarted." };
      if (flags.preview) return print(preview);output.write(print(preview) + "\n");await confirm("Write CCDX-owned client settings now?");
      const result = await save({ operation: "sync_client", id, client_revision: client.revision });return print({ client: ids.app, setup: getClient(result, id).setup, image: getClient(result, id).model_plan?.image, app_adoption: "Not verified by writing configuration" });
    }
    if (["enable", "disable"].includes(action)) {
      const enabled = action === "enable", preview = { client: ids.app, access: enabled ? "Enabled" : "Disabled", retained_source: client.source,
        retained_models: client.deployments || "Legacy source binding retained", note: "Only gateway access changes; the client program stays open." };
      if (flags.preview) return print(preview);output.write(print(preview) + "\n");
      await confirm(enabled ? "Enable gateway access with the saved selection?" : "Disable gateway access? Later turns may fail; saved selections are retained.");
      const result = await save({ operation: "client_state", id, enabled, client_revision: client.revision });
      return print({ client: ids.app, setup: getClient(result, id).setup, saved: true, app_adoption: "Not verified" });
    }
    const body = clientBody(client);
    if (action === "models") {
      if (flags.file) {
        const file = readFile();if (Object.keys(file).some(key => !["deployments", "default_model", "auto_sync", "image_model"].includes(key))) throw new Error("Model files allow deployments, default_model, auto_sync and image_model only.");
        if (!Array.isArray(file.deployments)) throw new Error("Model files require an explicit deployments array; use [] to pause access.");
        Object.assign(body, file);if (!body.deployments.length) body.default_model = null;
      } else {
        const available = [...(modelPlan?.available || [])], selected = Array.isArray(client.deployments) ? client.deployments : modelPlan?.models.map(model => ({ source: model.source, model: model.id })) || [];
        for (const old of selected) if (!available.some(row => row.source === old.source && row.id === old.model)) available.push({ source: old.source, id: old.model, unavailable: true });
        const indexes = await choose(available.map(row => `${row.source} / ${row.id}${row.unavailable ? " (unavailable; selection retained)" : ""}`), available.flatMap((row, index) => selected.some(item => item.source === row.source && item.model === row.id) ? [index] : []));
        body.deployments = indexes.map(index => ({ source: available[index].source, model: available[index].id }));
        body.default_model = client.default_model || modelPlan?.default_model || null;
        if (body.deployments.length) {
          const defaults = body.deployments.map(item => deploymentModelId(item.source, item.model));
          output.write(body.deployments.map((item, index) => `${index + 1} ${item.source} / ${item.model}`).join("\n") + "\n");
          const value = (await ask(`Default model number [${Math.max(1, defaults.indexOf(body.default_model) + 1)}]: `)).trim();
          if (value && (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > defaults.length)) throw new Error("Choose a listed default model number.");
          body.default_model = defaults[value ? Number(value) - 1 : Math.max(0, defaults.indexOf(body.default_model))];
        } else body.default_model = null;
      }
      if (id === "codex" && !flags.file && modelPlan?.image?.models?.length) {
        const images = modelPlan.image.models, current = images.findIndex(model => model.id === modelPlan.image.selected_model);
        output.write(images.map((model, i) => `${i + 1} ${model.name || model.id} [Image]`).join("\n") + "\n");
        const answer = (await ask(`Image model number [${Math.max(1, current + 1)}]: `)).trim();
        if (answer && (!/^\d+$/.test(answer) || Number(answer) < 1 || Number(answer) > images.length)) throw new Error("Choose a listed image model number.");
        body.image_model = images[answer ? Number(answer) - 1 : Math.max(0, current)].id;
      }
      if (body.deployments?.some(item => modelPlan?.unavailable.some(row => row.source === item.source && row.id === item.model))) throw new Error("Unavailable selections were kept. Wait for the catalog or explicitly deselect them before saving a changed plan.");
    } else throw new Error("Unsupported client action.");
    const memory = id === "codex" ? client.memory_model?.model : null;
    const memoryModels = [...(modelPlan?.models || []), ...(modelPlan?.available || []), ...(modelPlan?.unavailable || [])].filter(row => [row.id, row.route_id, row.public_id].includes(memory));
    const memoryPairs = new Set(memoryModels.map(row => row.source + "\0" + row.id));
    const memoryMatch = row => memoryPairs.size ? memoryPairs.has(row.source + "\0" + (row.model || row.id)) : [row.model, row.id, row.route_id, row.public_id].includes(memory);
    if (memory && (client.deployments || modelPlan?.models || []).some(memoryMatch) && Array.isArray(body.deployments) && !body.deployments.some(memoryMatch)) {
      output.write(`Warning: ${terminalCell(memory)} is an observed memory dependency; memory writing may fail if it is unselected.\n`);
    }
    const previousModels = client.deployments || modelPlan?.models.map(model => ({ source: model.source, model: model.id })) || [];
    const previousKeys = new Set(previousModels.map(item => item.source + "\0" + item.model));
    const previousDefault = client.default_model || modelPlan?.models.find(model => model.public_id === modelPlan.default_model)?.route_id || null;
    const imageOnly = id === "codex" && body.image_model && body.image_model !== modelPlan?.image?.selected_model
      && body.deployments?.length === previousKeys.size && body.deployments.every(item => previousKeys.has(item.source + "\0" + item.model))
      && body.default_model === previousDefault && (body.auto_sync !== false) === (client.auto_sync !== false);
    const checked = await save({ ...body, operation: "preview_client" });
    output.write(print({ client: ids.app, planned_models: checked.preview?.models.map(model => ({ source: model.source, id: model.id })), change: action, enabled: body.enabled, deployments: body.deployments, default_model: body.default_model }) + "\n");
    if (flags.preview) return "Preview only; no settings changed.";
    await confirm(body.enabled ? "Save this client selection?" : "Disable gateway access? Later turns may fail; the client program stays open.");
    const result = await save(imageOnly ? { operation: "image_model", id: "codex", model: body.image_model, client_revision: client.revision } : body);return print({ client: ids.app, setup: getClient(result, id).setup, saved: true, app_adoption: "Not verified" });
  }
  if (group !== "source") throw new Error("Unknown management command.");
  if (action === "import") {
    if (!flags.file) throw new Error("Supply one explicit JSON file with --file.");
    const preview = previewSourceImport(readFile(), readAccessSettings(options).apis);
    if (!flags.apply || flags.preview) return print(preview);
    const selected = preview.drafts[(flags.select || 0) - 1];
    if (!selected) throw new Error("Review the preview, then use --select NUMBER --apply for one source.");
    output.write(print(selected) + "\n");
    const graph = await connection();requireManagement();
    if (graph.providers.some(source => source.name?.trim().toLowerCase() === selected.config.name.trim().toLowerCase())) throw new Error("A source with this name exists. Edit its settings explicitly, or rename the imported draft.");
    let key;
    if (!selected.config.key_env) {
      if (!flags.key_stdin) throw new Error("Use --key-stdin or a configured key_env; foreign credential values are not copied.");
      key = await readSecretInput(input);
    }
    await confirm("Save this one API without granting client access or selecting models?");
    const result = await save({ operation: "save_api", config: selected.config, allowed: [], ...(key ? { key } : {}) });key = undefined;
    return print({ saved: true, source: result.providers.find(source => source.name === selected.config.name)?.id, authorized_clients: [] });
  }
  let graph = await connection();
  if (!flags.preview && (flags.edit || ["add", "edit", "enable", "disable", "remove"].includes(action))) requireManagement();
  if (action === "list") return print(graph.providers.map(source => ({ id: source.id, name: source.name, enabled: source.enabled, key_saved: source.builtin ? undefined : source.key_saved })), [["id", "ID"], ["name", "Source"], ["enabled", "Enabled"]]);
  const id = ids.source, source = id ? getSource(graph, id) : null;
  if (action === "status" || action === "models" && !flags.refresh) {
    if (action === "models" && source.builtin) {
      return print(await save({ operation: "source_catalog", id }));

    }
    if (action === "models") return print({ source: id, evidence: "Saved API model selection; access not checked", models: source.models });
    const diagnostics = await request({ path: "providers" }), observed = diagnostics.providers.find(provider => provider.id === id);
    return print({ id, name: source.name, saved_enabled: source.enabled, runtime_state: observed?.state || "Not observed", credentials: source.builtin ? observed?.auth : { key_saved: source.key_saved },
      catalog: observed?.models || source.discovery || { count: source.models?.length ?? null, source: "configured" }, health: observed?.health || source.discovery?.health || null, access: "Not inferred from saved credentials or configuration", diagnostic: observed?.catalog_diagnostic || null });
  }
  if (action === "check" || action === "models" && flags.refresh) {
    if (!source.enabled || id === "m365" && graph.m365_state === "disabled") throw new Error("Source is disabled; it was not enabled automatically.");
    if (action === "check" && id === "github") {
      const checked = await request({ path: "account", body: { action: "check" }, timeoutMs: 60000 });
      if (checked.online?.ok === false) throw Object.assign(new Error(`GitHub access check failed: ${checked.online.reason}`), { code: checked.online.reason });return print(checked);
    }
    return print(source.builtin ? await request({ path: `models/live?provider=${encodeURIComponent(id)}`, timeoutMs: 60000 }) : (await save({ operation: "discover", id })).discovered);
  }
  if (action === "access") {
    const integration=id==="github"?await request({path:"gemini?scope=summary"}):null;
    const candidates=[...graph.clients.filter(client=>id!=="github"||client.id==="codex"),...(integration?[{id:"antigravity",name:"Antigravity"}]:[])];
    const current=[...graph.clients.filter(client=>client.allowed.includes(id)).map(client=>client.id),...(integration?.enabled?["antigravity"]:[])];
    if (!flags.edit) return print({ source: id, authorized_clients: current.map(value => value==="antigravity"?value:Object.keys(CLI_CLIENTS).find(key => CLI_CLIENTS[key] === value)), consuming_clients: graph.source_impacts?.[id]?.clients || [] });
    const allowed = flags.apps !== undefined ? flags.apps === "none" ? [] : flags.apps.split(",").map(app => { const client=app==="antigravity"?app:CLI_CLIENTS[app];if (!candidates.some(item=>item.id===client)) throw new Error("Use listed client IDs, or none.");return client; })
      : (await choose(candidates.map(client => client.name||TERMINAL_CLIENT_NAMES[client.id]), candidates.flatMap((client, index) => current.includes(client.id) ? [index] : []))).map(index => candidates[index].id);
    if(new Set(allowed).size!==allowed.length)throw new Error("Choose unique client IDs.");
    output.write(print({ source: id, before: current, after: allowed, effect: integration?"Antigravity uses Copilot for models and background requests; ordinary Gemini chat keeps Google":"Revoked routes are removed; added grants do not select models" }) + "\n");
    if (flags.preview) return "Preview only; access unchanged.";await confirm("Save source authorization for these clients?");
    const base=allowed.filter(value=>value!=="antigravity");
    const result = await save({ operation: "source_access", id, allowed:base, impact_revision: graph.source_impacts[id].revision });
    if(integration&&integration.enabled!==allowed.includes("antigravity")){
      try{await request({path:"gemini",body:{action:allowed.includes("antigravity")?"enable":"disable",...(allowed.includes("antigravity")?{accept_background_copilot:true}:{})}})}
      catch(error){throw new Error("Other client access was saved, but Antigravity access could not be changed: "+error.message)}
    }
    return print({ source: id, authorized_clients: [...result.clients.filter(client => client.allowed.includes(id)).map(client => TERMINAL_CLIENT_NAMES[client.id]),...(allowed.includes("antigravity")?["Antigravity"]:[])], saved: true });
  }
  if (["enable", "disable", "remove"].includes(action)) {
    const impact = graph.source_impacts?.[id];
    if (action === "remove" && (source.builtin || source.enabled || graph.clients.some(client => client.source === id || client.deployments?.some(item => item.source === id)))) throw new Error("Only a disabled API with no selected consumers can be removed. Disable it and review replacements first.");
    let replacements;
    if (action === "disable") {
      replacements = flags.replacements ? JSON.parse(flags.replacements) : {};
      if (!replacements || typeof replacements !== "object" || Array.isArray(replacements)) throw new Error("Replacements must be a JSON object.");
      replacements = Object.fromEntries(Object.entries(replacements).map(([key, value]) => { const client = CLI_CLIENTS[key] || Object.values(CLI_CLIENTS).find(id => id === key);if (!client) throw new Error("Unknown replacement client");return [client, value]; }));
      for (const client of impact?.clients.filter(client => client.needs_replacement) || []) if (!Object.hasOwn(replacements, client.id)) {
        if (flags.yes && !flags.preview) throw new Error("Provide explicit --replacements JSON for every affected client; null pauses it.");
        if (!flags.preview) {
          const value = (await ask(`${TERMINAL_CLIENT_NAMES[client.id]} replacement source ID (none pauses): `)).trim();
          if (!value) throw new Error("Enter a source ID or none; bindings were kept.");replacements[client.id] = value === "none" ? null : value;
        }
      }
    }
    output.write(print({ source: id, action, affected_clients: impact?.clients || [], replacements }) + "\n");
    if (flags.preview) return "Preview only; sources and bindings unchanged.";await confirm(`Apply source ${action}?`);
    const result = await save(action === "remove" ? { operation: "remove_api", id, impact_revision: impact.revision } : { operation: "provider", id, impact_revision: impact.revision, enabled: action === "enable", ...(action === "disable" ? { replacements } : {}) });
    return print({ source: id, ...(action === "remove" ? { removed: true } : { saved_enabled: getSource(result, id).enabled }),
      affected_clients: (impact?.clients || []).map(client => ({ name: TERMINAL_CLIENT_NAMES[client.id], setup: getClient(result, client.id).setup })) });
  }
  if (!["add", "edit"].includes(action) || source?.builtin) throw new Error("This action is available for API sources only.");
  let config, allowed, key;
  if (flags.file) {
    const file = readFile();if (Object.keys(file).some(key => !["config", "allowed"].includes(key))) throw new Error("API files contain config and allowed only; supply keys privately.");
    config = file.config;allowed = file.allowed || [];
    if (!config || typeof config !== "object" || Object.keys(config).some(key => !["name", "base_url", "endpoints", "auth_header", "models", "key_env"].includes(key))) throw new Error("Use API metadata only; keys must use private input or key_env.");
  } else {
    const base = (await ask(`API base URL${source ? ` [${source.base_url}]` : ""}: `)).trim() || source?.base_url;
    const name = (await ask(`Source name${source ? ` [${source.name}]` : ""}: `)).trim() || source?.name;
    const protocols = (await ask(`Interfaces [${Object.keys(source?.endpoints || { responses: 1, messages: 1 }).join(",")}]: `)).trim();
    const enabled = protocols ? protocols.split(",").map(value => value.trim()) : Object.keys(source?.endpoints || { responses: 1, messages: 1 });
    if (!base || !name || enabled.some(value => !["responses", "messages", "chat"].includes(value))) throw new Error("Enter a URL, source name and supported interfaces.");
    const authHeader = (await ask(`API key header [${source?.auth_header || "x-api-key"}] (x-api-key/bearer): `)).trim() || source?.auth_header || "x-api-key";
    config = { ...(source ? apiConfig(source) : { models: [], auth_header: "x-api-key" }), name, base_url: base, auth_header: authHeader,
      endpoints: Object.fromEntries(enabled.map(protocol => [protocol, source?.base_url === base && source.endpoints?.[protocol] || base.replace(/\/+$/, "") + "/" + (protocol === "chat" ? "chat/completions" : protocol)])) };
    allowed = (await choose(graph.clients.map(client => TERMINAL_CLIENT_NAMES[client.id]), graph.clients.flatMap((client, index) => source && client.allowed.includes(id) ? [index] : []), "Authorize clients")).map(index => graph.clients[index].id);
  }
  if (!Array.isArray(allowed) || new Set(allowed).size !== allowed.length || allowed.some(id => !Object.values(CLI_CLIENTS).includes(id))) throw new Error("Use unique, listed client IDs for API authorization.");
  checkedApi({ ...config, id: source?.id || "api_preview", enabled: true, ...(config.key_env ? {} : { secret_ref: "0".repeat(32) }) });
  if (flags.preview) return print({ config, allowed, note: "Key not read; no source or client settings changed" });
  if (!config.key_env) {
    if (flags.key_stdin) key = await readSecretInput(input);
    else if (flags.file) {
      if (!source?.key_saved || new URL(source.base_url).origin !== new URL(config.base_url).origin) throw new Error("Supply --key-stdin or key_env for this API; same-origin saved keys can be kept without re-entry.");
    } else key = await (options.promptSecret || ((question) => hiddenQuestion(input, output, question, { cancelMessage: "API setup cancelled" })))(source ? "API key (hidden; Enter keeps the same-origin key): " : "API key (hidden): ");
    if (source && new URL(source.base_url).origin !== new URL(config.base_url).origin && !key) throw new Error("Changing API origin requires a new key.");
  }
  await confirm("Save this API configuration and client authorization?");
  graph = await save({ operation: "save_api", ...(id ? { id, impact_revision: graph.source_impacts[id].revision } : {}), config, allowed, ...(key ? { key } : {}) });key = undefined;
  const saved = id ? getSource(graph, id) : graph.providers.find(row => !row.builtin && row.name === config.name);
  if (!saved) throw new Error("The source was saved but could not be identified. Review source list.");
  if (flags.file) return print({ source: saved.id, saved: true, models: saved.models.length, note: "Source saved; background catalog discovery is independent of model selection" });
  let catalog;
  try { graph = await save({ operation: "discover", id: saved.id });catalog = graph.discovered || [];allowed = graph.clients.filter(client => client.allowed.includes(saved.id)).map(client => client.id); }
  catch (error) { throw Object.assign(new Error(`Source ${saved.id} was saved, but model lookup failed (${error.code || error.message}). Saved source kept; retry ccdx source ${saved.id} models --refresh.`), { code: "ccdx_source_saved_catalog_unavailable" }); }
  const picks = await choose(catalog.map(model => `${model.id} / ${model.protocols.join(", ")}`), catalog.flatMap((model, index) => saved.models.some(row => row.id === model.id) ? [index] : []), "Select API models");
  const selected = picks.map(index => { const { display, ...model } = catalog[index];return model; });
  for (const model of selected) if (!model.protocols.length) {
    const value = (await ask(`Interfaces for ${model.id} (${Object.keys(config.endpoints).join(", ")}): `)).trim();
    model.protocols = value.split(",").map(item => item.trim());
    if (!value || model.protocols.some(api => !config.endpoints[api])) throw new Error("Choose configured interfaces explicitly; source settings were kept.");
  }
  const result = await save({ operation: "save_api", id: saved.id, impact_revision: graph.source_impacts[saved.id]?.revision, config: { ...apiConfig(getSource(graph, saved.id)), models: selected }, allowed });
  return print({ source: saved.id, selected_models: getSource(result, saved.id).models.length, next: "Choose visible models separately under ccdx app <id> models --edit" });
}
