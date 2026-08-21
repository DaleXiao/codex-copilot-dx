import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { githubTokenPath, readGithubTokenMetadata, validateGithubToken } from "./auth.mjs";
import {
  AUTH_PROFILE_CLAUDE,
  AUTH_PROFILE_CODEX,
  readAuthProfileCredentials,
} from "./auth-profile.mjs";
import { claudeDesktopPaths } from "./claude-desktop-config.mjs";
import { status } from "./status.mjs";
import { buildHeaders, DEFAULT_API_BASE, FALLBACK_VSCODE_VERSION } from "./copilot.mjs";
import { adapterBaseUrl, checkRunningAdapter } from "./running-adapter.mjs";
import { CODEX_AUTO_REVIEW_MODEL, isClaudeCopilotModel } from "./models.mjs";
import { loadModelCache } from "./model-cache.mjs";

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

export function selectCompatibilityModels(models, { claudeModels = models } = {}) {
  const data = copilotModelData(models).filter((model) => model?.model_picker_enabled !== false);
  const claudeData = copilotModelData(claudeModels);
  const responsesCandidates = data.filter((model) => {
    const id = String(model?.id || "");
    const endpoints = modelEndpoints(model);
    return id.startsWith("gpt-") && (endpoints.includes("/responses") || endpoints.includes("/v1/responses"));
  });
  const responsesOnly = [...responsesCandidates].reverse()
    .find((model) => !modelEndpoints(model).includes("/chat/completions"));
  const claude = claudeData.find(isClaudeCopilotModel);
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
  claudeMode = "inherited",
  claudeModels,
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

  const { responsesModel, claudeModel } = selectCompatibilityModels(models, {
    claudeModels: claudeMode === "isolated" ? (claudeModels || { data: [] }) : models,
  });
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
    parseCompactionResponse(text);
  });

  if (!claudeModel) {
    const reason = claudeMode === "isolated"
      ? "the isolated Claude model cache is unavailable or advertises no Claude chat model; restart ccdx to refresh it"
      : "no Claude chat model was advertised";
    checks.push({ kind: "warn", message: `Anthropic stream compatibility was not verified because ${reason}` });
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

export function inspectAuthProfiles({ home = os.homedir() } = {}) {
  const checks = [
    ...inspectGitHubToken({ home }),
    { kind: "ok", message: "Codex authentication profile uses the legacy path" },
  ];
  try {
    const claude = readAuthProfileCredentials(AUTH_PROFILE_CLAUDE, { home });
    if (!claude.configured) {
      checks.push({ kind: "ok", message: "Claude authentication profile is not isolated and inherits Codex" });
    } else if (!claude.valid) {
      checks.push({
        kind: "err",
        message: `Claude isolated authentication profile is invalid: ${claude.reason}`,
        fix: "ccdx auth login claude --reauth",
      });
    } else {
      const account = claude.identity?.login ? ` for ${claude.identity.login}` : "";
      checks.push({ kind: "ok", message: `Claude isolated authentication profile is configured${account}` });
    }
  } catch {
    checks.push({ kind: "err", message: "Claude isolated authentication profile could not be inspected" });
  }
  return checks;
}

function checkedDoctorProfile(profile = AUTH_PROFILE_CODEX) {
  const value = String(profile || AUTH_PROFILE_CODEX).trim().toLowerCase();
  if (![AUTH_PROFILE_CODEX, AUTH_PROFILE_CLAUDE, "all"].includes(value)) {
    throw new Error(`Doctor profile must be codex, claude, or all: ${profile}`);
  }
  return value;
}

function onlineMessage(profile, message, inherited = false) {
  if (profile === AUTH_PROFILE_CODEX) return message;
  return `${inherited ? "Claude inherited Codex" : "Claude profile"}: ${message}`;
}

export async function inspectGitHubTokenOnline({
  home = os.homedir(),
  profile = AUTH_PROFILE_CODEX,
  fetchImpl = fetch,
  timeoutMs = 10000,
} = {}) {
  const requestedProfile = checkedDoctorProfile(profile);
  if (requestedProfile === "all") throw new Error("inspectGitHubTokenOnline accepts one profile at a time");
  let inherited = false;
  let credentials;
  try {
    credentials = readAuthProfileCredentials(requestedProfile, { home });
    if (requestedProfile === AUTH_PROFILE_CLAUDE && !credentials.configured) {
      inherited = true;
      credentials = readAuthProfileCredentials(AUTH_PROFILE_CODEX, { home });
    }
  } catch {
    return [{ kind: "warn", message: onlineMessage(requestedProfile, "Online Copilot check failed while reading the local credential", inherited) }];
  }

  const checks = [];
  if (inherited) {
    checks.push({ kind: "ok", message: "Claude profile is not separately configured and inherits Codex authentication" });
  }
  if (!credentials.valid) {
    const reason = requestedProfile === AUTH_PROFILE_CODEX
      ? "the GitHub token is missing"
      : credentials.reason;
    checks.push({ kind: "warn", message: onlineMessage(requestedProfile, `Online Copilot check skipped because ${reason}`, inherited) });
    return checks;
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
      checks.push({
        kind: validation.transient ? "warn" : "err",
        message: onlineMessage(requestedProfile, `GitHub Copilot authentication failed: ${validation.reason}${statusText}`, inherited),
      });
      return checks;
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
      checks.push(
        { kind: "ok", message: onlineMessage(requestedProfile, `GitHub Copilot access verified for ${validation.login || "current account"}`, inherited) },
        { kind: "err", message: onlineMessage(requestedProfile, `Copilot models endpoint returned HTTP ${modelResp.status}`, inherited) },
      );
      return checks;
    }
    const models = await modelResp.json();
    const data = Array.isArray(models) ? models : models?.data;
    checks.push(
      { kind: "ok", message: onlineMessage(requestedProfile, `GitHub Copilot access verified for ${validation.login || "current account"}`, inherited) },
      { kind: "ok", message: onlineMessage(requestedProfile, `Copilot models endpoint returned ${Array.isArray(data) ? data.length : 0} models`, inherited) },
    );
    return checks;
  } catch (e) {
    const errorCode = e?.cause?.code || e?.code || "";
    const reason = e?.name === "AbortError"
      ? `timed out after ${timeoutMs}ms`
      : `request failed${errorCode ? ` (${errorCode})` : ""}`;
    checks.push({ kind: "warn", message: onlineMessage(requestedProfile, `Online Copilot check failed: ${reason}`, inherited) });
    return checks;
  } finally {
    clearTimeout(timer);
  }
}

