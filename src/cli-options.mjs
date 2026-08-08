const HELP_COMMANDS = new Set(["help", "--help", "-h"]);
const VERSION_COMMANDS = new Set(["version", "--version", "-v"]);
const START_OPTIONS = new Map([
  ["--configure-claude-desktop", "configure-claude-app"],
  ["--configure-claude-app", "configure-claude-app"],
  ["--show-request-id", "show-request-id"],
]);
const CLI_COMMANDS = new Set(["ccdx", "codex-copilot-dx"]);
const PM_COMMANDS = new Set(["pms", "pm-studio"]);
const HELP_TOPICS = new Set([
  "",
  "start",
  "auth",
  "auth status",
  "auth login",
  "doctor",
  "status",
  "models",
  "pms",
  "pms setup",
  "pms status",
  "usage",
  "auto-review-model",
  "update",
  "version",
]);

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

function baseCommand(command, extra = {}) {
  return {
    command,
    configureClaudeDesktop: false,
    showRequestId: false,
    online: false,
    compat: false,
    ...extra,
  };
}

function checkedHelpTopic(parts = []) {
  const normalized = parts.map((part, index) => {
    if (index === 0 && part === "pm-studio") return "pms";
    return part;
  }).join(" ");
  if (!HELP_TOPICS.has(normalized)) throw new Error(`Unknown help topic: ${parts.join(" ")}`);
  return normalized;
}

function helpCommand(parts = []) {
  return baseCommand("help", { helpTopic: checkedHelpTopic(parts) });
}

function nestedHelp(command, rest) {
  if (!rest.length || !HELP_COMMANDS.has(rest.at(-1))) return null;
  const args = rest.slice(0, -1);
  if (PM_COMMANDS.has(command)) {
    if (args.length > 1) unexpectedArgs(args.slice(1));
    return helpCommand(["pms", ...args]);
  }
  if (command === "auth") {
    if (args[0] === "login" && args[1] === "claude" && args.length === 2) {
      return helpCommand(["auth", "login"]);
    }
    if (args.length > 1) unexpectedArgs(args.slice(1));
    return helpCommand(["auth", ...args]);
  }
  if (args.length) unexpectedArgs(args);
  return helpCommand([command]);
}

function parseStartOptions(args) {
  const seen = new Set();
  for (const option of args) {
    const kind = START_OPTIONS.get(option);
    if (!kind || seen.has(kind)) unexpectedArgs([option]);
    seen.add(kind);
  }
  return baseCommand("start", {
    configureClaudeDesktop: seen.has("configure-claude-app"),
    showRequestId: seen.has("show-request-id"),
  });
}

