import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { readSuggestionConfig, suggestionConfigPath } from "./suggestion-config.mjs";
import { readSuggestionContext, suggestionThreadId } from "./suggestion-context.mjs";
import { generateSuggestion } from "./suggestion-provider.mjs";

const URI = "ui://ccdx-suggestion/panel.html";
const protocolVersions = new Set(["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25", "2026-07-28"]);
export const SUGGESTION_TOOLS = [
  {
    name: "suggest_next_message", title: "Next message / 下一句",
    description: "Open an optional next-message suggestion for this local conversation. Use only when the user asks for a suggestion. Reads a bounded page of recent user/assistant text and makes one request to the user's selected model through local CCDX. Does not send a message, modify a draft, execute tools, or grant approval. The user can add the suggestion to their ordinary draft in the panel.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: true, destructiveHint: false },
    _meta: { ui: { resourceUri: URI }, "openai/ui": { entrypoints: [{ type: "thread" }] } },
  },
  {
    name: "prepare_suggestion_draft", title: "Check draft destination",
    description: "Validate a suggestion's originating conversation before the user explicitly adds it to their draft. Does not send or write anything.",
    inputSchema: { type: "object", properties: { candidate_id: { type: "string" } }, required: ["candidate_id"], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    _meta: { ui: { visibility: ["app"] } },
  },
];

export function createSuggestionMcp({
  loadConfig = () => readSuggestionConfig({ filePath: suggestionConfigPath() }),
  readContext = readSuggestionContext, generate = generateSuggestion,
  now = Date.now, timeoutMs = 30_000,
} = {}) {
  const candidates = new Map();
  let active = 0;
  const prune = () => { for (const [id, item] of candidates) if (now() - item.at > 10 * 60_000) candidates.delete(id); };
  const result = data => ({ content: [{ type: "text", text: data.suggestion || "No suggestion available. Open the panel to try again." }], structuredContent: data });
  return async function handle(request, { signal } = {}) {
    const config = loadConfig();
    if (request.method === "initialize") return {
      protocolVersion: protocolVersions.has(request.params?.protocolVersion) ? request.params.protocolVersion : "2025-11-25",
      capabilities: { tools: { listChanged: false }, resources: {} },
      serverInfo: { name: "ccdx-suggestion", version: "1" },
      instructions: "Optional next-message panel. Call only when requested by the user. No automatic messages, no client patch, no approvals implied. Disabled until the user runs ccdx suggestion on.",
    };
    if (request.method === "ping") return {};
    if (request.method === "tools/list") return { tools: config.enabled ? SUGGESTION_TOOLS : [] };
    if (request.method === "resources/list") return { resources: config.enabled ? [{ uri: URI, name: "Next message", mimeType: "text/html;profile=mcp-app" }] : [] };
    if (request.method === "resources/templates/list") return { resourceTemplates: [] };
    if (!config.enabled) { candidates.clear(); throw new Error("Next-message suggestions are disabled. Run ccdx suggestion on to enable them"); }
    if (request.method === "resources/read" && request.params?.uri === URI) return {
      contents: [{ uri: URI, mimeType: "text/html;profile=mcp-app", text: fs.readFileSync(new URL("./suggestion-ui.html", import.meta.url), "utf8") }],
    };
    if (request.method !== "tools/call") throw new Error("Unsupported suggestion method");
    const threadId = suggestionThreadId(request.params?._meta);
    const args = request.params?.arguments || {};
    if (typeof args !== "object" || Array.isArray(args)) throw new Error("Invalid suggestion parameters");
    prune();
    if (request.params.name === "prepare_suggestion_draft") {
      if (Object.keys(args).some(key => key !== "candidate_id")) throw new Error("Invalid draft parameters");
      const item = candidates.get(args.candidate_id);
      if (!item || item.threadId !== threadId || item.model !== config.model) throw new Error("Suggestion expired or conversation changed; generate a new suggestion");
      return result({ candidate_id: args.candidate_id, suggestion: item.suggestion, model: item.model });
    }
    if (request.params.name !== "suggest_next_message" || Object.keys(args).length) throw new Error("Invalid suggestion tool or parameters");
    if (active >= 2) throw new Error("Suggestions are busy. Wait for the current request; no extra model call was made");
    active += 1;
    const controller = new AbortController();
    const abort = () => controller.abort(new Error("Suggestion cancelled"));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(abort, timeoutMs);
    try {
      const messages = await readContext(threadId, config, { signal: controller.signal });
      controller.signal.throwIfAborted();
      const latest = loadConfig();
      if (!latest.enabled || latest.model !== config.model || latest.adapter_url !== config.adapter_url) throw new Error("Suggestion settings changed; generate again with the current selection");
      const suggestion = await generate(messages, config, { signal: controller.signal });
      controller.signal.throwIfAborted();
      if (!loadConfig().enabled) throw new Error("Suggestions were disabled");
      const candidate_id = suggestion ? randomUUID() : null;
      if (candidate_id) {
        while (candidates.size >= 16) candidates.delete(candidates.keys().next().value);
        candidates.set(candidate_id, { suggestion, model: config.model, threadId, at: now() });
      }
      return result({ suggestion, candidate_id, model: config.model });
    } finally { active -= 1; clearTimeout(timer); signal?.removeEventListener("abort", abort); }
  };
}

export function runSuggestionStdio({ input = process.stdin, output = process.stdout, handle = createSuggestionMcp() } = {}) {
  const decoder = new StringDecoder("utf8"), pending = new Map();
  let buffer = "";
  const write = value => { if (!output.destroyed) output.write(JSON.stringify(value) + "\n"); };
  const close = () => { for (const controller of pending.values()) controller.abort(); pending.clear(); };
  input.on("end", close);
  input.on("error", close);
  output.on("error", close);
  input.on("data", chunk => {
    buffer += decoder.write(chunk);
    if (Buffer.byteLength(buffer) > 64 * 1024) { close(); input.destroy(); return; }
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      let request;
      try { request = JSON.parse(line); } catch { write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON" } }); continue; }
      if (request?.method === "notifications/cancelled") { pending.get(request.params?.requestId)?.abort(); continue; }
      if (request?.id === undefined) continue;
      const id = request.id;
      if (request.jsonrpc !== "2.0" || !["string", "number"].includes(typeof id) || typeof request.method !== "string" || pending.has(id) || pending.size >= 16) {
        write({ jsonrpc: "2.0", id: typeof id === "string" || typeof id === "number" ? id : null, error: { code: -32600, message: "Invalid or busy request" } }); continue;
      }
      const controller = new AbortController(); pending.set(id, controller);
      Promise.resolve().then(() => handle(request, { signal: controller.signal }))
        .then(result => write({ jsonrpc: "2.0", id, result }), error => {
          // Never expose raw upstream responses, prompts, stack traces or config.
          const message = String(error?.message || "Suggestion failed").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").slice(0,300);
          write({ jsonrpc: "2.0", id, ...(request.method === "tools/call"
            ? { result: { isError: true, content: [{ type: "text", text: message }] } }
            : { error: { code: -32603, message } }) });
        }).finally(() => pending.delete(id));
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runSuggestionStdio();
