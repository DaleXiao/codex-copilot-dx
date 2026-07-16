import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { githubTokenPath, readGithubTokenMetadata, validateGithubToken } from "./auth.mjs";
import { claudeDesktopPaths } from "./claude-desktop-config.mjs";
import { status } from "./status.mjs";
import { buildHeaders, DEFAULT_API_BASE, FALLBACK_VSCODE_VERSION } from "./copilot.mjs";
import { checkRunningAdapter } from "./running-adapter.mjs";

function localGatewayBaseUrl(host, port) {
  const safeHost = String(host || "127.0.0.1");
  const urlHost = safeHost.includes(":") && !safeHost.startsWith("[") ? `[${safeHost}]` : safeHost;
  return `http://${urlHost}:${port}`;
}

function readText(filePath) {
  try {
    return { ok: true, text: fs.readFileSync(filePath, "utf8") };
  } catch (e) {
    return { ok: false, missing: e?.code === "ENOENT", error: e };
  }
}

function readJson(filePath) {
  const raw = readText(filePath);
  if (!raw.ok) return raw;
  try {
    return { ok: true, json: JSON.parse(raw.text) };
  } catch (e) {
    return { ok: false, parseError: true, error: e };
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
  const data = copilotModelData(models).filter((model) => model?.model_picker_enabled !== false);
  const responsesCandidates = data.filter((model) => {
    const id = String(model?.id || "");
    const endpoints = modelEndpoints(model);
    return id.startsWith("gpt-") && (endpoints.includes("/responses") || endpoints.includes("/v1/responses"));
  });
  const responsesOnly = [...responsesCandidates].reverse()
    .find((model) => !modelEndpoints(model).includes("/chat/completions"));
  const claude = data.find((model) => {
    const id = String(model?.id || "");
    const vendor = String(model?.vendor || "").toLowerCase();
    return (id.startsWith("claude-") || vendor === "anthropic")
      && modelEndpoints(model).includes("/chat/completions");
  });
  return {
    responsesModel: String((responsesOnly || responsesCandidates[0])?.id || ""),
    claudeModel: String(claude?.id || ""),
  };
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
  } catch (e) {
    const reason = e?.name === "AbortError" ? "timed out" : e?.message || "unknown error";
    checks.push({ kind: "err", message: `${label} failed: ${reason}` });
    return null;
  }
}

