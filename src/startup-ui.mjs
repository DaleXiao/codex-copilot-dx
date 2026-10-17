import { status } from "./status.mjs";
import { terminalCell } from "./terminal-text.mjs";

// The favicon's three ellipses, rasterized as terminal half-blocks. No runtime
// graphics library or terminal cursor control is needed.
const ATOM = [
  "   ▄▀█▄ ▄█▀▄   ",
  "   █ ▄███▄ █   ",
  " ▄▀▀█▀ ▄ ▀█▀▀▄ ",
  " ▀▄▄█▄ ▀ ▄█▄▄▀ ",
  "   █ ▀███▀ █   ",
  "   ▀▄█▀ ▀█▄▀   ",
];

export function startupBanner({ commandName = "ccdx", version, stream = process.stdout, env = process.env } = {}) {
  const title = `${terminalCell(commandName)} v${terminalCell(version)} by Dale Xiao`;
  const color = stream.isTTY === true && !Object.hasOwn(env, "NO_COLOR") && env.TERM !== "dumb";
  if (!color || Number(stream.columns || 80) < 72) return `${title}\nLocal model services for Codex and Claude`;
  const labels = new Map([[1, `${terminalCell(commandName).toUpperCase()} v${terminalCell(version)}`], [2, "by Dale Xiao"], [4, "Codex + Claude / local services"]]);
  return ATOM.map((line, i) => `\x1b[38;2;166;245;168m${line}\x1b[0m${labels.has(i) ? `  ${labels.get(i)}` : ""}`).join("\n");
}

export function startupCheck(kind, name, detail) {
  const prefix = status(kind, "").trimEnd();
  return `${prefix.padEnd(8)}${terminalCell(name).padEnd(12)}${terminalCell(detail)}`;
}

export function startupReady({ baseUrl, commandName = "ccdx", reused = false } = {}) {
  return ["", startupCheck("ok", "Ready", reused ? "Using the existing CCDX adapter" : "Core service available"), "",
    `Web UI  ${baseUrl}`, `Help    ${commandName} help`, ...(!reused ? ["Stop    Ctrl+C"] : []), ""].join("\n");
}

export function startupLogger(name, output = console.log) {
  return value => {
    for (const line of String(value).split("\n")) {
      const match = /^\[(OK|INFO|WARN|ERR|WAIT|DEBUG)\]\s+(.*)$/.exec(line);
      output(match ? startupCheck(match[1].toLowerCase(), name, match[2]) : line);
    }
  };
}

export function predictionStartupCheck(prediction) {
  if (!prediction?.configured) return startupCheck("info", "Prediction", "Off");
  const environment = prediction.environment?.status;
  const problem = ["unavailable", "needs_service_restart", "needs_app_relaunch"].includes(environment);
  let detail = prediction.bridge !== "running" ? prediction.bridge === "recovering" ? "Bridge recovering" : "Bridge unavailable"
    : prediction.active === false ? "Paused; trust and route retained"
    : `Running; App route ${prediction.launch_route === "verified" ? "verified" : prediction.launch_route === "persisted" ? "saved, not verified" : "not verified"}; suggestion unchecked`;
  if (problem) detail += environment === "needs_service_restart" ? "; restart CCDX" : environment === "needs_app_relaunch" ? "; relaunch Codex" : "; environment unavailable";
  const warning = prediction.bridge !== "running" || problem || prediction.launch_route === "unverified";
  const lines = [startupCheck(warning ? "warn" : "info", "Prediction", detail)];
  if (prediction.bridge !== "running" && prediction.reason) lines.push(startupCheck("warn", "Reason", prediction.reason));
  if (warning) lines.push(startupCheck("info", "Details", "ccdx prediction status"));
  return lines.join("\n");
}

// Catalog discovery, client configuration and inference access are distinct.
export function providerStartupSummary(data = {}) {
  if (!data.providers) return { catalogs: "Status unavailable; see WebUI", claude: "Configuration not checked", warning: false };
  const providers = data.providers, ms = providers?.m365;
  const github = data.profiles?.codex?.models || (data.models?.provider !== "m365" ? data.models : null);
  const found = catalog => ["cache", "live"].includes(catalog?.source) && Number.isSafeInteger(catalog?.models ?? catalog?.total) && (catalog.models ?? catalog.total) > 0;
  const githubFound = found(github), m365Found = ms?.enabled !== false && found(ms?.models);
  const catalog = (name, value) => `${name} ${value.models ?? value.total} (${value.source})`;
  const m365State = { disabled: "off", unsupported: "unsupported", checking: "checking", idle: "not checked", unavailable: "unavailable", ready: "ready" }[ms?.state] || "unknown";
  const count = Number(githubFound) + Number(m365Found);
  const catalogs = `${count} catalog${count === 1 ? "" : "s"} found / ${githubFound ? catalog("GitHub", github) : github ? "GitHub not discovered" : "GitHub not checked"}; ${m365Found ? `${catalog("M365", ms.models)}${ms.state !== "ready" ? `, ${m365State}` : ""}` : `M365 ${m365State}`}`;
  const states = { configured: "configured", partially_preserved: "partly configured; custom settings kept", preserved: "custom/managed settings kept", not_installed: "not installed", configuration_unavailable: "config unreadable", not_configured: "not checked" };
  const client = id => states[ms?.claude?.clients?.[id]] || "not checked";
  const gatewayReason = ms?.claude?.reason === "m365_no_claude_models" ? "no Claude models" : m365State;
  const gateway = ms?.claude?.gateway === "running" ? "gateway running" : `gateway off (${gatewayReason})`;
  const claude = `Code: ${client("code")} / App: ${client("app")} / ${gateway}`;
  return { catalogs, claude, warning: Object.values(ms?.claude?.clients || {}).includes("configuration_unavailable") };
}

export function providerStartupChecks(data) {
  const summary = providerStartupSummary(data);
  return `${startupCheck("info", "Providers", summary.catalogs)}\n${startupCheck(summary.warning ? "warn" : "info", "Claude", summary.claude)}`;
}
