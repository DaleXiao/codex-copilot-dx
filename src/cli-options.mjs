const HELP_COMMANDS = new Set(["help", "--help", "-h"]);
const VERSION_COMMANDS = new Set(["version", "--version", "-v"]);

function unexpectedArgs(args) {
  throw new Error(`Unexpected argument${args.length === 1 ? "" : "s"}: ${args.join(" ")}`);
}

export function parseCliArgs(args = []) {
  const [command, ...rest] = args;
  if (!command) return { command: "start", configureClaudeDesktop: false, online: false };
  if (HELP_COMMANDS.has(command)) {
    if (rest.length) unexpectedArgs(rest);
    return { command: "help", configureClaudeDesktop: false, online: false };
  }
  if (VERSION_COMMANDS.has(command)) {
    if (rest.length) unexpectedArgs(rest);
    return { command: "version", configureClaudeDesktop: false, online: false };
  }
  if (command === "usage") {
    if (rest.length) unexpectedArgs(rest);
    return { command: "usage", configureClaudeDesktop: false, online: false };
  }
  if (command === "doctor" || command === "--doctor") {
    const invalid = rest.filter((arg) => arg !== "--online");
    if (invalid.length) unexpectedArgs(invalid);
    if (rest.filter((arg) => arg === "--online").length > 1) unexpectedArgs(["--online"]);
    return { command: "doctor", configureClaudeDesktop: false, online: rest.includes("--online") };
  }
  if (command === "--configure-claude-desktop") {
    if (rest.length) unexpectedArgs(rest);
    return { command: "start", configureClaudeDesktop: true, online: false };
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
  codex-copilot-dx [--configure-claude-desktop]
  codex-copilot-dx doctor [--online]
  codex-copilot-dx usage
  codex-copilot-dx --version
  codex-copilot-dx --help`;
}
