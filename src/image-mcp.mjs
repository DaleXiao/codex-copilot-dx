import { isLoopbackAddress } from "./observability.mjs";
import { generateImage, supportsImageEditing } from "./image-provider.mjs";
import { readImageProviderConfig } from "./image-provider-config.mjs";
import { createImageReferenceStore } from "./image-references.mjs";

const MCP_PROTOCOL_VERSION = "2025-06-18";
const MCP_PROTOCOL_VERSIONS = new Set(["2025-06-18", "2025-03-26", "2024-11-05"]);
const MCP_MAX_BODY_BYTES = 256 * 1024;
const IMAGE_TOOL_NAME = "generate_image";
const EDIT_TOOL_NAME = "edit_image";

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

function editTool() {
  const tool = imageTool();
  return {
    ...tool,
    name: EDIT_TOOL_NAME,
    title: "Edit image",
    description: "Edit a previously generated CCDX image using its exact image_id and a change instruction. Preserve the source and return a new image with a new ID for further edits. Source images must still be retained by this running adapter. Does not accept file paths, URLs, masks, or arbitrary uploads.",
    inputSchema: {
      ...tool.inputSchema,
      properties: {
        image_id: { type: "string", description: "The image_id returned in the result of the specific CCDX image to edit." },
        prompt: { type: "string", description: "Describe the requested changes and what to preserve from the source image." },
        size: { type: "string", enum: [...tool.inputSchema.properties.size.enum], description: "Optional output dimensions; defaults to the source image's requested size." },
      },
      required: ["image_id", "prompt"],
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
  imageReferences = createImageReferenceStore(),
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
    // This endpoint serves native Codex/Node clients, not browser pages. A
    // loopback socket alone does not make a browser-supplied Origin trusted.
    if (Object.hasOwn(req.headers || {}, "origin")) {
      writeJson(res, 403, jsonRpcError(null, -32001, "Browser origins are not allowed for Image MCP"));
      return;
    }
    const mediaType = String(req.headers?.["content-type"] || "").split(";", 1)[0].trim().toLowerCase();
    if (mediaType !== "application/json") {
      writeJson(res, 415, jsonRpcError(null, -32600, "Image MCP requires application/json"));
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
      const config = configLoader();
      if (!config) imageReferences.clear();
      reply({
        protocolVersion: MCP_PROTOCOL_VERSIONS.has(requestedVersion) ? requestedVersion : MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "ccdx-image", version: "1" },
        instructions: config
          ? `The user enabled CCDX as their image provider. Call generate_image for new images.${supportsImageEditing(config) ? " For changes to a CCDX image, call edit_image with that image's returned image_id. Keep each returned ID with its image; there is no global last image." : " Editing is not supported by this configured provider."} Display the returned image. CCDX handles credentials and the API; no Python, SDK installation, extra API key or alternate endpoint is needed. Do not automatically retry failed generations or edits.`
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
      if (!config) imageReferences.clear();
      reply({ tools: config ? [imageTool(), ...(supportsImageEditing(config) ? [editTool()] : [])] : [] });
      return;
    }
    if (request.method !== "tools/call") {
      writeJson(res, 200, jsonRpcError(request.id, -32601, "Method not found"));
      return;
    }
    if (![IMAGE_TOOL_NAME, EDIT_TOOL_NAME].includes(request.params?.name)) {
      writeJson(res, 200, jsonRpcError(request.id, -32602, "Unknown image tool"));
      return;
    }
    const config = configLoader();
    if (!config) {
      imageReferences.clear();
      reply({ content: [{ type: "text", text: "Image generation is disabled. Run ccdx enable-image first." }], isError: true });
      return;
    }
    const editing = request.params.name === EDIT_TOOL_NAME;
    if (editing && !supportsImageEditing(config)) {
      reply({ content: [{ type: "text", text: "The configured image provider does not support CCDX editing. No edit was submitted." }], isError: true });
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
      const args = request.params?.arguments || {};
      // Only an explicit retained handle can add source pixels to a request.
      const source = editing ? imageReferences.resolve(config, args.image_id) : null;
      const parameters = { prompt: args.prompt, size: args.size ?? source?.size ?? "1024x1024" };
      if (source) parameters.image = source.image;
      const image = await generateImageFn(config, parameters, { signal: abort.signal });
      let imageId = null;
      if (supportsImageEditing(config)) {
        try { imageId = imageReferences.remember(config, { ...image, size: parameters.size }); } catch {}
      }
      const note = imageId ? ` Image ID: ${imageId}. Use this ID for further edits while retained by this adapter.`
        : supportsImageEditing(config) ? " The image is available, but an editing reference could not be retained." : "";
      reply({
        // Codex prioritizes structuredContent over image blocks. Keep IDs in metadata/text.
        ...(imageId ? { _meta: { "ccdx/image_id": imageId } } : {}),
        content: [
          { type: "image", data: image.data, mimeType: image.mimeType },
          { type: "text", text: `${editing ? "Edited" : "Generated"} ${image.width || ""}${image.width && image.height ? "×" : ""}${image.height || image.size} image with ${image.model}.${note}` },
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
