import { StringDecoder } from "node:string_decoder";
import { pathToFileURL } from "node:url";

const MAX_LINE_BYTES = 64 * 1024;
const PROTOCOL_VERSIONS = new Set(["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"]);
const RETIRED = "CCDX next-message MCP has been retired. Remove the old ccdx_suggestion MCP configuration.";

function reply(request) {
  const id = request?.id;
  const validId = id === null || typeof id === "string" || (typeof id === "number" && Number.isFinite(id));
  if (!request || Array.isArray(request) || request.jsonrpc !== "2.0" || typeof request.method !== "string"
    || (id !== undefined && !validId)) {
    return { jsonrpc: "2.0", id: validId ? id : null, error: { code: -32600, message: "Invalid JSON-RPC request" } };
  }
  if (id === undefined) return null;
  let result;
  switch (request.method) {
    case "initialize":
      result = {
        protocolVersion: PROTOCOL_VERSIONS.has(request.params?.protocolVersion) ? request.params.protocolVersion : "2025-11-25",
        capabilities: { tools: { listChanged: false }, resources: {} },
        serverInfo: { name: "ccdx-suggestion", version: "1" },
        instructions: RETIRED,
      };
      break;
    case "ping": result = {}; break;
    case "tools/list": result = { tools: [] }; break;
    case "resources/list": result = { resources: [] }; break;
    case "resources/templates/list": result = { resourceTemplates: [] }; break;
    case "tools/call": result = { isError: true, content: [{ type: "text", text: RETIRED }] }; break;
    default: return { jsonrpc: "2.0", id, error: { code: -32601, message: RETIRED } };
  }
  return { jsonrpc: "2.0", id, result };
}

export function runSuggestionStdio({ input = process.stdin, output = process.stdout } = {}) {
  let decoder = new StringDecoder("utf8"), line = "", bytes = 0, closed = false;
  const close = () => { closed = true; input.destroy(); };
  const write = value => {
    if (value && !closed && !output.destroyed && !output.writableEnded) {
      if (!output.write(JSON.stringify(value) + "\n")) input.pause();
    }
  };
  const finishLine = () => {
    line += decoder.end();
    if (line.trim()) {
      let request;
      try { request = JSON.parse(line); }
      catch { write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON" } }); }
      if (request !== undefined) write(reply(request));
    }
    line = ""; bytes = 0; decoder = new StringDecoder("utf8");
  };
  input.on("error", close);
  output.on("error", close);
  output.on("drain", () => { if (!closed) input.resume(); });
  input.on("end", () => { if (!closed && bytes) finishLine(); });
  input.on("data", chunk => {
    if (closed) return;
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let start = 0;
    while (start < data.length && !closed) {
      const end = data.indexOf(10, start);
      const limit = end < 0 ? data.length : end;
      bytes += limit - start;
      if (bytes > MAX_LINE_BYTES) {
        write({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "MCP request exceeds 65536 bytes" } });
        close();
        return;
      }
      line += decoder.write(data.subarray(start, limit));
      if (end < 0) break;
      finishLine();
      start = end + 1;
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runSuggestionStdio();
