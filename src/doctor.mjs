import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { githubTokenPath, readGithubTokenMetadata, validateGithubToken } from "./auth.mjs";
import {
  AUTH_PROFILE_CODEX,
  readAuthProfileCredentials,
} from "./auth-profile.mjs";
import { status } from "./status.mjs";
import { buildHeaders, FALLBACK_VSCODE_VERSION, parseApiBase } from "./copilot.mjs";
import { adapterBaseUrl, checkRunningAdapter } from "./running-adapter.mjs";
import { CODEX_AUTO_REVIEW_MODEL } from "./models.mjs";

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

function tomlString(content, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^\\s*${escaped}\\s*=\\s*"([^"]*)"`, "m").exec(content);
  return match?.[1] || "";
}

function displayPath(home, filePath) {
  const rel = path.relative(home, filePath);
  if (!rel.startsWith("..") && !path.isAbsolute(rel)) return `~/${rel}`;
  return filePath;
}

function valueLabel(value) {
  return value ? `"${value}"` : "missing";
}

function copilotModelData(models) {
  const data = Array.isArray(models) ? models : models?.data;
  return Array.isArray(data) ? data : [];
}

function modelEndpoints(model) {
  return Array.isArray(model?.supported_endpoints) ? model.supported_endpoints : [];
}

export function selectCompatibilityModels(models) {
  const candidates = copilotModelData(models)
    .filter((model) => model?.model_picker_enabled !== false)
    .filter((model) => {
      const id = String(model?.id || "");
      const endpoints = modelEndpoints(model);
      return id.startsWith("gpt-")
        && (endpoints.includes("/responses") || endpoints.includes("/v1/responses"));
    });
  const responsesOnly = [...candidates].reverse()
    .find((model) => !modelEndpoints(model).includes("/chat/completions"));
  return { responsesModel: String((responsesOnly || candidates[0])?.id || "") };
}

async function fetchTextWithTimeout(fetchImpl, url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetchImpl(url, { ...init, signal: controller.signal });
    return { resp, text: await resp.text() };
  } finally {
    clearTimeout(timer);
  }
}

function responseFailure(resp, text) {
  const detail = String(text || "").replace(/\s+/g, " ").trim().slice(0, 240);
  return new Error(`HTTP ${resp.status}${detail ? `: ${detail}` : ""}`);
}

async function compatibilityRequest(fetchImpl, url, body, timeoutMs) {
  const { resp, text } = await fetchTextWithTimeout(fetchImpl, url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: body.stream ? "text/event-stream" : "application/json" },
    body: JSON.stringify(body),
  }, timeoutMs);
  if (!resp.ok) throw responseFailure(resp, text);
  return text;
}

async function runCompatibilityCheck(checks, label, task) {
  const started = Date.now();
  try {
    const value = await task();
    checks.push({ kind: "ok", message: `${label} passed (${Date.now() - started}ms)` });
    return value;
  } catch (error) {
    const reason = error?.name === "AbortError" ? "timed out" : error?.message || "unknown error";
    checks.push({ kind: "err", message: `${label} failed: ${reason}` });
    return null;
  }
}

function parseResponseObject(text) {
  const response = JSON.parse(text);
  if (!response?.id || !Array.isArray(response.output)) throw new Error("response body is missing id or output");
  return response;
}

function parseCompactionResponse(text) {
  const response = parseResponseObject(text);
  if (response.object !== "response.compaction"
    || !response.output.some((item) => item?.type === "compaction")) {
    throw new Error("response body is missing valid compaction state");
  }
  return response;
}

