import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";

const GITHUB_TOKEN_PATH = path.join(os.homedir(), ".local", "share", "copilot-api", "github_token");

function isPortAccepting(port) {
  return new Promise((resolve) => {
    const sock = net.connect(port, "127.0.0.1");
    let done = false;
    const finish = (v) => { if (done) return; done = true; sock.destroy(); resolve(v); };
    sock.once("connect", () => finish(true));
    sock.once("error", () => finish(false));
    sock.setTimeout(1000, () => finish(false));
  });
}

export async function ensureAuth() {
  if (fs.existsSync(GITHUB_TOKEN_PATH)) {
    console.log("[codex-copilot-dx] GitHub token found");
    return;
  }
  console.log("[codex-copilot-dx] No GitHub token. Running auth...");
  const copilotApiBin = findCopilotApi();
  execSync(`${copilotApiBin} auth`, { stdio: "inherit" });
}

function findCopilotApi() {
  try {
    return execSync("which copilot-api", { encoding: "utf-8" }).trim();
  } catch {
    // Try npx path
    const npxPath = path.join(os.homedir(), ".npm/_npx");
    if (fs.existsSync(npxPath)) {
      for (const dir of fs.readdirSync(npxPath)) {
        const bin = path.join(npxPath, dir, "node_modules/.bin/copilot-api");
        if (fs.existsSync(bin)) return bin;
      }
    }
    return "npx copilot-api";
  }
}

export async function startCopilotApi(port = 4141) {
  if (await isPortAccepting(port)) {
    console.log(`[codex-copilot-dx] copilot-api already running on :${port}`);
    return null;
  }
  console.log(`[codex-copilot-dx] Starting copilot-api on :${port}...`);
  const copilotApiBin = findCopilotApi();
  const child = spawn(copilotApiBin, ["start", "--port", String(port)], {
    stdio: "pipe",
    detached: false,
  });
  child.stdout?.on("data", (d) => {
    const line = d.toString().trim();
    if (line) console.log(`[copilot-api] ${line}`);
  });
  child.stderr?.on("data", (d) => {
    const line = d.toString().trim();
    if (line) console.log(`[copilot-api] ${line}`);
  });

  // Wait for it to be ready
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await isPortAccepting(port)) {
      console.log(`[codex-copilot-dx] copilot-api ready on :${port}`);
      return child;
    }
  }
  throw new Error("copilot-api failed to start");
}

export function openCodex() {
  if (process.platform === "darwin") {
    try {
      spawn("open", ["/Applications/Codex.app"], { detached: true, stdio: "ignore" });
      console.log("[codex-copilot-dx] Codex app launched");
    } catch {
      console.log("[codex-copilot-dx] Codex app not found at /Applications/Codex.app");
      console.log("  Download from: https://openai.com/codex");
    }
  } else {
    console.log("[codex-copilot-dx] Auto-launch not supported on this platform.");
    console.log("  Open Codex manually, it will connect to the adapter.");
  }
}
