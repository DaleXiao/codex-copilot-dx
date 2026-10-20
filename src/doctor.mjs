import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { githubTokenPath, managedGithubTokenPath, readGithubTokenMetadata, validateGithubToken } from "./auth.mjs";
import {
  AUTH_PROFILE_CODEX,
  readAuthProfileCredentials,
} from "./auth-profile.mjs";
import { status } from "./status.mjs";
import { buildHeaders, FALLBACK_VSCODE_VERSION, parseApiBase } from "./copilot.mjs";
import { adapterBaseUrl, checkRunningAdapter } from "./running-adapter.mjs";
import { inspectCodexConfig } from "./codex-config-doctor.mjs";
import { inspectPackageUpdateEnvironment } from "./package-update.mjs";
import { inspectCredentialPermissions } from "./credential-permissions.mjs";
import { imageProviderConfigPath } from "./image-provider-config.mjs";
import { terminalCell } from "./terminal-text.mjs";
import { redactDiagnosticText } from "./diagnostic-text.mjs";
import { inspectWindowsCommand } from "./windows-command.mjs";
import { readPredictionSettings } from "./native-prediction-profile.mjs";
import { inspectPredictionEnvironment } from "./native-prediction-environment.mjs";
import { formatPredictionEnvironment } from "./native-prediction-state.mjs";
import { readImageProviderConfig } from "./image-provider-config.mjs";
import { inspectAdapterCompatibility } from "./doctor-compat.mjs";
import { readProviderSettings } from "./provider-settings.mjs";
export { selectCompatibilityModels, inspectAdapterCompatibility } from "./doctor-compat.mjs";

export { inspectCodexConfig };

function localGatewayBaseUrl(host, port) {
  const safeHost = String(host || "127.0.0.1");
  const urlHost = safeHost.includes(":") && !safeHost.startsWith("[") ? `[${safeHost}]` : safeHost;
  return `http://${urlHost}:${port}`;
}

function readText(filePath) {
  try {
    return { ok: true, text: fs.readFileSync(filePath, "utf8") };
  } catch (error) {
    return { ok: false, missing: error?.code === "ENOENT", error };
  }
}

function displayPath(home, filePath) {
  const rel = path.relative(home, filePath);
  if (!rel.startsWith("..") && !path.isAbsolute(rel)) return `~/${rel}`;
  return filePath;
}


export function inspectGitHubToken({ home = os.homedir() } = {}) {
  const filePath = githubTokenPath(home);
  const token = readText(filePath);
  if (!token.ok) {
    return [{ kind: "warn", message: `GitHub token not found at ${displayPath(home, filePath)}` }];
  }
  if (!token.text.trim()) {
    return [{ kind: "err", message: `GitHub token file is empty at ${displayPath(home, filePath)}` }];
  }
  const metadata = readGithubTokenMetadata(home, token.text.trim());
  const account = metadata?.login ? ` for ${metadata.login}` : "";
  return [{ kind: "ok", message: `GitHub token found${account}` }];
}

export function inspectAuthProfiles({ home = os.homedir() } = {}) {
  return [
    ...inspectGitHubToken({ home }),
    { kind: "info", message: githubTokenPath(home) === managedGithubTokenPath(home)
      ? "Codex authentication profile uses the CCDX-owned store" : "Codex authentication profile uses the legacy path" },
  ];
}

function checkedDoctorProfile(profile = AUTH_PROFILE_CODEX) {
  const value = String(profile || AUTH_PROFILE_CODEX).trim().toLowerCase();
  if (value !== AUTH_PROFILE_CODEX) {
    throw new Error(`Doctor profile must be codex: ${profile}`);
  }
  return value;
}

