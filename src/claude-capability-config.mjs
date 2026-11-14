import fs from "node:fs";
import path from "node:path";
import { readBoundedFileSync } from "./bounded-file.mjs";
import { m365Paths, readM365Json } from "./m365-settings.mjs";
import { claudeEffortsExpressible, claudeEffortPrefix } from "./model-capabilities.mjs";
import { claudeModelEntries } from "./claude-models.mjs";
import { claudeClientPaths, reconcileClaudeConfiguration } from "./claude-client-config.mjs";
import { claudeNativeModelHint } from "./claude-app-contract.mjs";
import { claudeRouteAliases } from "./clients/claude-models.mjs";

export function inspectClaudeCapabilitySupport({ platform = process.platform, env = process.env, appVersion, codeVersion, appContract } = {}) {
  if (!codeVersion) for (const directory of (env.PATH || "").split(path.delimiter).filter(Boolean)) {
    try {
      const executable = fs.realpathSync(path.join(directory, platform === "win32" ? "claude.exe" : "claude"));
      codeVersion = /[\\/]versions[\\/](2\.1\.\d+)(?:\.exe)?(?:[\\/]|$)/.exec(executable)?.[1];
      let parent = path.dirname(executable);
      for (let i = 0; !codeVersion && i < 4; i++, parent = path.dirname(parent)) {
        try { const value = JSON.parse(readBoundedFileSync(path.join(parent, "package.json"), { maxBytes: 65536, encoding: "utf8" }));if (value.name === "@anthropic-ai/claude-code") codeVersion = value.version; } catch { /* Native installs may encode their version in the resolved path. */ }
      }
      break;
    } catch { /* No executable in this PATH entry. */ }
  }
  if (!appVersion && platform === "darwin") {
    try { appVersion = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(readBoundedFileSync("/Applications/Claude.app/Contents/Info.plist", { maxBytes: 65536, encoding: "utf8" }))?.[1]; } catch { /* Unknown builds keep the conservative alias. */ }
  }
  // The 3.x and 4.x App schema/host were independently inspected. Other versions keep
  // working catalogs without claiming adoption of undocumented host controls.
  const verified = appContract?.status === "verified";
  return { app_version: appContract?.app_version || appVersion || null, app: verified || /^[34]\./.test(appVersion || ""),
    app_aliases: !verified, ...(appContract ? { app_contract: appContract } : {}),
    code_version: codeVersion || null, code: /^2\.1\./.test(codeVersion || "") && Number(codeVersion.split(".")[2]) >= 293 };
}

export function claudeSupportForSync(support, observations) {
  const rows = Array.isArray(observations?.claude) ? observations.claude : [];
  const app = rows.find(entry => entry.id === "claude_system_claude");
  if (support.app_contract?.status === "verified" && (!app?.version || app.version === support.app_version)) return support;
  return observations?.claude_unrecognized === true || app?.version && !/^[34]\./.test(app.version) ? { ...support, app: false } : support;
}

export function claudeSharedCapabilityPlan({ app = [], code = [], support = {} } = {}) {
  const limitations = [], budgets = {}, caps = [], preserveRefs = [], consumers = [...app.map(model => ({ model, app: true })), ...code.map(model => ({ model, app: false }))];
  let context = 0, output = 0, safeContext = consumers.length > 0, knownAdapters = true;
  for (const { model, app: desktop } of consumers) {
    const entry = claudeModelEntries([model], { desktopAliases: desktop })[0], values = model.capability?.values || {};
    const id = model.public_id || entry.name;
    if (desktop ? !support.app : !support.code) { safeContext = false;knownAdapters = false;limitations.push({ model: model.id, code: "client_version_unknown" });preserveRefs.push(id, ...(model.route_id ? claudeRouteAliases(model, model.route_id, desktop) : []));continue; }
    const window = values.context_window;
    if (!window) { safeContext = false;limitations.push({ model: model.id, code: "context_unknown" }); }
    else if (window < 100000 || window > 1000000) { safeContext = false;limitations.push({ model: model.id, code: "context_range_limited", value: window }); }
    else { context = Math.max(context, window);budgets[id] = Math.min(window, values.max_input_tokens || window); }
    if (budgets[id] && budgets[id] < 100000) { safeContext = false;delete budgets[id];limitations.push({ model: model.id, code: "context_range_limited" }); }
    output = Math.max(output, values.max_output_tokens || 0);
    const efforts = values.reasoning === false ? [] : values.reasoning_efforts || [];
    const hint = desktop ? claudeNativeModelHint(values, support.app_contract) : null;
    const limited=desktop&&/^mythos-ccdx-\d+$/.test(id)?claudeEffortPrefix(values).length!==efforts.length:!claudeEffortsExpressible(values);
    if (efforts.length && !hint && limited) limitations.push({ model: model.id, code: "reasoning_levels_limited" });
    const visibleEfforts = hint ? efforts : desktop && /^mythos-ccdx-\d+$/.test(id) ? claudeEffortPrefix(values) : claudeEffortsExpressible(values) ? efforts : [];
    if (visibleEfforts.length) caps.push(`${id.toLowerCase()}=${["effort", ...(visibleEfforts.includes("xhigh") ? ["xhigh_effort"] : []), ...(visibleEfforts.includes("max") ? ["max_effort"] : [])].join(",")}`);
    else if(efforts.length)preserveRefs.push(id,...(model.route_id?claudeRouteAliases(model,model.route_id,desktop):[]));
    if (values.web_search && !values.web_search.includes("messages")) limitations.push({ model: model.id, code: "search_messages_unavailable" });
  }
  if (!safeContext) context = 0;
  const capabilities = caps.join(";");
  if (capabilities.length > 8000) limitations.push({ code: "capability_list_limited" });
  return { state: consumers.length ? "planned" : "not_configured", context_tokens: context || null,
    preserve_refs: preserveRefs,
    preserve_fields: [...(!knownAdapters ? ["env.CLAUDE_CODE_MAX_CONTEXT_TOKENS", "env.CLAUDE_CODE_GATEWAY_HINT_HEADERS"] : []), ...(!knownAdapters || support.app_contract && !support.app_contract.fields.output ? ["env.CLAUDE_CODE_MAX_OUTPUT_TOKENS"] : [])],
    output_tokens: output && knownAdapters && (!support.app_contract || support.app_contract.fields.output) && consumers.every(({ model }) => model.capability?.values.max_output_tokens) ? Math.min(output, 128000) : null, budgets: context ? budgets : {},
    capabilities: capabilities.length <= 8000 ? capabilities : "", limitations };
}

