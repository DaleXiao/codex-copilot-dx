import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isPredictionPacUrl } from "./prediction-pac.mjs";

const execute = promisify(execFile);
const apps = new Set(["/Applications/Codex.app", "/Applications/ChatGPT.app"]);

// AppKit asks an existing application to quit normally or become active. It
// never launches a new process and never force-quits an application.
const appScript = `ObjC.import("AppKit");
function run(argv) {
  var app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(Number(argv[0]));
  if (app.isNil()) return "absent";
  if (ObjC.unwrap(app.bundleIdentifier) !== "com.openai.codex" || ObjC.unwrap(app.bundleURL.path) !== argv[1]) return "different";
  var sent = argv[2] === "quit" ? app.terminate : app.activateWithOptions($.NSApplicationActivateIgnoringOtherApps);
  return sent ? "sent" : "refused";
}`;

export async function inspectCodexApp(app, hosts = [], { platform = process.platform, exec = execute, predictionPacUrl } = {}) {
  if (platform !== "darwin") return { status: "unsupported" };
  if (!apps.has(app)) throw new Error("Unrecognized Codex App path");
  const result = await exec("/bin/ps", ["-axo", "pid=,ppid=,comm="], { encoding: "utf8", timeout: 3000, maxBuffer: 4 * 1024 * 1024 });
  const processes = new Map();
  for (const line of String(result?.stdout ?? result).split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (match) processes.set(Number(match[1]), { pid: Number(match[1]), parent: Number(match[2]), command: match[3] });
  }
  const matches = [...processes.values()].filter(row => [`${app}/Contents/MacOS/ChatGPT`, `${app}/Contents/MacOS/Codex`].includes(row.command));
  if (!matches.length) return { status: "stopped" };
  if (matches.length !== 1) return { status: "multiple" };
  const pid = matches[0].pid;
  const belongsToApp = host => {
    if (!host.connected) return false;
    let node = processes.get(host.pid);const visited = new Set();
    while (node && !visited.has(node.pid)) {
      if (node.pid === pid) return true;
      visited.add(node.pid);node = processes.get(node.parent);
    }
    return false;
  };
  const linked = hosts.filter(belongsToApp);
  let predictionRoute;
  if (isPredictionPacUrl(predictionPacUrl)) {
    predictionRoute = "unconfirmed";
    try {
      const result = await exec("/bin/ps", ["-p", String(pid), "-o", "args="], { encoding: "utf8", timeout: 3000, maxBuffer: 64 * 1024 });
      const args = String(result?.stdout ?? result).trim(), executable = matches[0].command;
      const route = /(?:^|\s)--proxy-pac-url=(?:"(http:\/\/127\.0\.0\.1:\d{1,5}\/proxy\.pac(?:\?v=2)?)"|(http:\/\/127\.0\.0\.1:\d{1,5}\/proxy\.pac(?:\?v=2)?)(?=\s|$))/.exec(args);
      if ((args === executable || args.startsWith(executable + " ")) && (args.match(/(?:^|\s)--proxy-pac-url=/g) || []).length === 1
        && (route?.[1] || route?.[2]) === predictionPacUrl) predictionRoute = "verified";
    } catch { /* A missing route is not proof that the App uses one. */ }
  }
  return { status: "running", pid, host: linked.length ? "connected" : "unconfirmed",
    ...(predictionRoute ? { prediction_route: predictionRoute } : {}),
    tool_registration: linked.some(host => host.threads?.length) ? "observed" : "unconfirmed" };
}

export async function controlCodexApp(app, pid, action, { platform = process.platform, exec = execute } = {}) {
  if (platform !== "darwin" || !apps.has(app) || !Number.isSafeInteger(pid) || pid <= 0 || !["quit", "activate"].includes(action)) {
    throw new Error("Invalid Codex App control request");
  }
  const result = await exec("/usr/bin/osascript", ["-l", "JavaScript", "-e", appScript, String(pid), app, action],
    { encoding: "utf8", timeout: 5000, maxBuffer: 4096 });
  const value = String(result?.stdout ?? result).trim();
  if (!["sent", "absent", "different", "refused"].includes(value)) throw new Error("Could not control the verified Codex App");
  return value;
}
