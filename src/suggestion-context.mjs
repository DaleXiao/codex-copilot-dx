import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { CODEX_APP_BINARY_PATHS } from "./codex-model-catalog.mjs";

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
export function suggestionThreadId(meta) {
  const id = meta?.threadId;
  if (typeof id !== "string" || !UUID.test(id)) throw new Error("Open Next message inside a local Codex conversation; its thread ID is required");
  const other = meta?.["x-codex-turn-metadata"]?.thread_id;
  if (other !== undefined && other !== id) throw new Error("Conversation identity changed; reopen the panel");
  return id;
}

export function resolveSuggestionCodexBinary(env = process.env) {
  const explicit = env.CCDX_CODEX_BINARY || env.CODEX_CLI_PATH;
  const candidates = explicit ? [explicit] : [...CODEX_APP_BINARY_PATHS,
    ...String(env.PATH || "").split(path.delimiter).filter(Boolean).map(dir => path.join(dir, process.platform === "win32" ? "codex.exe" : "codex"))];
  for (const candidate of candidates) {
    try { if (path.isAbsolute(candidate) && fs.statSync(candidate).isFile()) return fs.realpathSync(candidate); } catch {}
  }
  throw new Error("Codex executable not found. Set CCDX_CODEX_BINARY to the installed executable's absolute path");
}

export function contextMessages(entries) {
  const result = [];
  let remaining = 16_000;
  for (const entry of entries) {
    const item = entry?.item;
    let role, text;
    if (item?.type === "userMessage") {
      role = "user";
      text = (item.content || []).filter(part => part.type === "text" && typeof part.text === "string").map(part => part.text).join("\n");
    } else if (item?.type === "agentMessage" && typeof item.text === "string") {
      role = "assistant"; text = item.text;
    } else continue;
    if (!text.trim()) continue;
    const excerpt = text.slice(-Math.min(4000, remaining));
    result.push({ role, content: excerpt });
    remaining -= excerpt.length;
    if (remaining <= 0 || result.length >= 8) break;
  }
  return result.reverse();
}

// Use the client's paginated reader: no transcript scans, SQLite access, forks,
// turn starts, or writes to the user's conversation. Zstandard remains its job.
export function readSuggestionContext(threadId, config, { signal, spawnFn = spawn, includePage = false } = {}) {
  if (!UUID.test(threadId)) return Promise.reject(new Error("Invalid conversation ID"));
  return new Promise((resolve, reject) => {
    const decoder = new StringDecoder("utf8");
    let proc, buffer = "", bytes = 0, done = false, timer, stopTimer;
    const finish = (error, result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", aborted);
      proc?.stdin.end();
      proc?.kill("SIGTERM");
      if (proc && proc.exitCode === null) {
        stopTimer = setTimeout(() => proc.kill("SIGKILL"), 500);
        stopTimer.unref?.();
      }
      error ? reject(error) : resolve(result);
    };
    const aborted = () => finish(new Error("Suggestion cancelled"));
    if (signal?.aborted) { aborted(); return; }
    try {
      proc = spawnFn(config.codex_binary, ["-c", "features.plugins=false", "app-server", "--stdio"], {
        cwd: os.tmpdir(), windowsHide: true,
        env: { CODEX_HOME: config.codex_home, PATH: process.env.PATH || "", ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot } : {}) },
        stdio: ["pipe", "pipe", "ignore"],
      });
      const send = value => proc.stdin.write(JSON.stringify(value) + "\n");
      proc.once("error", () => finish(new Error("Cannot start the Codex conversation reader")));
      proc.stdin.on("error", () => finish(new Error("Codex conversation reader disconnected")));
      proc.once("exit", () => { clearTimeout(stopTimer); if (!done) finish(new Error("Codex conversation reader exited")); });
      proc.stdout.on("data", chunk => {
        if (done) return;
        bytes += chunk.length;
        if (bytes > 2 * 1024 * 1024) { finish(new Error("Recent conversation data exceeds the suggestion reader limit")); return; }
        buffer += decoder.write(chunk);
        let end;
        while (!done && (end = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          let reply;
          try { reply = JSON.parse(line); } catch { finish(new Error("Invalid conversation reader response")); return; }
          if (reply.id !== 1 && reply.id !== 2) continue;
          if (reply.error) { finish(new Error("This Codex version cannot read the requested conversation; update Codex or reopen the local thread")); return; }
          if (reply.id === 1) {
            send({ method: "initialized", params: {} });
            send({ id: 2, method: "thread/items/list", params: { threadId, limit: 24, sortDirection: "desc" } });
          } else {
            if (!Array.isArray(reply.result?.data)) { finish(new Error("Invalid conversation page")); return; }
            const messages = contextMessages(reply.result.data);
            finish(messages.length ? null : new Error("No recent text messages are available for a suggestion"), includePage
              ? { messages, latestTurnId: reply.result.data[0]?.turnId || null } : messages);
          }
        }
      });
      timer = setTimeout(() => finish(new Error("Conversation lookup timed out")), 5000);
      signal?.addEventListener("abort", aborted, { once: true });
      send({ id: 1, method: "initialize", params: { clientInfo: { name: "ccdx-suggestion", version: "1" }, capabilities: { experimentalApi: true } } });
    } catch { finish(new Error("Cannot start the Codex conversation reader")); }
  });
}
