import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { status } from "./status.mjs";

const CLIENT_ID = "Iv1.b507a08c87ecfe98"; // Public GitHub Copilot client ID.
const SCOPE = "read:user";
const GITHUB_TOKEN_PATH = path.join(os.homedir(), ".local", "share", "copilot-api", "github_token");

// Map GitHub polling responses to a small local state machine.
export function interpretPoll(data) {
  if (typeof data.access_token === "string" && data.access_token) return { state: "done", token: data.access_token };
  switch (data.error) {
    case "authorization_pending": return { state: "wait" };
    case "slow_down": return { state: "slow" };
    default: return { state: "fail", error: data.error || "unknown" };
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// On macOS, copy the user code and open the verification page. Fail quietly.
function openAndCopy(userCode, verificationUri) {
  if (process.platform !== "darwin") return;
  try {
    const pb = spawn("pbcopy");
    pb.on("error", () => {});
    pb.stdin.on("error", () => {});
    pb.on("close", (code) => {
      if (code === 0) console.log(status("ok", "Device code copied to the clipboard"));
    });
    pb.stdin.write(userCode);
    pb.stdin.end();
  } catch {}
  try {
    const op = spawn("open", [verificationUri], { detached: true, stdio: "ignore" });
    op.on("error", () => {});
  } catch {}
}

export async function ensureAuth() {
  if (fs.existsSync(GITHUB_TOKEN_PATH)) {
    console.log(status("ok", "GitHub token found"));
    return;
  }
  console.log(status("wait", "No GitHub token found. Starting device login..."));

  // Request a device code.
  const codeResp = await fetch("https://github.com/login/device/code", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ client_id: CLIENT_ID, scope: SCOPE }),
  });
  if (!codeResp.ok) throw new Error(`device code request failed: ${codeResp.status}`);
  const { device_code, user_code, verification_uri, interval } = await codeResp.json();

  // Prompt the user.
  console.log(`\n${status("info", `Open ${verification_uri}`)}\n${status("info", `Enter code: ${user_code}`)}\n`);
  openAndCopy(user_code, verification_uri);

  // Poll until GitHub completes the device flow.
  let waitMs = (interval || 5) * 1000;
  while (true) {
    await sleep(waitMs);
    const pollResp = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        device_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });
    if (!pollResp.ok) {
      // Treat transient network/server errors as pending and retry.
      continue;
    }
    const data = await pollResp.json();
    const r = interpretPoll(data);
    if (r.state === "done") {
      writeToken(r.token);
      console.log(status("ok", "Login successful"));
      return;
    }
    if (r.state === "slow") { waitMs += 5000; continue; }
    if (r.state === "fail") throw new Error(`Login failed: ${r.error}`);
    // wait: continue polling.
  }
}

function writeToken(token) {
  fs.mkdirSync(path.dirname(GITHUB_TOKEN_PATH), { recursive: true });
  fs.writeFileSync(GITHUB_TOKEN_PATH, token, { mode: 0o600 });
}
