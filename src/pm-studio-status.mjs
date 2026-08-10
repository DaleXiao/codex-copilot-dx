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
import { checkRunningAdapter } from "./running-adapter.mjs";
import { status } from "./status.mjs";

const PM_RELAY_HOST = "127.0.0.1";
const PM_RELAY_PORT = 2026;
const PM_RELAY_CAPABILITY = "pm_studio_relay_v1";
const PM_RELAY_ROUTE_NAMES = Object.freeze([
  "pm_models",
  "pm_chat_completions",
  "pm_responses",
  "pm_embeddings",
]);

function selectRecipe(metadata, recipes) {
  return recipes.find((recipe) => recipe.version === String(metadata.version)
    && recipe.build === String(metadata.build)
    && recipe.bundleIdentifier === String(metadata.bundleIdentifier));
}

function safeMessage(error) {
  return String(error?.message || "inspection failed").replace(/\s+/g, " ").trim();
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
  if (!capabilities.has(PM_RELAY_CAPABILITY)) issues.push("PM Studio relay capability is missing");
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
  }
  const operational = app.state === "patched"
    && app.patchRecord?.valid === true
    && claude.valid
    && adapter?.ok === true
    && runtime.ok === true;
  return { ok: operational, appPath, app, claude, adapter, runtime };
}

function appStatusLine(result, commandName) {
  const { app } = result;
  const version = app.metadata ? `${app.metadata.version} build ${app.metadata.build}` : "";
  if (app.state === "patched" && app.patchRecord?.valid === true) {
    return status("ok", `PM Studio ${version} is patched and verified against its installed patch record`);
  }
  if (app.state === "patched") {
    const reason = app.patchRecord?.reason || "installed patch record is missing";
    return status("err", `PM Studio ${version} matches the patch recipe, but its installed patch record is not verified: ${reason}`);
  }
  if (app.state === "clean") return status("warn", `PM Studio ${version} is supported but not patched; run ${commandName} pms setup`);
  if (app.state === "unsupported") return status("err", `PM Studio ${version} has no exact patch recipe; no files will be changed`);
  if (app.state === "drift" && app.patchRecipeMatched) {
    return status("err", `PM Studio ${version} matches the patch recipe, but its installed patch record is not verified: ${app.issues.join("; ")}`);
  }
  if (app.state === "drift") return status("err", `PM Studio ${version} does not match the clean or patched recipe: ${app.issues.join("; ")}`);
  if (app.state === "not_installed") return status("warn", `PM Studio is not installed at ${result.appPath}`);
  return status("err", `PM Studio could not be inspected: ${app.issues.join("; ")}`);
}

export function formatPmStudioStatus(result, { commandName = "ccdx" } = {}) {
  const lines = [
    `${commandName} pms status`,
    appStatusLine(result, commandName),
  ];
  if (result.claude.valid) {
    const account = result.claude.login ? ` for ${result.claude.login}` : "";
    lines.push(status("ok", `Isolated Claude profile is valid${account}`));
  } else {
    const reason = result.claude.configured && result.claude.reason ? ` (${result.claude.reason})` : "";
    lines.push(status("err", `Isolated Claude profile is not ready${reason}; run ${PM_STUDIO_CLAUDE_AUTH_COMMAND}`));
  }
  if (result.adapter?.ok && result.runtime?.ok) {
    lines.push(status("ok", `PM relay and isolated Claude routing are verified at ${result.adapter.baseUrl}`));
  } else if (result.adapter?.ok) {
    const reason = result.runtime?.issues?.join("; ") || "runtime status is unavailable";
    lines.push(status("err", `The adapter is running at ${result.adapter.baseUrl}, but PM relay routing is not ready: ${reason}; stop it and run ${commandName} start`));
  } else if (result.adapter?.incompatible) {
    lines.push(status("err", `The adapter at ${result.adapter.baseUrl} is incompatible; stop it and run ${commandName} start`));
  } else {
    lines.push(status("warn", `PM relay is not running at http://${PM_RELAY_HOST}:${PM_RELAY_PORT}; run ${commandName} start`));
  }
  if (result.runtime?.ok) {
    lines.push(status("info", "Routing: PM GPT uses the PM Studio bearer; eligible Claude chat uses the isolated Claude profile"));
  } else {
    lines.push(status("info", "Expected routing: PM GPT uses the PM Studio bearer; eligible Claude chat uses the isolated Claude profile"));
  }
  return lines.join("\n");
}

export async function runPmStudioStatus(options = {}) {
  const result = await inspectPmStudioStatus(options);
  const output = formatPmStudioStatus(result, options);
  (options.log || console.log)(output);
  return { ...result, output };
}
