import { spawn } from "node:child_process";
import { status } from "./status.mjs";

export { ensureAuth } from "./auth.mjs";

export function openCodex() {
  if (process.platform === "darwin") {
    try {
      spawn("open", ["/Applications/Codex.app"], { detached: true, stdio: "ignore" });
      console.log(status("ok", "Codex app launched"));
    } catch {
      console.log(status("warn", "Codex app not found at /Applications/Codex.app"));
      console.log(status("info", "Download Codex from https://openai.com/codex"));
    }
  } else {
    console.log(status("warn", "Auto-launch is not supported on this platform"));
    console.log(status("info", "Open Codex manually; it will connect to the adapter."));
  }
}