function parseResponseObject(text) {
  const response = JSON.parse(text);
  if (!response?.id || !Array.isArray(response.output)) throw new Error("response body is missing id or output");
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

  const { responsesModel, claudeModel } = selectCompatibilityModels(models);
  if (!responsesModel) {
    checks.push({ kind: "err", message: "Compatibility Responses check failed: no GPT model advertises /responses" });
    return checks;
  }

  const firstResponse = await runCompatibilityCheck(checks, `Native Responses (${responsesModel})`, async () => {
    const text = await compatibilityRequest(fetchImpl, `${baseUrl}/v1/responses`, {
      model: responsesModel,
      stream: false,
      input: "Reply with OK only.",
    }, timeoutMs);
    return parseResponseObject(text);
  });

  if (firstResponse) {
    await runCompatibilityCheck(checks, "Responses stream, history, and image tool compatibility", async () => {
      const text = await compatibilityRequest(fetchImpl, `${baseUrl}/v1/responses`, {
        model: responsesModel,
        stream: true,
        previous_response_id: firstResponse.id,
        input: "Reply with OK again.",
        tools: [{ type: "image_generation" }],
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
    parseResponseObject(text);
  });

  if (!claudeModel) {
    checks.push({ kind: "warn", message: "Anthropic stream compatibility skipped because no Claude chat model was advertised" });
    return checks;
  }

  await runCompatibilityCheck(checks, `Anthropic Messages stream (${claudeModel})`, async () => {
    const text = await compatibilityRequest(fetchImpl, `${baseUrl}/v1/messages`, {
      model: claudeModel,
      max_tokens: 16,
      stream: true,
      messages: [{ role: "user", content: "Reply with OK only." }],
    }, timeoutMs);
    if (!/^event:\s*message_stop\s*$/m.test(text)) throw new Error("stream did not contain message_stop");
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

export async function inspectGitHubTokenOnline({
  home = os.homedir(),
  fetchImpl = fetch,
  timeoutMs = 10000,
} = {}) {
  const token = readText(githubTokenPath(home));
  if (!token.ok || !token.text.trim()) {
    return [{ kind: "warn", message: "Online Copilot check skipped because the GitHub token is missing" }];
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const validation = await validateGithubToken(token.text.trim(), {
      fetchImpl,
      signal: controller.signal,
    });
    if (!validation.ok) {
      const statusText = validation.status ? ` (HTTP ${validation.status})` : "";
      return [{ kind: validation.transient ? "warn" : "err", message: `GitHub Copilot authentication failed: ${validation.reason}${statusText}` }];
    }

    const tokenData = validation.copilotTokenData;
    const apiBase = tokenData.endpoints?.api || DEFAULT_API_BASE;
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
  } catch (e) {
    const reason = e?.name === "AbortError" ? `timed out after ${timeoutMs}ms` : e.message;
    return [{ kind: "warn", message: `Online Copilot check failed: ${reason}` }];
  } finally {
    clearTimeout(timer);
  }
}

export function inspectCodexConfig({ home = os.homedir(), port = 2026 } = {}) {
  const filePath = path.join(home, ".codex", "config.toml");
  const expectedBaseUrl = `http://127.0.0.1:${port}/v1`;
  const expectedAnthropicBaseUrl = `http://127.0.0.1:${port}`;
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
  if (tomlString(config.text, "ANTHROPIC_BASE_URL") !== expectedAnthropicBaseUrl) missing.push("ANTHROPIC_BASE_URL");
  if (tomlString(config.text, "ANTHROPIC_AUTH_TOKEN") !== "dummy") missing.push("ANTHROPIC_AUTH_TOKEN");
  checks.push(missing.length === 0
    ? { kind: "ok", message: "Codex shell env local API keys are configured" }
    : { kind: "warn", message: `Codex shell env local API keys need update: ${missing.join(", ")}` });
  return checks;
}

export function inspectClaudeCodeConfig({ home = os.homedir(), port = 2026 } = {}) {
  const filePath = path.join(home, ".claude", "settings.json");
  const expectedBaseUrl = `http://127.0.0.1:${port}`;
  const settings = readJson(filePath);
  if (!settings.ok) {
    const reason = settings.parseError ? `could not parse: ${settings.error.message}` : `not found at ${displayPath(home, filePath)}`;
    return [{ kind: settings.parseError ? "err" : "warn", message: `Claude Code settings ${reason}` }];
  }

  const env = settings.json?.env || {};
  const missing = [];
  if (env.ANTHROPIC_BASE_URL !== expectedBaseUrl) missing.push("ANTHROPIC_BASE_URL");
  if (env.ANTHROPIC_AUTH_TOKEN !== "dummy") missing.push("ANTHROPIC_AUTH_TOKEN");
  return [missing.length === 0
    ? { kind: "ok", message: `Claude Code points to ${expectedBaseUrl}` }
    : { kind: "warn", message: `Claude Code settings need update: ${missing.join(", ")}` }];
}

export function inspectClaudeAppConfig({
  home = os.homedir(),
  platform = process.platform,
  env = process.env,
  host = "127.0.0.1",
  port = 2026,
} = {}) {
  const paths = claudeDesktopPaths(home, platform, env);
  const expectedBaseUrl = localGatewayBaseUrl(host, port);
  const checks = [];

  const normalConfig = readJson(paths.normalConfigPath);
  const threepConfig = readJson(paths.threepConfigPath);
  if (normalConfig.ok && threepConfig.ok
    && normalConfig.json?.deploymentMode === "3p"
    && threepConfig.json?.deploymentMode === "3p") {
    checks.push({ kind: "ok", message: "Claude App deployment mode is 3p" });
  } else {
    checks.push({ kind: "warn", message: "Claude App deployment mode is not fully configured for 3p" });
  }

  const meta = readJson(paths.metaPath);
  const appliedId = meta.ok ? String(meta.json?.appliedId || "").trim() : "";
  if (!appliedId) {
    checks.push({ kind: "warn", message: "Claude App gateway profile is not configured; run with --configure-claude-desktop" });
    return checks;
  }

  const profilePath = path.join(paths.configLibraryPath, `${appliedId}.json`);
  const profile = readJson(profilePath);
  if (!profile.ok) {
    checks.push({ kind: "warn", message: `Claude App active gateway profile not found at ${displayPath(home, profilePath)}` });
    return checks;
  }

  const p = profile.json || {};
  const missing = [];
  if (p.inferenceProvider !== "gateway") missing.push("inferenceProvider");
  if (p.inferenceGatewayBaseUrl !== expectedBaseUrl) missing.push(`inferenceGatewayBaseUrl expected "${expectedBaseUrl}"`);
  if (p.inferenceGatewayAuthScheme !== "bearer") missing.push("inferenceGatewayAuthScheme");
  if (!String(p.inferenceGatewayApiKey || "").trim()) missing.push("inferenceGatewayApiKey");
  if (!String(p.inferenceModels || "").trim()) missing.push("inferenceModels");
  checks.push(missing.length === 0
    ? { kind: "ok", message: `Claude App gateway profile points to ${expectedBaseUrl}` }
    : { kind: "warn", message: `Claude App gateway profile needs update: ${missing.join(", ")}` });
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
  platform = process.platform,
  env = process.env,
  host = "127.0.0.1",
  port = 2026,
  checkAdapter = true,
  checkAdapterListeningFn = checkAdapterListening,
  checkRunningAdapterFn = checkRunningAdapter,
  online = false,
  compat = false,
  fetchImpl = fetch,
  onlineTimeoutMs = 10000,
  compatTimeoutMs = 120000,
  inspectAdapterCompatibilityFn = inspectAdapterCompatibility,
} = {}) {
  const checks = [
    ...inspectGitHubToken({ home }),
    ...inspectCodexConfig({ home, port }),
    ...inspectClaudeCodeConfig({ home, port }),
    ...inspectClaudeAppConfig({ home, platform, env, host, port }),
  ];

  if (online) {
    checks.push(...await inspectGitHubTokenOnline({ home, fetchImpl, timeoutMs: onlineTimeoutMs }));
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
        : { kind: "warn", message: `Adapter is not listening on ${localGatewayBaseUrl(host, port)}` });
    }
  }

  if (compat) {
    if (!running?.ok) {
      checks.push({ kind: "err", message: "Compatibility checks require a running, version-compatible codex-copilot-dx adapter" });
    } else {
      checks.push(...await inspectAdapterCompatibilityFn({ host, port, fetchImpl, timeoutMs: compatTimeoutMs }));
    }
  }

  return checks;
}

export async function runDoctor(options = {}) {
  const log = options.log || console.log;
  const flags = [options.online ? "--online" : "", options.compat ? "--compat" : ""].filter(Boolean);
  log(`codex-copilot-dx doctor${flags.length ? ` ${flags.join(" ")}` : ""}`);
  const checks = await collectDoctorChecks(options);
  for (const check of checks) log(status(check.kind, check.message));
  return checks;
}
