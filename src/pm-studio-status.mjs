import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AUTH_PROFILE_CLAUDE,
  readAuthProfileCredentials,
} from "./auth-profile.mjs";
import { PM_STUDIO_RECIPES } from "./pm-studio-asar.mjs";
import {
  assertPatchedBinaryRecord,
  createPmStudioSetupOperations,
  DEFAULT_PM_STUDIO_APP_PATH,
  inspectPmStudioApp,
  PM_STUDIO_CLAUDE_AUTH_COMMAND,
  pmStudioBackupRoot,
  pmStudioPatchManifestPath,
} from "./pm-studio-setup.mjs";
import { readAdapterStatus } from "./cli-status.mjs";
import {
  PM_STUDIO_RELAY_MARKER_HEADER,
  PM_STUDIO_RELAY_MARKER_VALUE,
  PM_STUDIO_RELAY_PREFIX,
} from "./pm-studio-relay.mjs";
import { checkRunningAdapter } from "./running-adapter.mjs";
import { status } from "./status.mjs";
import {
  cliOutputFormat,
  cliOutputWidth,
  formatResponsiveCliTable,
  terminalCell,
} from "./cli-table.mjs";

const PM_RELAY_HOST = "127.0.0.1";
const PM_RELAY_PORT = 2026;
const PM_RELAY_PROBE_TIMEOUT_MS = 500;
const PM_RELAY_CAPABILITY = "pm_studio_split_origin_v1";
const PM_RELAY_ROUTE_NAMES = Object.freeze([
  "pm_models",
  "pm_chat_completions",
]);

function selectRecipe(metadata, recipes) {
  return recipes.find((recipe) => recipe.version === String(metadata.version)
    && recipe.build === String(metadata.build)
    && recipe.bundleIdentifier === String(metadata.bundleIdentifier));
}

function safeMessage(error) {
  return String(error?.message || "inspection failed").replace(/\s+/g, " ").trim();
}

export async function probePmStudioRelay({
  baseUrl,
  fetchImpl = fetch,
  timeoutMs = PM_RELAY_PROBE_TIMEOUT_MS,
} = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(new URL(`${PM_STUDIO_RELAY_PREFIX}/models`, baseUrl).href, {
      method: "GET",
      headers: { Accept: "application/json" },
      redirect: "error",
      signal: controller.signal,
    });
    const result = {
      status: response.status,
      marker: response.headers.get(PM_STUDIO_RELAY_MARKER_HEADER) || "",
    };
    await response.body?.cancel().catch(() => {});
    return result;
  } finally {
    clearTimeout(timer);
  }
}

function inspectClaudeProfile(home, readCredentials) {
  try {
    const credentials = readCredentials(AUTH_PROFILE_CLAUDE, { home });
    return {
      configured: credentials.configured === true,
      valid: credentials.valid === true,
      reason: credentials.reason || "",
      login: credentials.identity?.login || "",
    };
  } catch (error) {
    return { configured: true, valid: false, reason: safeMessage(error), login: "" };
  }
}

function inspectAdapterRuntime(adapter, runtimeStatus) {
  const data = runtimeStatus?.data;
  const health = adapter?.data;
  const issues = [];
  if (!data || typeof data !== "object") {
    return { ok: false, baseUrl: runtimeStatus?.baseUrl || adapter?.baseUrl, data: null, issues: ["runtime status payload is missing"] };
  }
  if (data.version !== health?.version
    || data.protocol_version !== health?.protocol_version
    || data.instance_id !== health?.instance_id
    || data.pid !== health?.pid) {
    issues.push("health and runtime status do not describe the same adapter instance");
  }
  const capabilities = new Set(Array.isArray(data.capabilities) ? data.capabilities : []);
  if (!capabilities.has(PM_RELAY_CAPABILITY)) issues.push("PM Studio split-origin relay capability is missing");
  if (data.profiles?.claude?.mode !== "isolated") issues.push("Claude profile mode is not isolated");
  if (data.profiles?.claude?.profile_current !== true) {
    issues.push("running Claude credentials do not match the current isolated profile");
  }
  if (data.routing?.responses !== "codex") issues.push("/v1/responses is not routed to Codex");
  if (data.routing?.messages !== "claude") issues.push("/v1/messages is not routed to Claude");
  const routes = data.requests?.by_route;
  for (const routeName of PM_RELAY_ROUTE_NAMES) {
    if (!routes || typeof routes !== "object" || !Object.hasOwn(routes, routeName)) {
      issues.push(`runtime status does not expose ${routeName}`);
    }
  }
  return {
    ...runtimeStatus,
    ok: issues.length === 0,
    issues,
  };
}

