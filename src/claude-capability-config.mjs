import fs from "node:fs";
import path from "node:path";
import { readBoundedFileSync } from "./bounded-file.mjs";
import { m365Paths, readM365Json } from "./m365-settings.mjs";
import { claudeEffortsExpressible } from "./model-capabilities.mjs";
import { claudeModelEntries } from "./claude-models.mjs";
import { claudeClientPaths, reconcileClaudeConfiguration } from "./claude-client-config.mjs";

export function inspectClaudeCapabilitySupport({ platform = process.platform, env = process.env, appVersion, codeVersion } = {}) {
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
  // The 3.x App schema/host was independently inspected. Other versions keep
  // working catalogs without claiming adoption of undocumented host controls.
  return { app_version: appVersion || null, app: /^3\./.test(appVersion || ""), code_version: codeVersion || null, code: /^2\.1\./.test(codeVersion || "") && Number(codeVersion.split(".")[2]) >= 293 };
}

export function claudeSharedCapabilityPlan({ app = [], code = [], support = {} } = {}) {
  const limitations = [], budgets = {}, caps = [], consumers = [...app.map(model => ({ model, app: true })), ...code.map(model => ({ model, app: false }))];
  let context = 0, output = 0, safeContext = consumers.length > 0, knownAdapters = true;
  for (const { model, app: desktop } of consumers) {
    const entry = claudeModelEntries([model], { desktopAliases: desktop })[0], values = model.capability?.values || {};
    const id = model.public_id || entry.name;
    if (desktop ? !support.app : !support.code) { safeContext = false;knownAdapters = false;limitations.push({ model: model.id, code: "client_version_unknown" });continue; }
    const window = values.context_window;
    if (!window) { safeContext = false;limitations.push({ model: model.id, code: "context_unknown" }); }
    else if (window < 100000 || window > 1000000) { safeContext = false;limitations.push({ model: model.id, code: "context_range_limited", value: window }); }
    else { context = Math.max(context, window);budgets[id] = Math.min(window, values.max_input_tokens || window); }
    if (budgets[id] && budgets[id] < 100000) { safeContext = false;delete budgets[id];limitations.push({ model: model.id, code: "context_range_limited" }); }
    output = Math.max(output, values.max_output_tokens || 0);
    const efforts = values.reasoning === false ? [] : values.reasoning_efforts || [];
    if (efforts.length && !claudeEffortsExpressible(values)) limitations.push({ model: model.id, code: "reasoning_levels_limited" });
    if (claudeEffortsExpressible(values)) caps.push(`${id.toLowerCase()}=${["effort", ...(efforts.includes("xhigh") ? ["xhigh_effort"] : []), ...(efforts.includes("max") ? ["max_effort"] : [])].join(",")}`);
    if (values.web_search && !values.web_search.includes("messages")) limitations.push({ model: model.id, code: "search_messages_unavailable" });
  }
  if (!safeContext) context = 0;
  const capabilities = caps.join(";");
  if (capabilities.length > 8000) limitations.push({ code: "capability_list_limited" });
  return { state: consumers.length ? "planned" : "not_configured", context_tokens: context || null,
    output_tokens: output && knownAdapters && consumers.every(({ model }) => model.capability?.values.max_output_tokens) ? Math.min(output, 128000) : null, budgets: context ? budgets : {},
    capabilities: capabilities.length <= 8000 ? capabilities : "", limitations };
}

export function syncClaudeCapabilities(plan, options = {}) {
  if (plan.limitations?.some(item => item.code === "client_version_unknown")) return { state: "partially_preserved", changed: false, preserved: 0, restart_required: false };
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
  const ownedFields = ["env.CLAUDE_CODE_MAX_CONTEXT_TOKENS", "env.CLAUDE_CODE_MAX_OUTPUT_TOKENS", "env.CLAUDE_CODE_MODEL_CAPABILITIES"];
  if (!conflict) {
    for (const [key, value] of [["CLAUDE_CODE_MAX_CONTEXT_TOKENS", plan.context_tokens], ["CLAUDE_CODE_MAX_OUTPUT_TOKENS", plan.output_tokens], ["CLAUDE_CODE_MODEL_CAPABILITIES", plan.capabilities]]) {
      if (value && env[key] === undefined) add(["env", key], String(value));
    }
    for (const [id, value] of Object.entries(plan.budgets)) add(["modelSettings", id, "autoCompactWindow"], value);
  }
  const active = new Set(operations.map(op => op.keys.join(".")));
  const restored = reconcileClaudeConfiguration([], { ...options, restore: true,
    selectOperation: op => op.file === paths.code && (ownedFields.includes(op.keys.join(".")) || op.keys[0] === "modelSettings" && op.keys[2] === "autoCompactWindow") && !active.has(op.keys.join(".")) });
  const result = reconcileClaudeConfiguration(operations, options);
  return { state: conflict || result.preserved || restored.preserved ? "partially_preserved" : operations.length ? "configured" : "limited",
    changed: result.changed || restored.changed, preserved: result.preserved + restored.preserved,
    restart_required: result.changed || restored.changed };
}

export function inspectClaudeCapabilityConfiguration(models, options = {}) {
  let settings = {};
  try { settings = JSON.parse(readBoundedFileSync(claudeClientPaths(options).code, { maxBytes: 1024 * 1024, encoding: "utf8" })); }
  catch (error) { if (error.code !== "ENOENT") return { state: "configuration_unavailable" }; }
  const integer = value => /^\d{1,9}$/.test(String(value)) && Number(value) > 0 ? Number(value) : null;
  return { state: "read", context_tokens: integer(settings.env?.CLAUDE_CODE_MAX_CONTEXT_TOKENS), output_tokens: integer(settings.env?.CLAUDE_CODE_MAX_OUTPUT_TOKENS),
    budgets: Object.fromEntries(models.map(model => [model.public_id, integer(settings.modelSettings?.[model.public_id]?.autoCompactWindow)])) };
}
