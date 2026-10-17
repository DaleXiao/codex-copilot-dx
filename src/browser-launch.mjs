import { spawn } from "node:child_process";
import path from "node:path";

export async function openDashboard(baseUrl, { env = process.env, platform = process.platform, spawnImpl = spawn,
  interactive = process.stdout.isTTY === true, enabled = true, timeoutMs = 3000 } = {}) {
  const url = new URL(baseUrl);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    || url.username || url.password || url.search || url.hash) throw new Error("Dashboard launch requires a local HTTP URL");
  if (!enabled || !interactive || env.CI && !/^(0|false|no|off)$/i.test(env.CI) || env.SSH_CONNECTION || env.SSH_TTY
    || platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY) return { opened: false, state: "skipped" };
  const command = platform === "darwin" ? "open" : platform === "win32"
    ? path.win32.join(env.SystemRoot || "C:\\Windows", "System32", "rundll32.exe") : "xdg-open";
  const args = platform === "win32" ? ["url.dll,FileProtocolHandler", url.href] : [url.href];
  return new Promise(resolve => {
    let child, timer;
    const finish = opened => { clearTimeout(timer);resolve({ opened, state: opened ? "opened" : "unavailable" }); };
    try { child = spawnImpl(command, args, { stdio: "ignore", windowsHide: true }); }
    catch { finish(false);return; }
    child.once("error", () => finish(false));child.once("exit", code => finish(code === 0));
    timer = setTimeout(() => { child.unref?.();finish(false); }, timeoutMs);timer.unref?.();
  });
}