function inspectRelayProbe(runtime, probe) {
  const relayProbe = {
    status: probe?.status,
    marker: String(probe?.marker || ""),
  };
  const issues = [...runtime.issues];
  if (relayProbe.status !== 401) {
    issues.push(`PM Studio relay probe returned HTTP ${relayProbe.status ?? "unknown"}; expected 401`);
  }
  if (relayProbe.marker !== PM_STUDIO_RELAY_MARKER_VALUE) {
    issues.push("PM Studio relay compatibility marker is missing or incompatible");
  }
  return { ...runtime, relayProbe, ok: issues.length === 0, issues };
}

export async function inspectPmStudioStatus({
  appPath = DEFAULT_PM_STUDIO_APP_PATH,
  home = os.homedir(),
  backupRoot = pmStudioBackupRoot(home),
  recipes = PM_STUDIO_RECIPES,
  operationOverrides = {},
  existsSync = fs.existsSync,
  inspectApp = inspectPmStudioApp,
  verifyPatchRecord = assertPatchedBinaryRecord,
  readClaudeCredentials = readAuthProfileCredentials,
  checkRunningAdapterFn = checkRunningAdapter,
  readAdapterStatusFn = readAdapterStatus,
  probePmStudioRelayFn = probePmStudioRelay,
} = {}) {
  const operations = createPmStudioSetupOperations(operationOverrides);
  let app;
  if (!existsSync(appPath)) {
    app = { state: "not_installed", metadata: null, issues: [] };
  } else {
    try {
      const metadata = operations.readBundleMetadata({
        appPath,
        infoPlistPath: path.join(appPath, "Contents/Info.plist"),
        processRunner: operations.processRunner,
      });
      const normalized = {
        version: String(metadata.version),
        build: String(metadata.build),
        bundleIdentifier: String(metadata.bundleIdentifier),
      };
      const recipe = selectRecipe(normalized, recipes);
      if (recipe) {
        app = { ...inspectApp({ appPath, recipe, operations }), recipe: recipe.id };
        if (app.state === "patched") {
          const manifestPath = pmStudioPatchManifestPath({ home, backupRoot, recipe });
          try {
            verifyPatchRecord({ inspection: app, manifestPath, recipe });
            app.patchRecord = { valid: true, manifestPath, reason: "" };
          } catch (error) {
            const reason = safeMessage(error);
            app.patchRecipeMatched = true;
            app.patchRecord = { valid: false, manifestPath, reason };
            app.state = "drift";
            app.issues = [...(Array.isArray(app.issues) ? app.issues : []), reason];
          }
        }
      } else {
        app = { state: "unsupported", metadata: normalized, issues: [], recipe: "" };
      }
    } catch (error) {
      app = { state: "error", metadata: null, issues: [safeMessage(error)], recipe: "" };
    }
  }

  const claude = inspectClaudeProfile(home, readClaudeCredentials);
  let adapter;
  try {
    adapter = await checkRunningAdapterFn({ host: PM_RELAY_HOST, port: PM_RELAY_PORT });
  } catch (error) {
    adapter = { ok: false, error };
  }
  let runtime = { ok: false, baseUrl: adapter?.baseUrl, data: null, issues: ["adapter health check failed"] };
  if (adapter?.ok === true) {
    try {
      runtime = inspectAdapterRuntime(adapter, await readAdapterStatusFn({
        host: PM_RELAY_HOST,
        port: PM_RELAY_PORT,
      }));
    } catch (error) {
      runtime = { ok: false, baseUrl: adapter.baseUrl, data: null, issues: [safeMessage(error)] };
    }
    if (runtime.data) {
      try {
        runtime = inspectRelayProbe(runtime, await probePmStudioRelayFn({ baseUrl: adapter.baseUrl }));
      } catch (error) {
        runtime = {
          ...runtime,
          ok: false,
          relayProbe: null,
          issues: [...runtime.issues, `PM Studio relay probe failed: ${safeMessage(error)}`],
        };
      }
    }
  }
  const operational = app.state === "patched"
    && app.patchRecord?.valid === true
    && claude.valid
    && adapter?.ok === true
    && runtime.ok === true;
  return { ok: operational, appPath, app, claude, adapter, runtime };
}

