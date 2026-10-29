import { parseManagedCommand, managedCommandHelp, rootCommandHelp } from "./cli-command-spec.mjs";
import { MAX_TIMER_DELAY_MS } from "./runtime-config.mjs";

const base = value => ({ command: "manage", showRequestId: false, online: false, compat: false, ...value });
export function parseCliArgs(input = []) {
  let args = [...input];
  if (
    !args.length ||
    (args[0].startsWith("--") && ["--no-browser", "--verbose", "--show-request-id"].includes(args[0]))
  )
    args.unshift("start");
  if (["--version", "-v"].includes(args[0])) args[0] = "version";
  const help = ["help", "--help", "-h"].includes(args[0])
    ? args.slice(1)
    : ["--help", "-h"].includes(args.at(-1))
      ? args.slice(0, -1)
      : null;
  if (help) {
    if (help.length && managedCommandHelp(help) === null)
      throw new Error(`Unknown help topic: ${help.join(" ")}`);
    return base({ command: "help", helpTopic: help.join(" ") });
  }
  if (["app", "config", "source"].includes(args[0]) && args.length === 1)
    return base({ command: "help", helpTopic: args[0] });
  const parsed = parseManagedCommand(args);
  return base(parsed.dispatch || parsed);
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
    modelRefreshTimeoutMs: integerEnv(env, "CCDX_MODEL_REFRESH_TIMEOUT_MS", 5000, {
      min: 1,
      max: MAX_TIMER_DELAY_MS,
    }),
    existingAdapterTimeoutMs: integerEnv(env, "CCDX_EXISTING_ADAPTER_TIMEOUT_MS", 500, {
      min: 1,
      max: MAX_TIMER_DELAY_MS,
    }),
    modelRefreshIntervalMs: integerEnv(env, "CCDX_MODEL_REFRESH_INTERVAL_MS", 2 * 60 * 60 * 1000, {
      min: 0,
      max: MAX_TIMER_DELAY_MS,
    }),
    upstreamTimeoutMs: integerEnv(env, "CCDX_UPSTREAM_TIMEOUT_MS", 120000, {
      min: 1,
      max: MAX_TIMER_DELAY_MS,
    }),
    streamHandshakeTimeoutMs: integerEnv(env, "CCDX_STREAM_HANDSHAKE_TIMEOUT_MS", 120000, {
      min: 1,
      max: MAX_TIMER_DELAY_MS,
    }),
    streamIdleTimeoutMs: integerEnv(env, "CCDX_STREAM_IDLE_TIMEOUT_MS", 120000, {
      min: 1,
      max: MAX_TIMER_DELAY_MS,
    }),
    shutdownTimeoutMs: integerEnv(env, "CCDX_SHUTDOWN_TIMEOUT_MS", 5000, { min: 1, max: MAX_TIMER_DELAY_MS }),
  };
}

export function parseAdapterProbeOptions(env = process.env) {
  return {
    ...parseAdapterAddressOptions(env),
    existingAdapterTimeoutMs: integerEnv(env, "CCDX_EXISTING_ADAPTER_TIMEOUT_MS", 500, {
      min: 1,
      max: MAX_TIMER_DELAY_MS,
    }),
  };
}

export function cliCommandName() {
  return "ccdx";
}

const integrationNotes = {
  prediction:
    "Optional native suggestions are off by default. Windows requires the initialized official MSIX App profile, Windows PowerShell and .NET Framework 4.7.2+; Git/OpenSSL is not required. The bridge port persists across restarts/updates; a busy saved port disables predictions only. Setup/removal requires Codex to be closed, then a normal CCDX restart. HTTPS on chatgpt.com and ab.chatgpt.com is decrypted locally; only prediction configuration is changed. App-profile trust and routing are used; no OS trust or client program files are changed. Proxy/PAC policy is preserved. Repair never enables predictions or force-restarts Codex. Environment trust changes require a service restart.",
  image:
    "Setup configures the image API and private credential without generating an image. An empty key keeps the saved key only for the same origin. Pause keeps credentials; remove deletes the stored image credential and unchanged CCDX guidance.",
  review:
    "Select an available model and reasoning level. Enter keeps the choice; q cancels without saving. The next review request uses the saved choice.",
  doctor:
    "Default checks are read-only and do not send inference. --online checks access; --compat sends minimal inference and consumes usage. --fix changes only owned configuration and launchers, backs up changed config, and never enables optional features or force-restarts Apps. Missing-credential repair can contact GitHub. Partial repairs exit 1.",
};
export function cliHelp(commandName = "ccdx", topic = "") {
  if (!topic) return rootCommandHelp();
  const parts = topic.split(" "),
    help = managedCommandHelp(parts);
  if (help === null) throw new Error(`Unknown help topic: ${topic}`);
  const feature =
    parts[0] === "app" && parts[1] === "codex"
      ? parts[2]
      : parts[0] === "doctor" && parts.length === 1
        ? "doctor"
        : null;
  return help + (integrationNotes[feature] ? "\n\n" + integrationNotes[feature] : "");
}