export async function inspectAuthProfilesOnline({
  home = os.homedir(),
  profile = AUTH_PROFILE_CODEX,
  fetchImpl = fetch,
  timeoutMs = 10000,
} = {}) {
  const selected = checkedDoctorProfile(profile);
  if (selected !== "all") {
    return inspectGitHubTokenOnline({ home, profile: selected, fetchImpl, timeoutMs });
  }

  let claudeConfigured = false;
  let claudeReadFailed = false;
  try {
    claudeConfigured = readAuthProfileCredentials(AUTH_PROFILE_CLAUDE, { home }).configured;
  } catch {
    claudeReadFailed = true;
  }
  const [codexChecks, claudeChecks] = await Promise.all([
    inspectGitHubTokenOnline({ home, profile: AUTH_PROFILE_CODEX, fetchImpl, timeoutMs }),
    claudeReadFailed
      ? Promise.resolve([{ kind: "err", message: "Claude isolated authentication profile could not be inspected" }])
      : claudeConfigured
      ? inspectGitHubTokenOnline({ home, profile: AUTH_PROFILE_CLAUDE, fetchImpl, timeoutMs })
      : Promise.resolve([{ kind: "ok", message: "Claude profile is not separately configured and inherits Codex authentication" }]),
  ]);
  return [...codexChecks, ...claudeChecks];
}

