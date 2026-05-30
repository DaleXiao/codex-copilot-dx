import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";

const CLIENT_ID = "Iv1.b507a08c87ecfe98"; // GitHub Copilot 官方公开 client_id
const SCOPE = "read:user";
const GITHUB_TOKEN_PATH = path.join(os.homedir(), ".local", "share", "copilot-api", "github_token");

// 纯函数：把 GitHub poll 响应映射为状态。
export function interpretPoll(data) {
  if (typeof data.access_token === "string" && data.access_token) return { state: "done", token: data.access_token };
  switch (data.error) {
    case "authorization_pending": return { state: "wait" };
    case "slow_down": return { state: "slow" };
    default: return { state: "fail", error: data.error || "unknown" };
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// macOS：复制 user_code 到剪贴板 + 打开验证页。失败静默降级。
function openAndCopy(userCode, verificationUri) {
  if (process.platform !== "darwin") return;
  try {
    const pb = spawn("pbcopy");
    pb.on("error", () => {});
    pb.stdin.on("error", () => {});
    pb.on("close", (code) => {
      if (code === 0) console.log("[codex-copilot-dx] (user code 已复制到剪贴板)");
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
    console.log("[codex-copilot-dx] GitHub token found");
    return;
  }
  console.log("[codex-copilot-dx] No GitHub token. Starting login...");

  // 1. 请求 device code
  const codeResp = await fetch("https://github.com/login/device/code", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ client_id: CLIENT_ID, scope: SCOPE }),
  });
  if (!codeResp.ok) throw new Error(`device code request failed: ${codeResp.status}`);
  const { device_code, user_code, verification_uri, interval } = await codeResp.json();

  // 2. 提示用户
  console.log(`\n  打开 ${verification_uri}\n  输入码: ${user_code}\n`);
  openAndCopy(user_code, verification_uri);

  // 3. 轮询
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
      // 瞬时网络/服务端错误：当作 pending，下一轮重试
      continue;
    }
    const data = await pollResp.json();
    const r = interpretPoll(data);
    if (r.state === "done") {
      writeToken(r.token);
      console.log("[codex-copilot-dx] Login successful");
      return;
    }
    if (r.state === "slow") { waitMs += 5000; continue; }
    if (r.state === "fail") throw new Error(`Login failed: ${r.error}`);
    // wait → 继续
  }
}

function writeToken(token) {
  fs.mkdirSync(path.dirname(GITHUB_TOKEN_PATH), { recursive: true });
  fs.writeFileSync(GITHUB_TOKEN_PATH, token, { mode: 0o600 });
}