export async function inspectGitHubTokenOnline({
  home = os.homedir(),
  profile = AUTH_PROFILE_CODEX,
  fetchImpl = fetch,
  timeoutMs = 10000,
} = {}) {
  checkedDoctorProfile(profile);
  let credentials;
  try {
    credentials = readAuthProfileCredentials(AUTH_PROFILE_CODEX, { home });
  } catch {
    return [{ kind: "warn", message: "Online Copilot check failed while reading the local credential" }];
  }

  if (!credentials.valid) {
    return [{ kind: "warn", message: "Online Copilot check skipped because the GitHub token is missing" }];
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const validation = await validateGithubToken(credentials.token, {
      fetchImpl,
      signal: controller.signal,
    });
    if (!validation.ok) {
      const statusText = validation.status ? ` (HTTP ${validation.status})` : "";
      return [{
        kind: validation.transient ? "warn" : "err",
        message: `GitHub Copilot authentication failed: ${validation.reason}${statusText}`,
      }];
    }

    const tokenData = validation.copilotTokenData;
    const apiBase = parseApiBase(tokenData);
    const headers = buildHeaders({
      token: tokenData.token,
      version: FALLBACK_VSCODE_VERSION,
      initiator: "user",
      vision: false,
    });
    const modelResp = await fetchImpl(`${apiBase}/models`, { headers, signal: controller.signal });
    if (!modelResp.ok) {
      return [
        { kind: "ok", message: `Copilot access checked: ${validation.login || "current account"}` },
        { kind: "err", message: `Copilot models endpoint returned HTTP ${modelResp.status}` },
      ];
    }
    const models = await modelResp.json();
    const data = Array.isArray(models) ? models : models?.data;
    const validModels = Array.isArray(data) ? data.filter(model => typeof model?.id === "string" && model.id.trim()) : [];
    if (!validModels.length) return [
      { kind: "ok", message: `Copilot access checked: ${validation.login || "current account"}` },
      { kind: "err", message: "Copilot models endpoint returned no valid model directory despite HTTP 200" },
    ];
    return [
      { kind: "ok", message: `Copilot access checked: ${validation.login || "current account"}` },
      { kind: "ok", message: `Copilot listed ${validModels.length} models` },
    ];
  } catch (error) {
    const errorCode = error?.cause?.code || error?.code || "";
    const reason = error?.name === "AbortError"
      ? `timed out after ${timeoutMs}ms`
      : `request failed${errorCode ? ` (${errorCode})` : ""}`;
    return [{ kind: "warn", message: `Online Copilot check failed: ${reason}` }];
  } finally {
    clearTimeout(timer);
  }
}

export async function inspectAuthProfilesOnline(options = {}) {
  return inspectGitHubTokenOnline(options);
}

function connectHost(host) {
  const normalized = String(host || "127.0.0.1").replace(/^\[(.*)\]$/, "$1");
  if (normalized === "0.0.0.0") return "127.0.0.1";
  if (normalized === "::") return "::1";
  return normalized;
}

export function checkAdapterListening({ host = "127.0.0.1", port = 2026, timeoutMs = 500 } = {}) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: connectHost(host), port });
    const done = (ok) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

