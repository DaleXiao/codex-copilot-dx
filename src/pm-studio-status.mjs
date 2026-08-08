import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AUTH_PROFILE_CLAUDE,
  readAuthProfileCredentials,
} from "./auth-profile.mjs";
import { PM_STUDIO_RECIPES } from "./pm-studio-asar.mjs";
import {
  createPmStudioSetupOperations,
  DEFAULT_PM_STUDIO_APP_PATH,
  inspectPmStudioApp,
  PM_STUDIO_CLAUDE_AUTH_COMMAND,
} from "./pm-studio-setup.mjs";
import { checkRunningAdapter } from "./running-adapter.mjs";
import { status } from "./status.mjs";

const PM_RELAY_HOST = "127.0.0.1";
const PM_RELAY_PORT = 2026;

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

export async function inspectPmStudioStatus({
  appPath = DEFAULT_PM_STUDIO_APP_PATH,
  home = os.homedir(),
  recipes = PM_STUDIO_RECIPES,
  operationOverrides = {},
  existsSync = fs.existsSync,
  inspectApp = inspectPmStudioApp,
  readClaudeCredentials = readAuthProfileCredentials,
  checkRunningAdapterFn = checkRunningAdapter,
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
      app = recipe
        ? { ...inspectApp({ appPath, recipe, operations }), recipe: recipe.id }
        : { state: "unsupported", metadata: normalized, issues: [], recipe: "" };
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
  const operational = app.state === "patched" && claude.valid && adapter?.ok === true;
  return { ok: operational, appPath, app, claude, adapter };
}

function appStatusLine(result, commandName) {
  const { app } = result;
  const version = app.metadata ? `${app.metadata.version} build ${app.metadata.build}` : "";
  if (app.state === "patched") return status("ok", `PM Studio ${version} is patched and verified`);
  if (app.state === "clean") return status("warn", `PM Studio ${version} is supported but not patched; run ${commandName} pms setup`);
  if (app.state === "unsupported") return status("err", `PM Studio ${version} has no exact patch recipe; no files will be changed`);
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
  if (result.adapter?.ok) {
    lines.push(status("ok", `PM relay is available at ${result.adapter.baseUrl}`));
  } else if (result.adapter?.incompatible) {
    lines.push(status("err", `The adapter at ${result.adapter.baseUrl} is incompatible; stop it and run ${commandName} start`));
  } else {
    lines.push(status("warn", `PM relay is not running at http://${PM_RELAY_HOST}:${PM_RELAY_PORT}; run ${commandName} start`));
  }
  lines.push(status("info", "Routing: PM GPT uses the PM Studio bearer; eligible Claude chat uses the isolated Claude profile"));
  return lines.join("\n");
}

export async function runPmStudioStatus(options = {}) {
  const result = await inspectPmStudioStatus(options);
  const output = formatPmStudioStatus(result, options);
  (options.log || console.log)(output);
  return { ...result, output };
}
