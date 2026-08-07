const HELP_COMMANDS = new Set(["help", "--help", "-h"]);
const VERSION_COMMANDS = new Set(["version", "--version", "-v"]);
const START_OPTIONS = new Set(["--configure-claude-desktop", "--show-request-id"]);
const CLI_COMMANDS = new Set(["ccdx", "codex-copilot-dx"]);

function unexpectedArgs(args) {
  throw new Error(`Unexpected argument${args.length === 1 ? "" : "s"}: ${args.join(" ")}`);
}

function parseOptions(args, schema) {
  const parsed = {};
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    const kind = schema.get(option);
    if (!kind || seen.has(option)) unexpectedArgs([option]);
    seen.add(option);
    if (kind === "flag") {
      parsed[option] = true;
      continue;
    }

    const value = args[index + 1];
    if (value === undefined || !String(value).trim() || String(value).startsWith("-")) {
      throw new Error(`Missing value for ${option}`);
    }
    parsed[option] = value;
    index += 1;
  }
  return parsed;
}

function checkedProfile(value, { allowAll = false } = {}) {
  const profile = value || "codex";
  const allowed = allowAll ? new Set(["codex", "claude", "all"]) : new Set(["codex", "claude"]);
  if (!allowed.has(profile)) {
    throw new Error(`Profile must be ${allowAll ? "codex, claude, or all" : "codex or claude"}: ${profile}`);
  }
  return profile;
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
  if (command === "status" || command === "--status") {
    if (rest.length) unexpectedArgs(rest);
    return { command: "status", configureClaudeDesktop: false, showRequestId: false, online: false, compat: false };
  }
  if (command === "usage") {
    if (rest.length) unexpectedArgs(rest);
    return { command: "usage", configureClaudeDesktop: false, showRequestId: false, online: false, compat: false };
  }
  if (command === "pms") {
    const [action, ...pmsArgs] = rest;
    if (!action) throw new Error("Missing pms action: expected setup");
    if (action !== "setup") throw new Error(`Unknown pms action: ${action}`);
    if (pmsArgs.length) unexpectedArgs(pmsArgs);
    return { command: "pms", action: "setup", configureClaudeDesktop: false, showRequestId: false, online: false, compat: false };
  }
  if (command === "models") {
    const options = parseOptions(rest, new Map([["--profile", "value"]]));
    return {
      command: "models",
      configureClaudeDesktop: false,
      showRequestId: false,
      online: false,
      compat: false,
      profile: checkedProfile(options["--profile"]),
    };
  }
  if (command === "auth") {
    const [action, ...authArgs] = rest;
    if (!action) throw new Error("Missing auth action: expected status or login");
    if (action === "status") {
      const options = parseOptions(authArgs, new Map([["--online", "flag"]]));
      return {
        command: "auth",
        action: "status",
        profile: "",
        configureClaudeDesktop: false,
        showRequestId: false,
        online: Boolean(options["--online"]),
        compat: false,
        expectedLogin: "",
        reauth: false,
      };
    }
    if (action === "login") {
      const [profile, ...loginArgs] = authArgs;
      if (!profile) throw new Error("Missing auth login profile: expected claude");
      if (profile !== "claude") throw new Error(`Auth login profile must be claude: ${profile}`);
      const options = parseOptions(loginArgs, new Map([
        ["--github-login", "value"],
        ["--reauth", "flag"],
      ]));
      return {
        command: "auth",
        action: "login",
        profile: "claude",
        configureClaudeDesktop: false,
        showRequestId: false,
        online: false,
        compat: false,
        expectedLogin: options["--github-login"] || "",
        reauth: Boolean(options["--reauth"]),
      };
    }
    throw new Error(`Unknown auth action: ${action}`);
  }
  if (command === "auto-review-model") {
    if (rest.length) unexpectedArgs(rest);
    return { command: "auto-review-model", configureClaudeDesktop: false, showRequestId: false, online: false, compat: false };
  }
  if (command === "update") {
    if (rest.length > 1) unexpectedArgs(rest.slice(1));
    const source = rest[0];
    if (source && !new Set(["npm", "github", "gh"]).has(source)) {
      throw new Error(`Update source must be npm or github: ${source}`);
    }
    return {
      command: "update",
      configureClaudeDesktop: false,
      showRequestId: false,
      online: false,
      compat: false,
      updateSource: source === "gh" ? "github" : source,
    };
  }
  if (command === "doctor" || command === "--doctor") {
    const options = parseOptions(rest, new Map([
      ["--online", "flag"],
      ["--compat", "flag"],
      ["--profile", "value"],
    ]));
    return {
      command: "doctor",
      configureClaudeDesktop: false,
      showRequestId: false,
      online: Boolean(options["--online"]),
      compat: Boolean(options["--compat"]),
      profile: checkedProfile(options["--profile"], { allowAll: true }),
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

export function parseAdapterProbeOptions(env = process.env) {
  return {
    adapterPort: integerEnv(env, "ADAPTER_PORT", 2026, { min: 1, max: 65535 }),
    adapterHost: String(env.ADAPTER_HOST || "127.0.0.1").trim() || "127.0.0.1",
    existingAdapterTimeoutMs: integerEnv(env, "CCDX_EXISTING_ADAPTER_TIMEOUT_MS", 500, { min: 1 }),
  };
}

export function cliCommandName(executable = process.argv[1]) {
  const name = String(executable || "").split(/[\\/]/).pop();
  if (name === "codex-copilot-dx.mjs") return "codex-copilot-dx";
  return CLI_COMMANDS.has(name) ? name : "ccdx";
}

export function cliHelp(commandName = "ccdx") {
  const name = CLI_COMMANDS.has(commandName) ? commandName : "ccdx";
  const alias = name === "ccdx" ? "codex-copilot-dx" : "ccdx";
  return `Usage:
  ${name} [--configure-claude-desktop] [--show-request-id]
  ${name} auth status [--online]
  ${name} auth login claude [--github-login <login>] [--reauth]
  ${name} doctor [--online] [--compat] [--profile codex|claude|all]
  ${name} status
  ${name} models [--profile codex|claude]
  ${name} pms setup
  ${name} usage
  ${name} auto-review-model
  ${name} update [npm|github]
  ${name} --version
  ${name} --help

Equivalent command: ${alias}`;
}