export async function collectDoctorChecks({
  home = os.homedir(),
  host = "127.0.0.1",
  port = 2026,
  checkAdapter = true,
  configOnly = false,
  checkAdapterListeningFn = checkAdapterListening,
  checkRunningAdapterFn = checkRunningAdapter,
  online = false,
  profile = AUTH_PROFILE_CODEX,
  compat = false,
  fetchImpl = fetch,
  onlineTimeoutMs = 10000,
  compatTimeoutMs = 120000,
  inspectAdapterCompatibilityFn = inspectAdapterCompatibility,
  inspectCodexClientFn,
  inspectUpdateEnvironmentFn = inspectPackageUpdateEnvironment,
  inspectCredentialPermissionsFn = inspectCredentialPermissions,
  env = process.env,
  platform = process.platform,
  inspectWindowsCommandFn = inspectWindowsCommand,
  readPredictionSettingsFn = readPredictionSettings,
  inspectPredictionEnvironmentFn = inspectPredictionEnvironment,
  readImageProviderConfigFn = readImageProviderConfig,
  providerControlFn,
} = {}) {
  if (configOnly) return inspectCodexConfig({ home, env, host, port });
  checkedDoctorProfile(profile);
  let source = "github", sourceError = null;
  try { source = readProviderSettings({ home, env }).codex; } catch (error) { sourceError = error.message; }
  const checks = [
    ...inspectAuthProfiles({ home }).map(check => ({ ...check, id: "github-auth",
      ...(source === "m365" ? { kind: "info", message: `Inactive GitHub provider: ${check.message}` } : {}) })),
    ...inspectCodexConfig({ home, env, host, port }).map(check => ({ ...check, id: "codex-config" })),
    { kind: "info", message: `Runtime: Node ${process.version}, ${platform}/${process.arch}` },
  ];
  if (sourceError) checks.push({ kind: "err", id: "provider", message: sourceError });
  else if (source === "m365") checks.push({ kind: "info", id: "provider", message: "Codex provider: Microsoft 365; GitHub credentials are retained independently" });
  if (platform === "win32") {
    const command = inspectWindowsCommandFn({ platform });
    checks.push({ kind: command.status === "ready" ? "ok" : ["checkout", "not_applicable"].includes(command.status) ? "info" : "warn", id: "windows-command",
      message: `Windows command launcher: ${command.status}; PowerShell policy unchanged`, fix: command.status === "repairable" ? "ccdx.cmd doctor --fix" : undefined });
  }
  try {
    const prediction = readPredictionSettingsFn({ home, env });
    if (!prediction.enabled) checks.push({ kind: "info", message: "Predictions are off; optional routing checks skipped" });
    else if (["darwin", "win32"].includes(platform)) {
      const environment = inspectPredictionEnvironmentFn({ env, platform });
      checks.push({ kind: environment.summary.tls.extra_ca === "unreadable_or_invalid" ? "warn" : "info", message: formatPredictionEnvironment(environment.summary) });
    } else checks.push({ kind: "warn", message: "Native predictions require macOS or Windows; existing settings preserved" });
  } catch { checks.push({ kind: "warn", message: "Prediction environment could not be verified; existing routing and trust settings preserved", fix: "ccdx prediction status" }); }
  try {
    const image = readImageProviderConfigFn({ home, env, strict: true });
    checks.push({ kind: "info", message: image ? "Image generation configured; no provider request was made" : "Image generation is off; optional checks skipped" });
  } catch { checks.push({ kind: "warn", message: "Image provider configuration is invalid; core service is unaffected", fix: "ccdx image-status" }); }
  const updateEnvironment = inspectUpdateEnvironmentFn();
  const updateMessage = updateEnvironment.state === "different" ? "npm update target differs from this CCDX installation; review PATH/prefix before updating"
      : updateEnvironment.state === "unavailable" ? "npm update environment could not be verified; installer settings were not changed"
        : "npm update environment checked (source checkout or matching installation)";
  const updatePaths = ["node", "npm", "package_root", "prefix", "target"]
    .filter(key => updateEnvironment[key]).map(key => `${key}=${terminalCell(updateEnvironment[key])}`).join(" / ");
  checks.push({ kind: updateEnvironment.state === "different" || updateEnvironment.state === "unavailable" ? "warn" : "ok",
    message: `${updateMessage}${updatePaths ? ` / ${updatePaths}` : ""}` });
  for (const [label, file] of [["GitHub token", githubTokenPath(home)], ["Image API key", imageProviderConfigPath({ home })]]) {
    const permissions = inspectCredentialPermissionsFn(file);
    if (permissions === "missing") continue;
    checks.push({ kind: permissions === "review" || permissions === "unavailable" ? "warn" : "ok",
      message: `${label} file permissions: ${permissions}${permissions === "review" ? " (broader access detected; review manually, no ACL was changed)" : ""}` });
  }

  if (online) {
    if (source === "m365") {
      try {
        const control = providerControlFn || (await import("./cli-m365.mjs")).providerControl;
        const result = await control({ host, port, fetchImpl, action: { action: "models", family: "gpt" }, timeoutMs: onlineTimeoutMs });
        const ready = result.state?.m365?.state === "ready" && result.models?.length > 0;
        checks.push({ kind: ready ? "ok" : "warn", id: "provider", message: ready
          ? `Microsoft 365 is ready; ${result.models.length} GPT models available`
          : "Microsoft 365 is not ready; inspect ccdx m365 status. No GitHub fallback was selected" });
      } catch { checks.push({ kind: "warn", id: "provider", message: "Microsoft 365 could not be checked through the running adapter; start ccdx and inspect ccdx m365 status" }); }
    } else if (!sourceError) checks.push(...await inspectAuthProfilesOnline({
      home,
      profile,
      fetchImpl,
      timeoutMs: onlineTimeoutMs,
    }));
  }

  let running = null;
  if (checkAdapter || compat) {
    try {
      running = await checkRunningAdapterFn({ host, port, fetchImpl });
    } catch {
      running = null;
    }
  }

  if (checkAdapter) {
    if (running?.ok) {
      checks.push({ kind: "ok", message: `Adapter ${running.data.version} is listening on ${running.baseUrl}` });
    } else if (running?.incompatible) {
      checks.push({ kind: "warn", message: `Adapter ${running.data?.version || "legacy"} is running at ${running.baseUrl}, but it is incompatible with this CLI` });
    } else {
      const listening = await checkAdapterListeningFn({ host, port });
      checks.push(listening
        ? { kind: "warn", message: `A service is listening on ${localGatewayBaseUrl(host, port)}, but it is not a compatible codex-copilot-dx adapter` }
        : {
          kind: "warn",
          message: `Adapter is not listening on ${localGatewayBaseUrl(host, port)}`,
          fix: "ccdx start",
        });
    }
    const inspectClient = inspectCodexClientFn || (await import("./codex-client-doctor.mjs")).inspectCodexClient;
    checks.push(...await inspectClient({ home, host, port, fetchImpl, running }));
  }

  if (compat) {
    if (!running?.ok) {
      checks.push({ kind: "err", message: "Compatibility checks require a running, version-compatible codex-copilot-dx adapter" });
    } else {
      checks.push(...await inspectAdapterCompatibilityFn({
        host,
        port,
        fetchImpl,
        timeoutMs: compatTimeoutMs,
      }));
    }
  }

  return checks;
}

