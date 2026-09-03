import { MAX_TIMER_DELAY_MS } from "./runtime-config.mjs";

const HELP_COMMANDS = new Set(["help", "--help", "-h"]);
const VERSION_COMMANDS = new Set(["version", "--version", "-v"]);
const START_OPTIONS = new Map([
  ["--show-request-id", "show-request-id"],
]);
const RETIRED_CLAUDE_OPTIONS = new Set([
  "--configure-claude-desktop",
  "--configure-claude-app",
]);
const PM_COMMANDS = new Set(["pms", "pm-studio"]);
const HELP_TOPICS = new Set([
  "",
  "start",
  "auth",
  "auth status",
  "doctor",
  "status",
  "models",
  "usage",
  "animation",
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

function checkedOutputFormat(value) {
  const format = value || "";
  if (!new Set(["table", "plain"]).has(format)) {
    throw new Error(`Format must be table or plain: ${value}`);
  }
  return format;
}

function outputFormatOption(value) {
  return value ? { outputFormat: checkedOutputFormat(value) } : {};
}

function baseCommand(command, extra = {}) {
  return {
    command,
    showRequestId: false,
    online: false,
    compat: false,
    ...extra,
  };
}

function checkedHelpTopic(parts = []) {
  const normalized = parts.map((part, index) => {
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
  if (command === "auth") {
    if (args.length > 1) unexpectedArgs(args.slice(1));
    return helpCommand(["auth", ...args]);
  }
  if (args.length) unexpectedArgs(args);
  return helpCommand([command]);
}

function parseStartOptions(args) {
  if (args.some((option) => RETIRED_CLAUDE_OPTIONS.has(option))) {
    return baseCommand("retired", { integration: "Claude App and Claude Code" });
  }
  const seen = new Set();
  for (const option of args) {
    const kind = START_OPTIONS.get(option);
    if (!kind || seen.has(kind)) unexpectedArgs([option]);
    seen.add(kind);
  }
  return baseCommand("start", {
    showRequestId: seen.has("show-request-id"),
  });
}

export function parseCliArgs(args = []) {
  const [command, ...rest] = args;
  if (!command) return baseCommand("start");
  if (HELP_COMMANDS.has(command)) {
    const topic = rest;
    if (topic.length > 2) unexpectedArgs(topic.slice(2));
    return helpCommand(topic);
  }
  const profileOptionIndex = rest.indexOf("--profile");
  const requestedProfile = profileOptionIndex >= 0 ? rest[profileOptionIndex + 1] : "";
  const retiredClaudeInvocation = RETIRED_CLAUDE_OPTIONS.has(command)
    || (command === "start" && rest.some((option) => RETIRED_CLAUDE_OPTIONS.has(option)))
    || (command === "auth" && rest[0] === "login" && rest[1] === "claude")
    || (command === "models" && requestedProfile === "claude")
    || (command === "doctor" && ["claude", "all"].includes(requestedProfile));
  if (PM_COMMANDS.has(command)) return baseCommand("retired", { integration: "PM Studio" });
  if (retiredClaudeInvocation) {
    return baseCommand("retired", { integration: "Claude App and Claude Code" });
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
    const options = parseOptions(rest, new Map([["--format", "value"]]));
    return baseCommand("usage", outputFormatOption(options["--format"]));
  }
  if (PM_COMMANDS.has(command)) {
    return baseCommand("retired", { integration: "PM Studio" });
  }
  if (command === "models") {
    const options = parseOptions(rest, new Map([
      ["--profile", "value"],
      ["--format", "value"],
    ]));
    const profile = options["--profile"];
    if (profile === "claude") {
      return baseCommand("retired", { integration: "Claude App and Claude Code" });
    }
    if (profile && profile !== "codex") throw new Error(`Profile must be codex: ${profile}`);
    return {
      ...baseCommand("models"),
      ...outputFormatOption(options["--format"]),
    };
  }
  if (command === "auth") {
    const [action, ...authArgs] = rest;
    if (!action) throw new Error("Missing auth action: expected status or login");
    if (action === "status") {
      const options = parseOptions(authArgs, new Map([
        ["--online", "flag"],
        ["--format", "value"],
      ]));
      return {
        ...baseCommand("auth"),
        action: "status",
        profile: "",
        online: Boolean(options["--online"]),
        expectedLogin: "",
        reauth: false,
        ...outputFormatOption(options["--format"]),
      };
    }
    if (action === "login") {
      const [profile, ...loginArgs] = authArgs;
      if (!profile) throw new Error("Missing auth login profile: expected claude");
      if (profile !== "claude") throw new Error(`Auth login profile must be claude: ${profile}`);
      return baseCommand("retired", { integration: "Claude App and Claude Code" });
    }
    throw new Error(`Unknown auth action: ${action}`);
  }
  if (command === "animation") {
    if (rest.length) unexpectedArgs(rest);
    return baseCommand("animation");
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
    const profile = options["--profile"];
    if (profile === "claude" || profile === "all") {
      return baseCommand("retired", { integration: "Claude App and Claude Code" });
    }
    if (profile && profile !== "codex") throw new Error(`Profile must be codex: ${profile}`);
    return {
      ...baseCommand("doctor"),
      online: Boolean(options["--online"]),
      compat: Boolean(options["--compat"]),
    };
  }
  if (RETIRED_CLAUDE_OPTIONS.has(command)) {
    return baseCommand("retired", { integration: "Claude App and Claude Code" });
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
    modelRefreshTimeoutMs: integerEnv(env, "CCDX_MODEL_REFRESH_TIMEOUT_MS", 5000, { min: 1, max: MAX_TIMER_DELAY_MS }),
    existingAdapterTimeoutMs: integerEnv(env, "CCDX_EXISTING_ADAPTER_TIMEOUT_MS", 500, { min: 1, max: MAX_TIMER_DELAY_MS }),
    modelRefreshIntervalMs: integerEnv(env, "CCDX_MODEL_REFRESH_INTERVAL_MS", 2 * 60 * 60 * 1000, { min: 0, max: MAX_TIMER_DELAY_MS }),
    upstreamTimeoutMs: integerEnv(env, "CCDX_UPSTREAM_TIMEOUT_MS", 120000, { min: 1, max: MAX_TIMER_DELAY_MS }),
    streamHandshakeTimeoutMs: integerEnv(env, "CCDX_STREAM_HANDSHAKE_TIMEOUT_MS", 120000, { min: 1, max: MAX_TIMER_DELAY_MS }),
    streamIdleTimeoutMs: integerEnv(env, "CCDX_STREAM_IDLE_TIMEOUT_MS", 120000, { min: 1, max: MAX_TIMER_DELAY_MS }),
    shutdownTimeoutMs: integerEnv(env, "CCDX_SHUTDOWN_TIMEOUT_MS", 5000, { min: 1, max: MAX_TIMER_DELAY_MS }),
  };
}

export function parseAdapterProbeOptions(env = process.env) {
  return {
    adapterPort: integerEnv(env, "ADAPTER_PORT", 2026, { min: 1, max: 65535 }),
    adapterHost: String(env.ADAPTER_HOST || "127.0.0.1").trim() || "127.0.0.1",
    existingAdapterTimeoutMs: integerEnv(env, "CCDX_EXISTING_ADAPTER_TIMEOUT_MS", 500, { min: 1, max: MAX_TIMER_DELAY_MS }),
  };
}

export function cliCommandName() {
  return "ccdx";
}

function topicHelp(name, topic) {
  const sections = {
    start: `Usage:\n  ${name} [start] [--show-request-id]\n\nStarts or reuses the local adapter, updates Codex configuration, and attempts to open Codex or ChatGPT when auto-launch is enabled and supported.`,
    auth: `Usage:\n  ${name} auth status [--online] [--format table|plain]\n\nShows the saved GitHub Copilot account without exposing credentials. --online also verifies its entitlement and model catalog.`,
    "auth status": `Usage:\n  ${name} auth status [--online] [--format table|plain]\n\nShows the saved GitHub Copilot account without exposing credentials. --online also verifies its entitlement and model catalog. Interactive terminals use a table by default.`,
    doctor: `Usage:\n  ${name} doctor [--online] [--compat]\n\nChecks the local credential, Codex configuration, and adapter. --online validates account entitlement; --compat sends minimal inference requests and consumes a small amount of Copilot usage.`,
    status: `Usage:\n  ${name} status\n\nShows bounded runtime, routing, performance, queue, and cache metrics from a running adapter.`,
    models: `Usage:\n  ${name} models [--format table|plain]\n\nPerforms a fresh, read-only Copilot model-directory lookup for the saved account. Interactive terminals use a table by default.`,
    usage: `Usage:\n  ${name} usage [--format table|plain]\n\nSummarizes local token usage metadata without reading prompt or completion content. Interactive terminals use a table by default.`,
    animation: `Usage:\n  ${name} animation\n\nInteractively selects the terminal activity animation used the next time the adapter starts.`,
    "auto-review-model": `Usage:\n  ${name} auto-review-model\n\nInteractively selects an enabled Responses model for Codex Auto-review.`,
    update: `Usage:\n  ${name} update [npm|github]\n\nUpdates the global package from the configured npm registry or GitHub main. With no source, an interactive terminal prompts for one.`,
    version: `Usage:\n  ${name} --version`,
  };
  return sections[topic];
}

export function cliHelp(commandName = "ccdx", topic = "") {
  const name = "ccdx";
  const normalizedTopic = checkedHelpTopic(topic ? topic.split(" ") : []);
  if (normalizedTopic) return topicHelp(name, normalizedTopic);
  return `Usage:
  ${name} [start] [--show-request-id]
  ${name} auth status [--online] [--format table|plain]
  ${name} doctor [--online] [--compat]
  ${name} status
  ${name} models [--format table|plain]
  ${name} usage [--format table|plain]
  ${name} animation
  ${name} auto-review-model
  ${name} update [npm|github]
  ${name} --version
  ${name} --help

Commands:
  start              Start or reuse the adapter and configure Codex
  auth               Inspect the saved GitHub Copilot account
  doctor             Diagnose local config; optional live and inference checks
  status             Show runtime routing, performance, queue, and cache health
  models             Query a saved account's live Copilot model catalog
  usage              Summarize locally recorded token usage
  animation          Select the terminal activity animation
  auto-review-model  Select the Codex Auto-review Responses model
  update             Update the global package from npm or GitHub

Run ${name} <command> --help for command details.`;
}
