import { spawn } from "node:child_process";

export { ensureAuth } from "./auth.mjs";

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