export function syncClaudeCapabilities(plan, options = {}) {
  if (plan.limitations?.some(item => item.code === "client_version_unknown") && !plan.capabilities) return { state: "partially_preserved", changed: false, preserved: 0, restart_required: false };
  const paths = claudeClientPaths(options), env = options.env || process.env;
  let current = {};try { current = JSON.parse(readBoundedFileSync(paths.code, { maxBytes: 1024 * 1024, encoding: "utf8" })); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const operations = [], add = (keys, value) => operations.push({ file: paths.code, keys, value });
  // An independently configured Code consumer also reads this file. Preserve
  // its host boundary instead of letting the App change it indirectly.
  const base = env.ANTHROPIC_BASE_URL || current.env?.ANTHROPIC_BASE_URL;
  const journal = readM365Json(m365Paths(options).ownership, { version: 1, operations: [] });
  const ownsCodeBase = journal.operations?.some(op => op.file === paths.code && op.keys?.join(".") === "env.ANTHROPIC_BASE_URL" && op.after === base);
  const conflict = Boolean(env.ANTHROPIC_BASE_URL || base && (!/^http:\/\/127\.0\.0\.1:\d+\/anthropic$/.test(base) || !ownsCodeBase));
  const ownedFields = ["env.CLAUDE_CODE_MAX_CONTEXT_TOKENS", "env.CLAUDE_CODE_MAX_OUTPUT_TOKENS", "env.CLAUDE_CODE_MODEL_CAPABILITIES", "env.CLAUDE_CODE_GATEWAY_HINT_HEADERS"];
  if (!conflict) {
    if (plan.state === "planned" && !plan.limitations?.some(item => item.code === "client_version_unknown")) add(["env", "CLAUDE_CODE_GATEWAY_HINT_HEADERS"], "1");
    for (const [key, value] of [["CLAUDE_CODE_MAX_CONTEXT_TOKENS", plan.context_tokens], ["CLAUDE_CODE_MAX_OUTPUT_TOKENS", plan.output_tokens], ["CLAUDE_CODE_MODEL_CAPABILITIES", plan.capabilities]]) {
      let selected=value;
      if(key==="CLAUDE_CODE_MODEL_CAPABILITIES"&&selected){
        const keep=new Set(plan.preserve_refs||[]),previous=String(current.env?.[key]||"").split(";").filter(item=>keep.has(item.split("=")[0]));
        selected=[selected,...previous].join(";");
      }
      if (selected && env[key] === undefined) operations.push({file:paths.code,keys:["env",key],value:String(selected),...(key==="CLAUDE_CODE_MODEL_CAPABILITIES"?{mergeCapabilities:true}:{})});
    }
    for (const [id, value] of Object.entries(plan.budgets)) add(["modelSettings", id, "autoCompactWindow"], value);
  }
  const active = new Set(operations.map(op => op.keys.join(".")));
  const result = reconcileClaudeConfiguration(operations, { ...options,
    restoreSelect: op => op.file === paths.code && !plan.preserve_fields?.includes(op.keys.join(".")) && !plan.preserve_refs?.includes(op.keys[1]) && (ownedFields.includes(op.keys.join(".")) || op.keys[0] === "modelSettings" && op.keys[2] === "autoCompactWindow") && !active.has(op.keys.join(".")) });
  return { state: conflict || result.preserved ? "partially_preserved" : operations.length ? "configured" : "limited",
    changed: result.changed, preserved: result.preserved,
    restart_required: result.changed };
}

export function inspectClaudeCapabilityConfiguration(models, options = {}) {
  let settings = {};
  try { settings = JSON.parse(readBoundedFileSync(claudeClientPaths(options).code, { maxBytes: 1024 * 1024, encoding: "utf8" })); }
  catch (error) { if (error.code !== "ENOENT") return { state: "configuration_unavailable" }; }
  const integer = value => /^\d{1,9}$/.test(String(value)) && Number(value) > 0 ? Number(value) : null;
  return { state: "read", context_tokens: integer(settings.env?.CLAUDE_CODE_MAX_CONTEXT_TOKENS), output_tokens: integer(settings.env?.CLAUDE_CODE_MAX_OUTPUT_TOKENS),
    budgets: Object.fromEntries(models.map(model => [model.public_id, integer(settings.modelSettings?.[model.public_id]?.autoCompactWindow)])) };
}
