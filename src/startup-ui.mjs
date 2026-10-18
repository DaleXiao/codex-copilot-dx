import { status } from "./status.mjs";
import { terminalCell } from "./terminal-text.mjs";
import { colorTerminalText } from "./terminal-colors.mjs";
import { terminalColorPreference } from "./user-settings.mjs";

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

export function startupBanner({ commandName = "ccdx", version, stream = process.stdout, env = process.env, home, colorTheme } = {}) {
  const title = `${terminalCell(commandName)} v${terminalCell(version)} by Dale Xiao`;
  const color = stream.isTTY === true && !Object.hasOwn(env, "NO_COLOR") && env.TERM !== "dumb";
  if (!color || Number(stream.columns || 80) < 72) return `${title}\nLocal model services for Codex and Claude`;
  const labels = new Map([[1, `${terminalCell(commandName).toUpperCase()} v${terminalCell(version)}`], [2, "by Dale Xiao"], [4, "Codex + Claude / local services"]]);
  const theme = colorTheme || terminalColorPreference({ env, home });
  return ATOM.map((line, i) => `${colorTerminalText(line, theme, { output: stream, env })}${labels.has(i) ? `  ${labels.get(i)}` : ""}`).join("\n");
}

export function startupCheck(kind, name, detail) {
  const prefix = status(kind, "").trimEnd();
  return `${prefix.padEnd(8)}${terminalCell(name).padEnd(12)}${terminalCell(detail)}`;
}

export function startupReady({ baseUrl, commandName = "ccdx", reused = false } = {}) {
  return ["", startupCheck("ok", "Ready", reused ? "Using the running service" : "Local service ready"), "",
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
  if (!prediction?.configured) return startupCheck("info", "Suggestions", "Off");
  const environment = prediction.environment?.status;
  const problem = ["unavailable", "needs_service_restart", "needs_app_relaunch"].includes(environment);
  let detail = prediction.bridge !== "running" ? prediction.bridge === "recovering" ? "Bridge recovering" : "Bridge unavailable"
    : prediction.active === false ? "Paused; trust and route retained"
    : "Running; suggestion display not verified";
  if (problem) detail += environment === "needs_service_restart" ? "; restart CCDX" : environment === "needs_app_relaunch" ? "; relaunch Codex" : "; environment unavailable";
  const warning = prediction.bridge !== "running" || problem || prediction.launch_route === "unverified";
  const lines = [startupCheck(warning ? "warn" : "info", "Suggestions", detail)];
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
  const sourceLines = [`${count} source${count === 1 ? "" : "s"} with model lists`,
    githubFound ? catalog("GitHub", github) : github ? "GitHub not discovered" : "GitHub not checked",
    m365Found ? `${catalog("M365", ms.models)}${ms.state !== "ready" ? `, ${m365State}` : ""}` : `M365 ${m365State}`];
  const catalogs = `${sourceLines[0]} / ${sourceLines.slice(1).join("; ")}`;
  const states = { configured: "configured", restored: "settings restored", partially_preserved: "partly configured; custom settings kept", preserved: "custom/managed settings kept", not_installed: "not installed", configuration_unavailable: "config unreadable", not_configured: "not checked" };
  const client = id => states[ms?.claude?.clients?.[id]] || "not checked";
  const gatewayReason = ms?.claude?.reason === "m365_no_claude_models" ? "no Claude models" : m365State;
  const gateway = ms?.claude?.gateway === "running" ? "local service running" : `local service off (${gatewayReason})`;
  const claude = `Code: ${client("code")} / App: ${client("app")} / ${gateway}`;
  const shortStates = { configured: "set", restored: "restored", partially_preserved: "partial", preserved: "custom kept", not_installed: "not installed", configuration_unavailable: "unreadable" };
  return { catalogs, claude, sourceLines, claudeLines: [`Claude Code: ${client("code")}`, `Claude App: ${client("app")}`, gateway],
    compactSources: [`Lists ${count} / ${githubFound ? catalog("GitHub", github) : "GitHub not checked"}`, m365Found ? catalog("M365", ms.models) : `M365 ${m365State}`],
    compactClaude: [`Code: ${shortStates[ms?.claude?.clients?.code] || "unchecked"} / App: ${shortStates[ms?.claude?.clients?.app] || "unchecked"}`,
      ms?.claude?.gateway === "running" ? "Claude service: running" : `Claude service: off (${gatewayReason})`],
    warning: Object.values(ms?.claude?.clients || {}).includes("configuration_unavailable") };
}

export function providerStartupChecks(data) {
  const summary = providerStartupSummary(data);
  return `${startupCheck("info", "Sources", summary.catalogs)}\n${startupCheck(summary.warning ? "warn" : "info", "Claude", summary.claude)}`;
}
