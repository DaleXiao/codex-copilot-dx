import { status } from "./status.mjs";
import { terminalCell } from "./terminal-text.mjs";

// The favicon's three ellipses, rasterized as terminal half-blocks. No runtime
// graphics library or terminal cursor control is needed.
const ATOM = [
  "     ▄█▀█▄▄ ▄▄█▀█▄     ",
  "     █    ███    █     ",
  "     █ ▄▄▄█▄█▄▄▄ █     ",
  "  ▄▄▀▀█▀█▀   ▀█▀█▀▀▄▄  ",
  " █▀   ▀█  ▄█▄  █▀   ▀█ ",
  " ▀█▄  █▀▄  ▀  ▄▀█  ▄█▀ ",
  "    ▀█▀███▄▄▄███▀█▀    ",
  "     █    █▄█    █     ",
  "     █▄ ▄▄█▀█▄▄ ▄█     ",
  "      ▀▀▀     ▀▀▀      ",
];

export function startupBanner({ commandName = "ccdx", version, stream = process.stdout, env = process.env } = {}) {
  const title = `${terminalCell(commandName)} v${terminalCell(version)} by Dale Xiao`;
  const color = stream.isTTY === true && !Object.hasOwn(env, "NO_COLOR") && env.TERM !== "dumb";
  if (!color || Number(stream.columns || 80) < 72) return `${title}\nUse Codex App with GitHub Copilot`;
  const labels = new Map([[3, `${terminalCell(commandName).toUpperCase()} v${terminalCell(version)}`], [4, "by Dale Xiao"], [6, "Codex App + GitHub Copilot"]]);
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
  if (prediction.bridge !== "running") return startupCheck("warn", "Prediction", prediction.reason || "Bridge unavailable; core service is available");
  const route = prediction.launch_route;
  const summary = startupCheck(route === "unverified" ? "warn" : "info", "Prediction", route === "verified"
    ? "Bridge running; App route verified; suggestion not checked"
    : "Bridge running; App route not verified; suggestion not checked");
  return prediction.recovery ? `${summary}\n${startupCheck("info", "Recovery", `${prediction.recovery.attempts}/3 attempts used; persistent route ${prediction.persistence || "unknown"}`)}` : summary;
}