function appStatusItem(result, commandName) {
  const { app } = result;
  const version = app.metadata ? `${app.metadata.version} build ${app.metadata.build}` : "";
  if (app.state === "patched" && app.patchRecord?.valid === true) {
    return { kind: "ok", component: "App patch", detail: `${version}; patched and verified`, message: `PM Studio ${version} is patched and verified against its installed patch record` };
  }
  if (app.state === "patched") {
    const reason = app.patchRecord?.reason || "installed patch record is missing";
    return { kind: "err", component: "App patch", detail: `${version}; patch record not verified`, message: `PM Studio ${version} matches the patch recipe, but its installed patch record is not verified: ${reason}` };
  }
  if (app.state === "legacy") {
    return { kind: "err", component: "App patch", detail: `${version}; legacy global-origin patch`, message: `PM Studio ${version} has a legacy global-origin patch; run ${commandName} pms setup to migrate` };
  }
  if (app.state === "clean") return { kind: "warn", component: "App patch", detail: `${version}; supported, not patched`, message: `PM Studio ${version} is supported but not patched; run ${commandName} pms setup` };
  if (app.state === "unsupported") return { kind: "err", component: "App patch", detail: `${version}; unsupported version`, message: `PM Studio ${version} has no exact patch recipe; no files will be changed` };
  if (app.state === "drift" && app.patchRecipeMatched) {
    return { kind: "err", component: "App patch", detail: `${version}; patch record drift`, message: `PM Studio ${version} matches the patch recipe, but its installed patch record is not verified: ${app.issues.join("; ")}` };
  }
  if (app.state === "drift") return { kind: "err", component: "App patch", detail: `${version}; integrity drift`, message: `PM Studio ${version} does not match the clean or patched recipe: ${app.issues.join("; ")}` };
  if (app.state === "not_installed") return { kind: "warn", component: "App patch", detail: "not installed", message: `PM Studio is not installed at ${result.appPath}` };
  return { kind: "err", component: "App patch", detail: "inspection failed", message: `PM Studio could not be inspected: ${app.issues.join("; ")}` };
}