export async function inspectAdapterCompatibility({
  host = "127.0.0.1",
  port = 2026,
  fetchImpl = fetch,
  timeoutMs = 120000,
} = {}) {
  const baseUrl = localGatewayBaseUrl(connectHost(host), port);
  const checks = [];
  const models = await runCompatibilityCheck(checks, "Compatibility model discovery", async () => {
    const { resp, text } = await fetchTextWithTimeout(fetchImpl, `${baseUrl}/v1/models`, { headers: { Accept: "application/json" } }, timeoutMs);
    if (!resp.ok) throw responseFailure(resp, text);
    const parsed = JSON.parse(text);
    if (!copilotModelData(parsed).length) throw new Error("model list is empty");
    return parsed;
  });
  if (!models) return checks;

  const { responsesModel } = selectCompatibilityModels(models);
  if (!responsesModel) {
    checks.push({ kind: "err", message: "Compatibility Responses check failed: no GPT model advertises /responses" });
    return checks;
  }

  await runCompatibilityCheck(checks, "Codex Auto-review", async () => {
    const text = await compatibilityRequest(fetchImpl, `${baseUrl}/v1/responses`, {
      model: CODEX_AUTO_REVIEW_MODEL,
      stream: false,
      input: "Reply with OK only.",
    }, timeoutMs);
    parseResponseObject(text);
  });

  const firstResponse = await runCompatibilityCheck(checks, `Native Responses (${responsesModel})`, async () => {
    const text = await compatibilityRequest(fetchImpl, `${baseUrl}/v1/responses`, {
      model: responsesModel,
      stream: false,
      input: "Reply with OK only.",
    }, timeoutMs);
    return parseResponseObject(text);
  });

  if (firstResponse) {
    await runCompatibilityCheck(checks, "Responses stream and history compatibility", async () => {
      const text = await compatibilityRequest(fetchImpl, `${baseUrl}/v1/responses`, {
        model: responsesModel,
        stream: true,
        previous_response_id: firstResponse.id,
        input: "Reply with OK again.",
      }, timeoutMs);
      if (!/^event:\s*response\.completed\s*$/m.test(text)) throw new Error("stream did not contain response.completed");
    });
  }

  await runCompatibilityCheck(checks, "Responses compact", async () => {
    const text = await compatibilityRequest(fetchImpl, `${baseUrl}/v1/responses/compact`, {
      model: responsesModel,
      stream: false,
      input: "Compact this short context.",
    }, timeoutMs);
    parseCompactionResponse(text);
  });

  return checks;
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
    { kind: "ok", message: "Codex authentication profile uses the legacy path" },
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
        { kind: "ok", message: `GitHub Copilot access verified for ${validation.login || "current account"}` },
        { kind: "err", message: `Copilot models endpoint returned HTTP ${modelResp.status}` },
      ];
    }
    const models = await modelResp.json();
    const data = Array.isArray(models) ? models : models?.data;
    return [
      { kind: "ok", message: `GitHub Copilot access verified for ${validation.login || "current account"}` },
      { kind: "ok", message: `Copilot models endpoint returned ${Array.isArray(data) ? data.length : 0} models` },
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

export function inspectCodexConfig({ home = os.homedir(), host = "127.0.0.1", port = 2026 } = {}) {
  const filePath = path.join(home, ".codex", "config.toml");
  const expectedBaseUrl = `${adapterBaseUrl(host, port)}/v1`;
  const config = readText(filePath);
  if (!config.ok) {
    return [{ kind: "warn", message: `Codex config not found at ${displayPath(home, filePath)}` }];
  }

  const checks = [];
  const baseUrl = tomlString(config.text, "openai_base_url");
  checks.push(baseUrl === expectedBaseUrl
    ? { kind: "ok", message: `Codex base URL points to ${expectedBaseUrl}` }
    : { kind: "warn", message: `Codex base URL is ${valueLabel(baseUrl)}; expected "${expectedBaseUrl}"` });

  const missing = [];
  if (tomlString(config.text, "OPENAI_BASE_URL") !== expectedBaseUrl) missing.push("OPENAI_BASE_URL");
  if (tomlString(config.text, "OPENAI_API_KEY") !== "dummy") missing.push("OPENAI_API_KEY");
  checks.push(missing.length === 0
    ? { kind: "ok", message: "Codex shell env local API keys are configured" }
    : { kind: "warn", message: `Codex shell env local API keys need update: ${missing.join(", ")}` });
  return checks;
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
  checkAdapterListeningFn = checkAdapterListening,
  checkRunningAdapterFn = checkRunningAdapter,
  online = false,
  profile = AUTH_PROFILE_CODEX,
  compat = false,
  fetchImpl = fetch,
  onlineTimeoutMs = 10000,
  compatTimeoutMs = 120000,
  inspectAdapterCompatibilityFn = inspectAdapterCompatibility,
} = {}) {
  checkedDoctorProfile(profile);
  const checks = [
    ...inspectAuthProfiles({ home }),
    ...inspectCodexConfig({ home, host, port }),
  ];

  if (online) {
    checks.push(...await inspectAuthProfilesOnline({
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
  ].filter(Boolean);
  log(`${options.commandName || "ccdx"} doctor${flags.length ? ` ${flags.join(" ")}` : ""}`);
  const checks = await collectDoctorChecks(options);
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
