const HELP_COMMANDS = new Set(["help", "--help", "-h"]);
const VERSION_COMMANDS = new Set(["version", "--version", "-v"]);
const START_OPTIONS = new Set(["--configure-claude-desktop", "--show-request-id"]);

function unexpectedArgs(args) {
  throw new Error(`Unexpected argument${args.length === 1 ? "" : "s"}: ${args.join(" ")}`);
}

export function parseCliArgs(args = []) {
  const [command, ...rest] = args;
  if (!command) return { command: "start", configureClaudeDesktop: false, showRequestId: false, online: false, compat: false };
  if (HELP_COMMANDS.has(command)) {
    if (rest.length) unexpectedArgs(rest);
    return { command: "help", configureClaudeDesktop: false, showRequestId: false, online: false, compat: false };
  }
  if (VERSION_COMMANDS.has(command)) {
    if (rest.length) unexpectedArgs(rest);
    return { command: "version", configureClaudeDesktop: false, showRequestId: false, online: false, compat: false };
  }
  if (command === "usage") {
    if (rest.length) unexpectedArgs(rest);
    return { command: "usage", configureClaudeDesktop: false, showRequestId: false, online: false, compat: false };
  }
  if (command === "doctor" || command === "--doctor") {
    const supported = new Set(["--online", "--compat"]);
    const invalid = rest.filter((arg) => !supported.has(arg));
    if (invalid.length) unexpectedArgs(invalid);
    for (const option of supported) {
      if (rest.filter((arg) => arg === option).length > 1) unexpectedArgs([option]);
    }
    return {
      command: "doctor",
      configureClaudeDesktop: false,
      showRequestId: false,
      online: rest.includes("--online"),
      compat: rest.includes("--compat"),
    };
  }
  if (START_OPTIONS.has(command)) {
    const options = [command, ...rest];
    const invalid = options.filter((arg) => !START_OPTIONS.has(arg));
    if (invalid.length) unexpectedArgs(invalid);
    for (const option of START_OPTIONS) {
      if (options.filter((arg) => arg === option).length > 1) unexpectedArgs([option]);
    }
    return {
      command: "start",
      configureClaudeDesktop: options.includes("--configure-claude-desktop"),
      showRequestId: options.includes("--show-request-id"),
      online: false,
      compat: false,
    };
  }
  throw new Error(`Unknown command or option: ${command}`);
}

function integerEnv(env, name, fallback, { min, max = Number.MAX_SAFE_INTEGER }) {
  const raw = env[name];
  if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;
  const text = String(raw).trim();
  if (!/^\d+$/.test(text)) throw new Error(`${name} must be an integer between ${min} and ${max}`);
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

export function parseRuntimeOptions(env = process.env) {
  return {
    adapterPort: integerEnv(env, "ADAPTER_PORT", 2026, { min: 1, max: 65535 }),
    adapterHost: String(env.ADAPTER_HOST || "127.0.0.1").trim() || "127.0.0.1",
    modelRefreshTimeoutMs: integerEnv(env, "CCDX_MODEL_REFRESH_TIMEOUT_MS", 5000, { min: 1 }),
    existingAdapterTimeoutMs: integerEnv(env, "CCDX_EXISTING_ADAPTER_TIMEOUT_MS", 500, { min: 1 }),
    modelRefreshIntervalMs: integerEnv(env, "CCDX_MODEL_REFRESH_INTERVAL_MS", 2 * 60 * 60 * 1000, { min: 0 }),
    upstreamTimeoutMs: integerEnv(env, "CCDX_UPSTREAM_TIMEOUT_MS", 120000, { min: 1 }),
    streamHandshakeTimeoutMs: integerEnv(env, "CCDX_STREAM_HANDSHAKE_TIMEOUT_MS", 120000, { min: 1 }),
    streamIdleTimeoutMs: integerEnv(env, "CCDX_STREAM_IDLE_TIMEOUT_MS", 120000, { min: 1 }),
    shutdownTimeoutMs: integerEnv(env, "CCDX_SHUTDOWN_TIMEOUT_MS", 5000, { min: 1 }),
  };
}

export function cliHelp() {
  return `Usage:
  codex-copilot-dx [--configure-claude-desktop] [--show-request-id]
  codex-copilot-dx doctor [--online] [--compat]
  codex-copilot-dx usage
  codex-copilot-dx --version
  codex-copilot-dx --help`;
}