export function parseCliArgs(args = []) {
  const [command, ...rest] = args;
  if (!command) return baseCommand("start");
  if (HELP_COMMANDS.has(command)) {
    const topic = rest[0] === "auth" && rest[1] === "login" && rest[2] === "claude"
      ? ["auth", "login"]
      : rest;
    if (topic.length > 2) unexpectedArgs(topic.slice(2));
    return helpCommand(topic);
  }
  const requestedHelp = nestedHelp(command, rest);
  if (requestedHelp) return requestedHelp;
  if (VERSION_COMMANDS.has(command)) {
    if (rest.length) unexpectedArgs(rest);
    return baseCommand("version");
  }
  if (command === "start") return parseStartOptions(rest);
  if (command === "status" || command === "--status") {
    if (rest.length) unexpectedArgs(rest);
    return baseCommand("status");
  }
  if (command === "usage") {
    if (rest.length) unexpectedArgs(rest);
    return baseCommand("usage");
  }
  if (PM_COMMANDS.has(command)) {
    const [action, ...pmsArgs] = rest;
    if (!action) throw new Error("Missing pms action: expected setup or status");
    if (!new Set(["setup", "status"]).has(action)) throw new Error(`Unknown pms action: ${action}`);
    if (pmsArgs.length) unexpectedArgs(pmsArgs);
    return baseCommand("pms", { action });
  }
  if (command === "models") {
    const options = parseOptions(rest, new Map([["--profile", "value"]]));
    return {
      ...baseCommand("models"),
      profile: checkedProfile(options["--profile"]),
    };
  }
  if (command === "auth") {
    const [action, ...authArgs] = rest;
    if (!action) throw new Error("Missing auth action: expected status or login");
    if (action === "status") {
      const options = parseOptions(authArgs, new Map([["--online", "flag"]]));
      return {
        ...baseCommand("auth"),
        action: "status",
        profile: "",
        online: Boolean(options["--online"]),
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
        ...baseCommand("auth"),
        action: "login",
        profile: "claude",
        expectedLogin: options["--github-login"] || "",
        reauth: Boolean(options["--reauth"]),
      };
    }
    throw new Error(`Unknown auth action: ${action}`);
  }
  if (command === "auto-review-model") {
    if (rest.length) unexpectedArgs(rest);
    return baseCommand("auto-review-model");
  }
  if (command === "update") {
    if (rest.length > 1) unexpectedArgs(rest.slice(1));
    const source = rest[0];
    if (source && !new Set(["npm", "github", "gh"]).has(source)) {
      throw new Error(`Update source must be npm or github: ${source}`);
    }
    return {
      ...baseCommand("update"),
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
      ...baseCommand("doctor"),
      online: Boolean(options["--online"]),
      compat: Boolean(options["--compat"]),
      profile: checkedProfile(options["--profile"], { allowAll: true }),
    };
  }
  if (START_OPTIONS.has(command)) return parseStartOptions([command, ...rest]);
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

function topicHelp(name, topic) {
  const sections = {
    start: `Usage:\n  ${name} [start] [--configure-claude-app] [--show-request-id]\n\nStarts or reuses the local adapter, updates Codex and Claude Code configuration, and opens Codex.\n--configure-claude-app also creates or updates the managed Claude App gateway profile.`,
    auth: `Usage:\n  ${name} auth status [--online]\n  ${name} auth login claude [--github-login <login>] [--reauth]\n\nShows the two account profiles or configures the isolated Claude account. Device login starts only when no reusable local Copilot credential is available or --reauth is used.`,
    "auth status": `Usage:\n  ${name} auth status [--online]\n\nShows account routing without exposing credentials. --online also verifies both configured Copilot entitlements and model catalogs.`,
    "auth login": `Usage:\n  ${name} auth login claude [--github-login <login>] [--reauth]\n\nReuses a compatible local Copilot credential when possible. --reauth forces GitHub Device Flow.`,
    doctor: `Usage:\n  ${name} doctor [--online] [--compat] [--profile codex|claude|all]\n\nChecks local credentials, client configuration, PM Studio state, and the adapter. --online validates account entitlement; --compat sends minimal inference requests and consumes a small amount of Copilot usage.`,
    status: `Usage:\n  ${name} status\n\nShows bounded runtime, routing, performance, cache, queue, and PM relay metrics from a running adapter.`,
    models: `Usage:\n  ${name} models [--profile codex|claude]\n\nPerforms a fresh, read-only Copilot model-directory lookup for one saved profile.`,
    pms: `Usage:\n  ${name} pms status\n  ${name} pms setup\n  ${name} pm-studio status\n  ${name} pm-studio setup\n\nInspects or installs the version-locked PM Studio loopback patch. setup modifies the installed app only after all preflight checks pass.`,
    "pms setup": `Usage:\n  ${name} pms setup\n\nBacks up, patches, verifies, and ad-hoc signs an exactly supported PM Studio bundle. Unknown versions and drift are never modified.`,
    "pms status": `Usage:\n  ${name} pms status\n\nRead-only inspection of the installed PM Studio version, patch integrity, Claude profile, and relay availability.`,
    usage: `Usage:\n  ${name} usage\n\nSummarizes local token usage metadata without reading prompt or completion content.`,
    "auto-review-model": `Usage:\n  ${name} auto-review-model\n\nInteractively selects an enabled Responses model for Codex Auto-review.`,
    update: `Usage:\n  ${name} update [npm|github]\n\nUpdates the global package from the configured npm registry or GitHub main. With no source, an interactive terminal prompts for one.`,
    version: `Usage:\n  ${name} --version`,
  };
  return sections[topic];
}

export function cliHelp(commandName = "ccdx", topic = "") {
  const name = CLI_COMMANDS.has(commandName) ? commandName : "ccdx";
  const alias = name === "ccdx" ? "codex-copilot-dx" : "ccdx";
  const normalizedTopic = checkedHelpTopic(topic ? topic.split(" ") : []);
  if (normalizedTopic) return `${topicHelp(name, normalizedTopic)}\n\nEquivalent command: ${alias}`;
  return `Usage:
  ${name} [start] [--configure-claude-app] [--show-request-id]
  ${name} auth status [--online]
  ${name} auth login claude [--github-login <login>] [--reauth]
  ${name} doctor [--online] [--compat] [--profile codex|claude|all]
  ${name} status
  ${name} models [--profile codex|claude]
  ${name} pms status
  ${name} pms setup
  ${name} usage
  ${name} auto-review-model
  ${name} update [npm|github]
  ${name} --version
  ${name} --help

Commands:
  start              Start or reuse the adapter and configure local clients
  auth               Inspect or configure the Codex and Claude accounts
  doctor             Diagnose local config; optional live and inference checks
  status             Show runtime routing, performance, queue, and cache health
  models             Query a saved account's live Copilot model catalog
  pms, pm-studio     Inspect or install the PM Studio patch
  usage              Summarize locally recorded token usage
  auto-review-model  Select the Codex Auto-review Responses model
  update             Update the global package from npm or GitHub

Run ${name} <command> --help for command details.

Equivalent command: ${alias}`;
}
