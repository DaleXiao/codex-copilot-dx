import { isProviderId } from "./provider-metadata.mjs";
import { MAX_TIMER_DELAY_MS } from "./runtime-config.mjs";

const HELP_COMMANDS = new Set(["help", "--help", "-h"]);
const VERSION_COMMANDS = new Set(["version", "--version", "-v"]);
const START_OPTIONS = new Map([
  ["--show-request-id", "show-request-id"],
  ["--no-browser", "no-browser"],
  ["--verbose", "verbose"],
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
  "doctor config",
  "status",
  "models",
  "usage",
  "cache",
  "limits",
  "animation",
  "enable-image",
  "disable-image",
  "image-status",
  "auto-review-model",
  "suggestion",
  "prediction",
  "m365",
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
    ...(seen.has("no-browser") ? { noBrowser: true } : {}),
    ...(seen.has("verbose") ? { verbose: true } : {}),
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
    || (command === "doctor" && rest[0] !== "config" && ["claude", "all"].includes(requestedProfile));
  if (PM_COMMANDS.has(command)) return baseCommand("retired", { integration: "PM Studio" });
  if (retiredClaudeInvocation) {
    return baseCommand("retired", { integration: "Claude App and Claude Code" });
  }
  if ((command === "doctor" || command === "--doctor") && rest[0] === "config") {
    if (rest.length === 2 && HELP_COMMANDS.has(rest[1])) return helpCommand(["doctor", "config"]);
    if (rest.length > 1) unexpectedArgs(rest.slice(1));
    return baseCommand("doctor", { configOnly: true });
  }
  const requestedHelp = nestedHelp(command, rest);
  if (requestedHelp) return requestedHelp;
  if (VERSION_COMMANDS.has(command)) {
    if (rest.length) unexpectedArgs(rest);
    return baseCommand("version");
  }
  if (command === "start") return parseStartOptions(rest);
  if (command === "m365") {
    const [action = "status", ...args] = rest;
    if (!["status", "models", "switch", "on", "off", "remove"].includes(action)) throw new Error("M365 action must be status, models, switch, on, off or remove");
    let provider, remaining = args;
    if (action === "switch" && args[0] && !args[0].startsWith("--")) { provider = args[0];remaining = args.slice(1); }
    if (provider && !["github", "m365"].includes(provider)) throw new Error("Provider must be github or m365");
    const values = parseOptions(remaining, new Map(action === "switch" ? [["--model", "value"], ["--auto-review-model", "value"]] : []));
    return baseCommand("m365", { action, provider, model: values["--model"], autoReviewModel: values["--auto-review-model"] });
  }
  if (command === "status" || command === "--status") {
    if (rest.length) unexpectedArgs(rest);
    return baseCommand("status");
  }
  if (command === "usage") {
    const options = parseOptions(rest, new Map([["--format", "value"], ["--provider", "value"]]));
    if (options["--provider"] && !isProviderId(options["--provider"])) throw new Error("Usage provider must be a valid provider ID");
    return baseCommand("usage", { ...outputFormatOption(options["--format"]), ...(options["--provider"] ? { provider: options["--provider"] } : {}) });
  }
  if (command === "cache") {
    let cacheArgs = rest;
    if (rest.length === 1 && /^-\d+$/.test(rest[0])) {
      cacheArgs = ["--limit", rest[0].slice(1)];
    } else if (rest[0] === "-clean") {
      cacheArgs = ["--clean", ...rest.slice(1)];
    }
    const options = parseOptions(cacheArgs, new Map([
      ["--limit", "value"],
      ["--clean", "flag"],
      ["--history", "flag"],
      ["--yes", "flag"],
    ]));
    if (options["--limit"] && options["--clean"]) {
      throw new Error("Use --limit or --clean in one cache command, not both");
    }
    if ((options["--history"] || options["--yes"]) && !options["--clean"]) {
      throw new Error("--history and --yes require --clean");
    }
    const rawLimit = options["--limit"];
    if (rawLimit && rawLimit !== "default" && !/^\d+$/.test(rawLimit)) {
      throw new Error(`Cache limit must be an integer MiB value or default: ${rawLimit}`);
    }
    return baseCommand("cache", {
      action: rawLimit ? "limit" : options["--clean"] ? "clean" : "status",
      limitMib: rawLimit && rawLimit !== "default" ? Number(rawLimit) : undefined,
      resetLimit: rawLimit === "default",
      history: Boolean(options["--history"]),
      yes: Boolean(options["--yes"]),
    });
  }
  if (command === "limits") {
    const limitArgs = rest.length === 1 && /^-\d+$/.test(rest[0])
      ? ["--decoded", rest[0].slice(1)]
      : rest;
    const options = parseOptions(limitArgs, new Map([["--decoded", "value"]]));
    const rawLimit = options["--decoded"];
    if (rawLimit && rawLimit !== "default" && !/^\d+$/.test(rawLimit)) {
      throw new Error(`Decoded request-body limit must be an integer MiB value or default: ${rawLimit}`);
    }
    return baseCommand("limits", {
      action: rawLimit ? "set" : "status",
      limitMib: rawLimit && rawLimit !== "default" ? Number(rawLimit) : undefined,
      resetLimit: rawLimit === "default",
    });
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
  if (command === "prediction") {
    const [action = "status", ...extra] = rest;
    if (!["on", "off", "status", "fix"].includes(action)) throw new Error("Prediction action must be on, off, status, or fix");
    if (extra.length) unexpectedArgs(extra);
    return baseCommand("prediction", { action });
  }
  if (command === "suggestion") {
    const [action = "status", model, ...extra] = rest;
    if (!["on", "off", "model", "status"].includes(action)) throw new Error("Suggestion action must be on, off, model, or status");
    if (extra.length || (model !== undefined && action !== "model")) unexpectedArgs(rest.slice(1));
    if (["on", "model"].includes(action)) throw new Error("The CCDX prediction panel has been retired; use ccdx prediction for the separate optional native feature");
    return baseCommand("suggestion", { action });
  }
  if (command === "enable-image" || command === "disable-image" || command === "image-status") {
    if (rest.length) unexpectedArgs(rest);
    return baseCommand("image", {
      action: command === "enable-image" ? "enable" : command === "disable-image" ? "disable" : "status",
    });
  }
  if (command === "auto-review-model") {
    if (rest.length) unexpectedArgs(rest);
    return baseCommand("auto-review-model");
  }
  if (command === "update") {
    const permission = rest.filter(value => value === "--allow-remote");
    if (permission.length > 1) throw new Error("--allow-remote may be specified only once");
    const sources = rest.filter(value => value !== "--allow-remote");
    if (sources.length > 1) unexpectedArgs(sources.slice(1));
    const source = sources[0];
    if (source && !new Set(["npm", "github", "gh"]).has(source)) {
      throw new Error(`Update source must be npm or github: ${source}`);
    }
    return {
      ...baseCommand("update"),
      updateSource: source === "gh" ? "github" : source,
      allowRemote: permission.length === 1,
    };
  }
  if (command === "doctor" || command === "--doctor") {
    const options = parseOptions(rest, new Map([
      ["--online", "flag"],
      ["--compat", "flag"],
      ["--fix", "flag"],
      ["--json", "flag"],
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
      ...(options["--fix"] ? { fix: true } : {}),
      ...(options["--json"] ? { json: true } : {}),
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

export function parseAdapterAddressOptions(env = process.env) {
  return {
    adapterPort: integerEnv(env, "ADAPTER_PORT", 2026, { min: 1, max: 65535 }),
    adapterHost: String(env.ADAPTER_HOST || "127.0.0.1").trim() || "127.0.0.1",
  };
}

export function parseRuntimeOptions(env = process.env) {
  return {
    ...parseAdapterAddressOptions(env),
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
    ...parseAdapterAddressOptions(env),
    existingAdapterTimeoutMs: integerEnv(env, "CCDX_EXISTING_ADAPTER_TIMEOUT_MS", 500, { min: 1, max: MAX_TIMER_DELAY_MS }),
  };
}

export function cliCommandName() {
  return "ccdx";
}

function topicHelp(name, topic) {
  const sections = {
    start: `Usage:\n  ${name} [start] [--show-request-id] [--no-browser] [--verbose]\n\nStarts or reuses the local adapter, updates Codex configuration, and attempts to open Codex App when auto-launch is enabled and supported. Interactive desktop starts also open WebUI once; --no-browser skips that attempt. After startup the terminal shows fixed status/returned usage; --verbose or --show-request-id retains request detail.`,
    auth: `Usage:\n  ${name} auth status [--online] [--format table|plain]\n\nShows the saved GitHub Copilot account without exposing credentials. --online also verifies its entitlement and model catalog.`,
    "auth status": `Usage:\n  ${name} auth status [--online] [--format table|plain]\n\nShows the saved GitHub Copilot account without exposing credentials. --online also verifies its entitlement and model catalog. Interactive terminals use a table by default.`,
    doctor: `Usage:\n  ${name} doctor [--online] [--compat] [--fix] [--json]\n  ${name} doctor config\n\nChecks credentials, managed configuration, command launchers, adapter, enabled optional features and observed client catalog. Default is read-only; no inference requests. --online validates account entitlement; --compat sends minimal inference requests and consumes a small amount of Copilot usage, requiring successful model completion rather than HTTP 200 alone. --fix repairs owned Windows launchers and managed config, imports a verified existing credential only if none is saved, and asks the running adapter to repair enabled predictions once. No interactive login, client program edits, forced App restarts, policy changes or optional feature activation. Missing-credential repair can contact GitHub without --online. Changed existing config is backed up to config.toml.ccdx-doctor.bak. Partial repairs exit 1. --json emits a redacted report, including before_checks for repairs. App-internal cache and visible predictions are not externally verified. The config subcommand remains strictly read-only.`,
    "doctor config": `Usage:\n  ${name} doctor config\n\nReads ~/.codex/config.toml, checks TOML syntax and CCDX-managed settings, and previews the existing startup writer's changes. Does not merge Codex profiles or validate the complete installed Codex schema. No authentication, network requests, file writes, or adapter/GUI startup. Existing context_management=false is valid. Exit 1 for errors, 0 for OK/warnings; unsupported arguments exit 2.`,
    status: `Usage:\n  ${name} status\n\nShows bounded runtime, routing, performance, queue, and cache metrics from a running adapter.`,
    models: `Usage:\n  ${name} models [--format table|plain]\n\nShows GPT models for the selected Codex provider. GitHub performs a fresh read-only lookup; M365 uses its isolated catalog in the running service. Interactive terminals use a table by default.`,
    usage: `Usage:\n  ${name} usage [--format table|plain] [--provider ID]\n\nSummarizes local token usage metadata without reading prompt or completion content. Optional provider filtering separates sources; default totals include all recorded sources. Interactive terminals use a table by default.`,
    cache: `Usage:\n  ${name} cache\n  ${name} cache --limit <MiB|default>\n  ${name} cache --clean [--history] [--yes]\n\nShows runtime cache use, saves and applies the shared response-history limit, or clears the rebuildable image-transform cache. --history also clears in-memory response history for all tasks and can make their next continuation fail, so interactive confirmation or --yes is required. Generated image files and saved Codex transcripts are never deleted. Short aliases: -128 sets 128 MiB and -clean equals --clean.`,
    limits: `Usage:\n  ${name} limits\n  ${name} limits --decoded <MiB|default>\n\nShows configured and running request-body limits, or saves a decoded request-body limit from 128 to 512 MiB. The raw-body limit is unchanged. Restart ccdx to apply a saved change; no conversation or cache is cleared. Short alias: -256 sets 256 MiB.`,
    animation: `Usage:\n  ${name} animation\n\nPreviews all terminal activity animations together and selects the saved theme. Running CCDX 1.1.0+ applies it live; older services need a restart.`,
    "enable-image": `Usage:\n  ${name} enable-image\n\nInteractively configures an HTTPS image API endpoint (base URLs are also accepted) and API key, detects its supported image model and protocol, installs CCDX image guidance, and checks the local image tool for Codex App without generating an image. A blank key preserves the saved key only for the same origin; a new origin requires explicit key entry. Concurrent unrelated config edits are preserved.`,
    "disable-image": `Usage:\n  ${name} disable-image\n\nDisables the local CCDX image tool and removes its stored API credential and unmodified CCDX image guidance.`,
    "image-status": `Usage:\n  ${name} image-status\n\nShows provider configuration and locally advertised generation/editing tools without generating an image or exposing its API key.`,
    "auto-review-model": `Usage:\n  ${name} auto-review-model\n\nSelect a Responses model, then an advertised reasoning effort. Enter keeps the default/current choice; q cancels both steps without saving. Effort 0 follows the client (low when omitted). Settings apply only to Auto-review on the next request; no client patch or restart is required for adapters running 0.9.13 or newer.`,
    "suggestion": `The CCDX prediction panel has been retired. Run ${name} suggestion off to safely remove unchanged CCDX registrations. This cleanup does not change native predictions; see ${name} prediction --help for that separate opt-in feature.`,
    m365: `Usage:\n  ${name} m365 [status|models|on|off|remove]\n  ${name} m365 switch [github|m365] [--model ID] [--auto-review-model ID]\n\nM365 is discovered silently at startup on supported managed environments. Claude uses its separate local gateway. Codex stays on GitHub unless you explicitly switch. M365 switching requires a running compatible adapter and available GPT/Auto-review choices; it never substitutes unavailable models. Select an available model in Codex after switching an existing thread. Off restores only owned Claude settings and selects GitHub. Remove also clears the CCDX M365 profile, retaining a disabled preference and historical usage. System Microsoft sign-in, GitHub credentials, predictions and images are preserved.`,
    prediction: `Usage:\n  ${name} prediction [status|on|off|fix]\n\nOptional native next-message predictions; off by default. macOS and Windows. Windows requires the registered official MSIX App, an initialized profile, Windows PowerShell and .NET Framework 4.7.2+; Git/OpenSSL is not required for prediction setup. Quit Codex before on/off, then restart ccdx. On adds private App-profile certificate trust and an App-only route for chatgpt.com and ab.chatgpt.com. HTTPS on those hosts is decrypted locally; only prediction configuration is changed. No client program files, OS trust, account permissions, MCP or Hooks are changed. Static HTTP/HTTPS/SOCKS5 proxies and bypass rules are preserved. Windows supports company PAC/WPAD; macOS dynamic PAC/WPAD remains unsupported. Static IPv4/IPv6 CIDRs match URL IP literals without DNS. The bridge port persists across restarts/updates; a busy saved port disables only predictions. Launch/reuse checks the App's actual route; an older random or missing route may require one full App quit. Official prediction configuration is preserved; the conversation's model is used. App updates require another compatibility check. Status distinguishes saved preference and observed config traffic from unverified candidate visibility.\n\nFix asks a compatible running CCDX adapter to repair the enabled bridge once on its saved port. It never enables predictions, renews certificates or force-restarts Codex. Healthy unchanged bridges are retained. Fix rechecks system proxy settings. Changed routes may need a normal App relaunch to reload cached PAC; failed rechecks preserve the previous bridge with a nonzero exit. Process environment variables and Node trust are not hot-reloaded; changed trust inputs need a CCDX service restart. Startup, status and doctor share sanitized environment diagnostics. Missing App routes require a normal full quit and ccdx launch; partial repair exits 1. An older adapter must first be upgraded and restarted once to gain this repair endpoint.`,
    update: `Usage:\n  ${name} update [npm|github] [--allow-remote]\n\nUpdates the global package from the configured npm registry or the latest stable GitHub release. With no source, an interactive terminal prompts for one. Windows uses system cmd.exe to run npm.cmd without changing PowerShell policy; use the .cmd entrypoint if scripts are blocked. GitHub installs require Git on PATH and dependencies may still use the configured npm registry. By default npm's remote-download policy is preserved. If npm reports EALLOWREMOTE for a trusted mirror tarball, --allow-remote explicitly permits URL dependencies for this one installation's entire dependency tree; it is not a hostname allowlist. No .npmrc, registry or persistent policy is changed, and failed installations are not retried automatically. Use this only if company policy permits it. Restart the running adapter after installation.`,
    version: `Usage:\n  ${name} --version`,
  };
  return sections[topic];
}

export function cliHelp(commandName = "ccdx", topic = "") {
  const name = "ccdx";
  const normalizedTopic = checkedHelpTopic(topic ? topic.split(" ") : []);
  if (normalizedTopic) return topicHelp(name, normalizedTopic);
  return `Usage:
  ${name} [start] [--show-request-id] [--no-browser] [--verbose]
  ${name} auth status [--online] [--format table|plain]
  ${name} doctor [--online] [--compat] [--fix] [--json]
  ${name} doctor config
  ${name} status
  ${name} models [--format table|plain]
  ${name} usage [--format table|plain] [--provider ID]
  ${name} cache [--limit <MiB|default> | --clean [--history] [--yes]]
  ${name} limits [--decoded <MiB|default>]
  ${name} animation
  ${name} enable-image
  ${name} disable-image
  ${name} image-status
  ${name} auto-review-model
  ${name} prediction [status|on|off|fix]
  ${name} m365 [status|models|switch|on|off|remove]
  ${name} update [npm|github] [--allow-remote]
  ${name} --version
  ${name} --help

Commands:
  start              Start or reuse the adapter and configure Codex
  auth               Inspect the saved GitHub Copilot account
  doctor             Diagnose local config; optional live and inference checks
  status             Show runtime routing, performance, queue, and cache health
  models             Show the selected Codex provider's GPT model catalog
  usage              Summarize locally recorded token usage
  cache              Inspect, size, or clear bounded runtime caches
  limits             Inspect or configure the decoded request-body limit
  animation          Select the terminal activity animation
  enable-image       Configure and enable the optional image provider
  disable-image      Disable the image provider and remove its credential
  image-status       Show the optional image provider status
  auto-review-model  Select the Codex Auto-review model and reasoning effort
  prediction         Toggle optional native next-message predictions
  m365               Manage M365 Claude access and the optional Codex backup
  update             Update the global package from npm or GitHub

Run ${name} <command> --help for command details.`;
}