function pmStudioStatusItems(result, commandName) {
  const items = [appStatusItem(result, commandName)];
  if (result.claude.valid) {
    const account = result.claude.login ? ` for ${result.claude.login}` : "";
    const detail = result.claude.login ? `${result.claude.login}; isolated profile valid` : "isolated profile valid";
    items.push({ kind: "ok", component: "Claude profile", detail, message: `Isolated Claude profile is valid${account}` });
  } else {
    const reason = result.claude.configured && result.claude.reason ? ` (${result.claude.reason})` : "";
    items.push({ kind: "err", component: "Claude profile", detail: "not ready", message: `Isolated Claude profile is not ready${reason}; run ${PM_STUDIO_CLAUDE_AUTH_COMMAND}` });
  }
  if (result.adapter?.ok && result.runtime?.ok) {
    items.push({ kind: "ok", component: "PM relay", detail: `verified at ${result.adapter.baseUrl}`, message: `PM model discovery and isolated Claude routing are verified at ${result.adapter.baseUrl}` });
  } else if (result.adapter?.ok) {
    const reason = result.runtime?.issues?.join("; ") || "runtime status is unavailable";
    items.push({ kind: "err", component: "PM relay", detail: "running but routing not ready", message: `The adapter is running at ${result.adapter.baseUrl}, but PM relay routing is not ready: ${reason}; stop it and run ${commandName} start` });
  } else if (result.adapter?.incompatible) {
    items.push({ kind: "err", component: "PM relay", detail: `incompatible at ${result.adapter.baseUrl}`, message: `The adapter at ${result.adapter.baseUrl} is incompatible; stop it and run ${commandName} start` });
  } else {
    items.push({ kind: "warn", component: "PM relay", detail: `not running at ${PM_RELAY_HOST}:${PM_RELAY_PORT}`, message: `PM relay is not running at http://${PM_RELAY_HOST}:${PM_RELAY_PORT}; run ${commandName} start` });
  }
  if (result.runtime?.ok) {
    items.push({ kind: "info", component: "Routing", detail: "GPT -> native official; models/Claude -> local", message: "Routing: PM GPT uses its native official GitHub Copilot path; model discovery and eligible Claude chat use the local CCDX relay" });
  } else {
    items.push({ kind: "info", component: "Routing", detail: "expected: GPT -> native official; models/Claude -> local", message: "Expected routing: PM GPT uses its native official GitHub Copilot path; model discovery and eligible Claude chat use the local CCDX relay" });
  }
  return items;
}

function formatPmStudioStatusPlain(result, commandName, { sanitize = false } = {}) {
  const lines = [
    `${commandName} pms status`,
    ...pmStudioStatusItems(result, commandName).map((item) => status(item.kind, item.message)),
  ];
  return (sanitize ? lines.map((line) => terminalCell(line, { fallback: "" })) : lines).join("\n");
}

function tableState(kind) {
  return `[${String(kind).toUpperCase()}]`;
}

function formatPmStudioStatusTable(result, { commandName, output }) {
  const items = pmStudioStatusItems(result, commandName);
  const rows = items.map((item) => ({
    component: item.component,
    state: tableState(item.kind),
    detail: item.detail,
  }));
  const table = formatResponsiveCliTable({
    columns: [
      { key: "component", label: "COMPONENT" },
      { key: "state", label: "STATE" },
      { key: "detail", label: "DETAIL" },
    ],
    compactColumns: [
      { key: "component", label: "COMPONENT" },
      { key: "state", label: "STATE" },
    ],
    rows,
    width: cliOutputWidth(output),
  });
  const lines = [`${commandName} pms status`, table.output];
  const details = table.compact ? items : items.filter((item) => item.kind === "warn" || item.kind === "err");
  if (details.length) {
    lines.push("", "Details:", ...details.map((item) => terminalCell(status(item.kind, item.message), { fallback: "" })));
  }
  return { output: lines.join("\n"), overflow: table.overflow };
}

export function formatPmStudioStatus(result, {
  commandName = "ccdx",
  format = "plain",
  output = process.stdout,
} = {}) {
  if (cliOutputFormat(format, output) === "plain") {
    return formatPmStudioStatusPlain(result, commandName);
  }
  const table = formatPmStudioStatusTable(result, { commandName, output });
  return format === "auto" && table.overflow
    ? formatPmStudioStatusPlain(result, commandName, { sanitize: true })
    : table.output;
}

export async function runPmStudioStatus(options = {}) {
  const result = await inspectPmStudioStatus(options);
  const output = formatPmStudioStatus(result, options);
  (options.log || console.log)(output);
  return { ...result, output };
}