export async function runDoctor(options = {}) {
  const log = options.log || console.log;
  checkedDoctorProfile(options.profile);
  const flags = [
    options.online ? "--online" : "",
    options.compat ? "--compat" : "",
    options.fix ? "--fix" : "",
  ].filter(Boolean);
  if (!options.json) log(`${options.commandName || "ccdx"} doctor${options.configOnly ? " config" : flags.length ? ` ${flags.join(" ")}` : ""}`);
  let checks = await collectDoctorChecks(options);
  const before = options.fix ? checks : undefined;
  if (options.fix && !options.configOnly) {
    const repair = options.repairDoctorFn || (await import("./doctor-repair.mjs")).repairDoctor;
    const repairs = await repair(options);
    const verified = new Set(repairs.filter(check => ["fixed_verified", "unchanged"].includes(check.result)
      && check.kind !== "warn" && check.kind !== "err").map(check => check.id));
    checks = checks.filter(check => !verified.has(check.id)).concat(repairs);
  }
  for (const check of checks) check.message = terminalCell(redactDiagnosticText(check.message));
  for (const check of before || []) check.message = terminalCell(redactDiagnosticText(check.message));
  if (options.json) {
    log(JSON.stringify({ command: "doctor", repair_requested: options.fix === true, checks, ...(before ? { before_checks: before } : {}) }));
    return checks;
  }
  for (const check of checks) log(status(check.kind, check.message));
  const totals = { ok: 0, warn: 0, err: 0 };
  for (const check of checks) totals[check.kind] = (totals[check.kind] || 0) + 1;
  log(status(totals.err ? "err" : totals.warn ? "warn" : "ok",
    `Summary: ${totals.ok} passed, ${totals.warn} warning(s), ${totals.err} error(s)`));
  for (const fix of new Set(checks.map((check) => check.fix).filter(Boolean))) {
    log(status("info", `Next step: ${fix}`));
  }
  return checks;
}