export function inspectCodexConfig({ home = os.homedir(), host = "127.0.0.1", port = 2026 } = {}) {
  const filePath = path.join(home, ".codex", "config.toml");
  const expectedAnthropicBaseUrl = adapterBaseUrl(host, port);
  const expectedBaseUrl = `${expectedAnthropicBaseUrl}/v1`;
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

export function inspectClaudeCodeConfig({ home = os.homedir(), host = "127.0.0.1", port = 2026 } = {}) {
  const filePath = path.join(home, ".claude", "settings.json");
  const expectedBaseUrl = adapterBaseUrl(host, port);
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
    checks.push({
      kind: "warn",
      message: "Claude App gateway profile is not configured",
      fix: "ccdx start --configure-claude-app",
    });
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
  checkPmStudio = checkAdapter,
  checkAdapterListeningFn = checkAdapterListening,
  checkRunningAdapterFn = checkRunningAdapter,
  online = false,
  profile = AUTH_PROFILE_CODEX,
  compat = false,
  fetchImpl = fetch,
  onlineTimeoutMs = 10000,
  compatTimeoutMs = 120000,
  inspectAdapterCompatibilityFn = inspectAdapterCompatibility,
  inspectPmStudioHealthFn,
} = {}) {
  const checks = [
    ...inspectAuthProfiles({ home }),
    ...inspectCodexConfig({ home, host, port }),
    ...inspectClaudeCodeConfig({ home, host, port }),
    ...inspectClaudeAppConfig({ home, platform, env, host, port }),
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

  if (checkPmStudio && platform === "darwin") {
    const inspect = inspectPmStudioHealthFn || (async (options) => {
      const module = await import("./pm-studio-status.mjs");
      return module.inspectPmStudioStatus(options);
    });
    const pm = await inspect({ home });
    const version = pm.app.metadata ? `${pm.app.metadata.version} build ${pm.app.metadata.build}` : "";
    if (pm.app.state === "patched") {
      checks.push({ kind: "ok", message: `PM Studio ${version} patch is verified` });
      if (!pm.claude.valid) {
        checks.push({
          kind: "warn",
          message: "PM Studio Claude routing requires a valid isolated Claude profile",
          fix: "ccdx auth login claude --reauth",
        });
      }
      if (!pm.adapter?.ok) {
        checks.push({ kind: "warn", message: "PM Studio relay is not currently available", fix: "ccdx start" });
      } else if (!pm.runtime?.ok) {
        checks.push({
          kind: "warn",
          message: "PM Studio relay is running, but its isolated routing is not ready",
          fix: "stop the running adapter, then run ccdx start",
        });
      }
    } else if (pm.app.state === "predecessor") {
      checks.push({
        kind: "warn",
        message: `PM Studio ${version} has a verified predecessor split patch`,
        fix: "ccdx pms setup",
      });
    } else if (pm.app.state === "clean") {
      checks.push({
        kind: "warn",
        message: `PM Studio ${version} has a compatible local patch structure but is not patched`,
        fix: "ccdx pms setup",
      });
    } else if (pm.app.state === "unsupported") {
      checks.push({ kind: "warn", message: `PM Studio ${version} does not expose one uniquely compatible patch structure; no files will be changed` });
    } else if (pm.app.state === "drift" || pm.app.state === "error") {
      checks.push({ kind: "err", message: `PM Studio integrity check failed: ${pm.app.issues.join("; ")}` });
    }
  }

  if (compat) {
    if (!running?.ok) {
      checks.push({ kind: "err", message: "Compatibility checks require a running, version-compatible codex-copilot-dx adapter" });
    } else {
      let claudeMode = "inherited";
      let claudeModels;
      try {
        const claudeCredentials = readAuthProfileCredentials(AUTH_PROFILE_CLAUDE, { home });
        if (claudeCredentials.configured) {
          claudeMode = "isolated";
          if (claudeCredentials.valid) {
            claudeModels = loadModelCache({
              home,
              profile: AUTH_PROFILE_CLAUDE,
              credentialFingerprint: claudeCredentials.metadata?.token_fingerprint,
            });
          }
        }
      } catch {
        // A configured-but-unreadable optional profile must not borrow the
        // Codex catalog. Compatibility will report the Claude path unverified.
        claudeMode = "isolated";
      }
      checks.push(...await inspectAdapterCompatibilityFn({
        host,
        port,
        fetchImpl,
        timeoutMs: compatTimeoutMs,
        claudeMode,
        claudeModels,
      }));
    }
  }

  return checks;
}

export async function runDoctor(options = {}) {
  const log = options.log || console.log;
  const profile = checkedDoctorProfile(options.profile);
  const flags = [
    options.online ? "--online" : "",
    options.compat ? "--compat" : "",
    profile !== AUTH_PROFILE_CODEX ? `--profile ${profile}` : "",
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
