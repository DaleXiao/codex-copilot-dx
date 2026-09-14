import { isLoopbackAddress } from "./observability.mjs";
import { generateImage } from "./image-provider.mjs";
import { readImageProviderConfig } from "./image-provider-config.mjs";

const MCP_PROTOCOL_VERSION = "2025-06-18";
const MCP_PROTOCOL_VERSIONS = new Set(["2025-06-18", "2025-03-26", "2024-11-05"]);
const MCP_MAX_BODY_BYTES = 256 * 1024;
const IMAGE_TOOL_NAME = "generate_image";

function sameHostSocket(socket) {
  const remote = String(socket?.remoteAddress || "").replace(/^::ffff:/, "");
  const local = String(socket?.localAddress || "").replace(/^::ffff:/, "");
  return remote && local && remote === local;
}

function writeJson(res, statusCode, body) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(body === undefined ? undefined : JSON.stringify(body));
}

function jsonRpcError(id, code, message) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

async function readBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MCP_MAX_BODY_BYTES) throw Object.assign(new Error("MCP request body is too large"), { statusCode: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks, total).toString("utf8")); }
  catch { throw Object.assign(new Error("Invalid JSON"), { parseError: true }); }
}

function imageTool() {
  return {
    name: IMAGE_TOOL_NAME,
    title: "Generate image",
    description: "Generate a new image with the image provider the user enabled in CCDX. Call directly for text-to-image requests; returns the image inline. Credentials and generation are handled by CCDX, with no Python or OpenAI SDK setup. Does not edit or take reference images.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "A detailed, standalone description of the image to generate." },
        size: {
          type: "string",
          enum: ["1024x1024", "1536x1024", "1024x1536"],
          default: "1024x1024",
          description: "Output dimensions: square, landscape, or portrait.",
        },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  };
}

function safeToolError(error, apiKey) {
  if (typeof error?.message === "string" && error.message) {
    let message = error.message.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
    if (apiKey) message = message.split(apiKey).join("[redacted]");
    return message.slice(0, 1000);
  }
  return "Image generation failed";
}

export function createImageMcpHandler({
  configLoader = () => readImageProviderConfig(),
  generateImageFn = generateImage,
  maxConcurrent = 2,
} = {}) {
  let active = 0;
  return async function imageMcpHandler(req, res) {
    if (!isLoopbackAddress(req.socket?.remoteAddress) && !sameHostSocket(req.socket)) {
      writeJson(res, 403, jsonRpcError(null, -32001, "Image MCP is available only on this device"));
      return;
    }
    if (req.method !== "POST") {
      res.setHeader?.("Allow", "POST");
      writeJson(res, 405, jsonRpcError(null, -32600, "Only POST is supported"));
      return;
    }

    let request;
    try { request = await readBody(req); }
    catch (error) {
      writeJson(res, error.statusCode || 400, jsonRpcError(null, error.parseError ? -32700 : -32600, error.message));
      return;
    }
    if (!request || typeof request !== "object" || Array.isArray(request) || request.jsonrpc !== "2.0" || typeof request.method !== "string") {
      writeJson(res, 400, jsonRpcError(request?.id, -32600, "Invalid JSON-RPC request"));
      return;
    }
    if (request.id === undefined) {
      writeJson(res, 202);
      return;
    }
    const reply = (result) => writeJson(res, 200, { jsonrpc: "2.0", id: request.id, result });
    if (request.method === "initialize") {
      const requestedVersion = String(request.params?.protocolVersion || "");
      reply({
        protocolVersion: MCP_PROTOCOL_VERSIONS.has(requestedVersion) ? requestedVersion : MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "ccdx-image", version: "1" },
        instructions: configLoader()
          ? "The user enabled CCDX as their image provider. For new text-to-image requests, call generate_image directly and display the returned image. CCDX handles credentials and the API; no Python, SDK installation, OPENAI_API_KEY, or alternate endpoint is needed. Follow the user's image request; do not retry a failed generation automatically. Editing and reference-image requests require a different capable tool."
          : "Image generation is disabled. Enable it with ccdx enable-image before requesting images.",
      });
      return;
    }
    if (request.method === "ping") {
      reply({});
      return;
    }
    if (request.method === "tools/list") {
      const config = configLoader();
      reply({ tools: config ? [imageTool()] : [] });
      return;
    }
    if (request.method !== "tools/call") {
      writeJson(res, 200, jsonRpcError(request.id, -32601, "Method not found"));
      return;
    }
    if (request.params?.name !== IMAGE_TOOL_NAME) {
      writeJson(res, 200, jsonRpcError(request.id, -32602, "Unknown image tool"));
      return;
    }
    const config = configLoader();
    if (!config) {
      reply({ content: [{ type: "text", text: "Image generation is disabled. Run ccdx enable-image first." }], isError: true });
      return;
    }
    if (active >= maxConcurrent) {
      reply({ content: [{ type: "text", text: "Image generation is busy. Try again after the current request finishes." }], isError: true });
      return;
    }
    active += 1;
    const abort = new AbortController();
    const cancel = () => abort.abort(new Error("Image request was cancelled"));
    req.once?.("aborted", cancel);
    res.once?.("close", cancel);
    try {
      const image = await generateImageFn(config, request.params?.arguments || {}, { signal: abort.signal });
      reply({
        content: [
          { type: "image", data: image.data, mimeType: image.mimeType },
          { type: "text", text: `Generated ${image.width || ""}${image.width && image.height ? "×" : ""}${image.height || image.size} image with ${image.model}.` },
        ],
      });
    } catch (error) {
      if (!res.destroyed && !res.writableEnded) {
        reply({ content: [{ type: "text", text: safeToolError(error, config.api_key) }], isError: true });
      }
    } finally {
      active -= 1;
      req.off?.("aborted", cancel);
      res.off?.("close", cancel);
    }
  };
}
