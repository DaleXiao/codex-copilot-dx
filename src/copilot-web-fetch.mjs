import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

function fetchError(message) {
  return Object.assign(new Error(message), { statusCode: 503, code: "ccdx_copilot_web_fetch_unavailable" });
}

function installedRuntime() {
  if (process.platform !== "darwin") throw fetchError("Copilot page reading is available only on macOS in this preview");
  const root = path.join(os.homedir(), "Library", "Caches", "copilot", "pkg", process.platform + "-" + process.arch);
  let entries;try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { throw fetchError("The installed Copilot page reader was not found"); }
  const candidates = entries.filter(entry => entry.isDirectory()).map(entry => path.join(root, entry.name))
    .filter(directory => fs.existsSync(path.join(directory, "cli-main.js")) && fs.existsSync(path.join(directory, "copilot-sdk", "index.js")))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  if (!candidates.length) throw fetchError("The installed Copilot page reader was not found");
  return candidates[0];
}

export function copilotPagePermission(request, approvedOrigins) {
  let allowed = false;
  try { allowed = request.kind === "url" && approvedOrigins.has(new URL(request.url).origin); } catch {}
  return { kind: allowed && !request.managedApprovalRequired && !request.requestSandboxBypass ? "approve-once" : "reject" };
}

// A page request owns its runtime and temporary state. It does not change the
// user's Copilot configuration or persist the GitHub credential.
export async function createCopilotPageReader({ credential, urls, signal } = {}) {
  const runtime = installedRuntime();
  const { CopilotClient, RuntimeConnection } = await import(pathToFileURL(path.join(runtime, "copilot-sdk", "index.js")).href);
  const directory = fs.mkdtempSync("/private/tmp/ccdx-carbon-fetch-");
  const approvedOrigins = new Set(urls.map(value => new URL(value).origin));
  let client, session, closed = false;
  const onAbort = () => { void client?.forceStop().catch(() => {}); };
  signal?.addEventListener("abort", onAbort, { once: true });
  async function close() {
    if (closed) return;closed = true;signal?.removeEventListener("abort", onAbort);
    try { await session?.disconnect(); } catch {}
    try { await client?.stop(); } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  }
  try {
    client = new CopilotClient({
      connection: RuntimeConnection.forStdio({ path: path.join(runtime, "cli-main.js") }),
      mode: "empty", baseDirectory: directory, workingDirectory: directory,
      gitHubToken: credential, useLoggedInUser: false, logLevel: "error",
    });
    signal?.throwIfAborted();await client.start();signal?.throwIfAborted();
    session = await client.createSession({
      model: "gemini-4-carbon", gitHubToken: credential, enableManagedSettings: true,
      infiniteSessions: { enabled: false }, availableTools: ["web_fetch"], enableConfigDiscovery: false,
      onPermissionRequest: request => copilotPagePermission(request, approvedOrigins),
    });
    signal?.throwIfAborted();
    return {
      async read(url, { start = 0, maxLength = 20000 } = {}) {
        signal?.throwIfAborted();
        const result = await session.rpc.tools.execute({ name: "web_fetch",
          arguments: { url, start_index: start, max_length: maxLength } });
        signal?.throwIfAborted();
        if (typeof result === "string") return result;
        if (result?.resultType !== "success" || typeof result.textResultForLlm !== "string") {
          throw fetchError("Copilot could not read this page");
        }
        return result.textResultForLlm;
      },
      close,
    };
  } catch (error) {
    await close();
    if (signal?.aborted) throw signal.reason;
    if (error?.code === "ccdx_copilot_web_fetch_unavailable") throw error;
    throw fetchError("Copilot could not start its page reader");
  }
}
