import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const IMAGE_SIZES = new Set(["1024x1024", "1536x1024", "1024x1536"]);
const IMAGE_EXTENSIONS = new Map([["image/png", ".png"], ["image/jpeg", ".jpg"], ["image/webp", ".webp"]]);
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 48 * 1024 * 1024;
const IMAGE_ID = /^ccdx_img_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const USAGE = "Usage: generate.mjs --prompt <text> [--image-id <previous-CCDX-image-id>] [--size 1024x1024|1536x1024|1024x1536] [--out <new-file>]";

export function parseImageToolArgs(args = []) {
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) return { help: true };
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    if (!["--prompt", "--image-id", "--size", "--out"].includes(option) || option in values) throw new Error(USAGE);
    if (typeof args[index + 1] !== "string" || !args[index + 1].trim()) throw new Error(`Missing value for ${option}`);
    values[option] = args[index + 1];
  }
  const prompt = String(values["--prompt"] || "").trim();
  if (!prompt || prompt.length > 16_000) throw new Error("Image prompt must contain 1 to 16000 characters");
  const imageId = values["--image-id"]?.trim();
  if (imageId !== undefined && !IMAGE_ID.test(imageId)) throw new Error("Invalid CCDX image ID");
  const size = values["--size"] ? values["--size"].trim().toLowerCase() : (imageId ? undefined : "1024x1024");
  if (size !== undefined && !IMAGE_SIZES.has(size)) throw new Error("Unsupported image size");
  return { prompt, size, out: values["--out"], imageId };
}

function localImageEndpoint(value) {
  const endpoint = new URL(value);
  const host = endpoint.hostname.replace(/^\[|\]$/g, "");
  const localAddresses = Object.values(os.networkInterfaces()).flat().filter(Boolean).map(({ address }) => address);
  const local = host === "localhost" || host === "::1" || /^127\.\d+\.\d+\.\d+$/.test(host) || localAddresses.includes(host);
  if (!local || endpoint.protocol !== "http:" || endpoint.username || endpoint.password
    || endpoint.pathname !== "/mcp/image" || endpoint.search || endpoint.hash) {
    throw new Error("The CCDX image helper requires the configured local /mcp/image endpoint");
  }
  return endpoint.href;
}

function cleanError(value) {
  return String(value || "Image generation failed").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").slice(0, 1000);
}

async function readRpcResponse(response, expectedId) {
  if (!response.ok) throw new Error(`CCDX image service returned HTTP ${response.status}`);
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new Error("CCDX image response exceeds the size limit");
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > MAX_RESPONSE_BYTES) throw new Error("CCDX image response exceeds the size limit");
    chunks.push(Buffer.from(chunk));
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks, bytes).toString("utf8")); }
  catch { throw new Error("CCDX image service returned invalid JSON"); }
  if (body?.jsonrpc !== "2.0" || body.id !== expectedId) throw new Error("CCDX image service returned an invalid JSON-RPC response");
  if (body.error) throw new Error(cleanError(body.error.message));
  if (!body.result || typeof body.result !== "object") throw new Error("CCDX image service returned no result");
  return body.result;
}

function assertNewOutput(filePath) {
  try {
    fs.lstatSync(filePath);
    throw new Error(`Image output already exists: ${filePath}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

export async function runImageToolClient({
  endpoint,
  args = process.argv.slice(2),
  cwd = process.cwd(),
  fetchImpl = fetch,
  output = process.stdout,
  metadataOutput = process.stderr,
  signal = AbortSignal.timeout(210_000),
} = {}) {
  const options = parseImageToolArgs(args);
  if (options.help) {
    output.write(`${USAGE}\n`);
    return null;
  }
  const url = localImageEndpoint(endpoint);
  const requestedOutput = options.out ? path.resolve(cwd, options.out) : null;
  if (requestedOutput) assertNewOutput(requestedOutput);
  const directory = requestedOutput ? path.dirname(requestedOutput) : path.resolve(cwd, "output", "imagegen");
  fs.mkdirSync(directory, { recursive: true });
  fs.accessSync(directory, fs.constants.W_OK);
  const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
  const post = (body) => fetchImpl(url, {
    method: "POST", headers, body: JSON.stringify(body), redirect: "error", signal,
  });
  try {
    const initialized = await post({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "ccdx-image-helper", version: "1" } },
    });
    const sessionId = initialized.headers.get("mcp-session-id");
    const server = await readRpcResponse(initialized, 1);
    if (server.serverInfo?.name !== "ccdx-image") throw new Error("The configured local service is not CCDX image generation");
    headers["MCP-Protocol-Version"] = server.protocolVersion || "2025-06-18";
    if (sessionId) headers["Mcp-Session-Id"] = sessionId;
    const notified = await post({ jsonrpc: "2.0", method: "notifications/initialized" });
    await notified.body?.cancel();
    if (!notified.ok) throw new Error(`CCDX image initialization returned HTTP ${notified.status}`);
  } catch (error) {
    const code = error.cause?.code || error.code;
    const detail = ["EPERM", "EACCES"].includes(code)
      ? "Local network access was denied. Request normal execution permission for this helper command."
      : cleanError(error.message);
    throw Object.assign(new Error(`Image ${options.imageId ? "editing" : "generation"} has not started: ${detail}`), { code: "CCDX_IMAGE_NOT_STARTED" });
  }
  const argumentsValue = { prompt: options.prompt };
  if (options.size !== undefined) argumentsValue.size = options.size;
  if (options.imageId) argumentsValue.image_id = options.imageId;
  const result = await readRpcResponse(await post({
    jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: options.imageId ? "edit_image" : "generate_image", arguments: argumentsValue, _meta: { "ccdx/client_saves_image": true } },
  }), 2);
  if (result.isError) {
    throw new Error(cleanError(result.content?.find((part) => part.type === "text")?.text));
  }
  const image = result.content?.find((part) => part.type === "image");
  const extension = IMAGE_EXTENSIONS.get(image?.mimeType);
  if (!extension || typeof image.data !== "string" || !image.data
    || image.data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data)) {
    throw new Error("CCDX image service returned an invalid image");
  }
  const bytes = Buffer.from(image.data, "base64");
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES || bytes.toString("base64") !== image.data) {
    throw new Error("CCDX image service returned an invalid image");
  }
  const filePath = requestedOutput || path.join(directory, `image-${randomUUID()}${extension}`);
  fs.writeFileSync(filePath, bytes, { flag: "wx", mode: 0o600 });
  output.write(`${filePath}\n`);
  const imageId = result._meta?.["ccdx/image_id"];
  if (typeof imageId === "string" && IMAGE_ID.test(imageId)) metadataOutput.write(`CCDX image_id: ${imageId}\n`);
  return filePath;
}
