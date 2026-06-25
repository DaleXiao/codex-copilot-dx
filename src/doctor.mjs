import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { githubTokenPath } from "./auth.mjs";
import { claudeDesktopPaths } from "./claude-desktop-config.mjs";
import { status } from "./status.mjs";

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

export function inspectGitHubToken({ home = os.homedir() } = {}) {
  const filePath = githubTokenPath(home);
  const token = readText(filePath);
  if (!token.ok) {
    return [{ kind: "warn", message: `GitHub token not found at ${displayPath(home, filePath)}` }];
  }
  if (!token.text.trim()) {
    return [{ kind: "err", message: `GitHub token file is empty at ${displayPath(home, filePath)}` }];
  }
  return [{ kind: "ok", message: "GitHub token found" }];
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
} = {}) {
  const checks = [
    ...inspectGitHubToken({ home }),
    ...inspectCodexConfig({ home, port }),
    ...inspectClaudeCodeConfig({ home, port }),
    ...inspectClaudeAppConfig({ home, platform, env, host, port }),
  ];

  if (checkAdapter) {
    const listening = await checkAdapterListeningFn({ host, port });
    checks.push(listening
      ? { kind: "ok", message: `Adapter is listening on ${localGatewayBaseUrl(host, port)}` }
      : { kind: "warn", message: `Adapter is not listening on ${localGatewayBaseUrl(host, port)}` });
  }

  return checks;
}

export async function runDoctor(options = {}) {
  const log = options.log || console.log;
  log("codex-copilot-dx doctor");
  const checks = await collectDoctorChecks(options);
  for (const check of checks) log(status(check.kind, check.message));
  return checks;
}
