import { createRequestAbort, readJsonBody, readBoundedResponseText, sendJsonError, sendUpstreamError, logRequestFailure } from "./http-transport.mjs";
import { httpError } from "./http-errors.mjs";
import { isLoopbackAddress, isLoopbackHostHeader } from "./security.mjs";
import { readAccessSettings } from "./access-settings.mjs";
import { servicePreferences } from "./user-settings.mjs";
import { observeRequestedModel, currentRequestContext } from "./request-context.mjs";
import { recordResponsesUsage } from "./usage-store.mjs";

export const NATIVE_IMAGE_MODEL = "gpt-image-2.5-flare";
export const IMAGE_MAX_BYTES = 32 * 1024 * 1024;
const INPUT_MAX_BYTES = 10 * 1024 * 1024;
const BODY_MAX_BYTES = 64 * 1024 * 1024;
const RESPONSE_MAX_BYTES = 48 * 1024 * 1024;
const SIZES = new Set(["auto", "1024x1024", "1536x1024", "1024x1536"]);
const FIELDS = new Set(["model", "prompt", "images", "background", "quality", "size", "n"]);

async function checkedImage(value, maxBytes, mime) {
  if (typeof value !== "string" || !value || value.length > 4 * Math.ceil(maxBytes / 3)
    || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw httpError("Invalid image data", 400);
  const bytes = Buffer.from(value, "base64");
  if (!bytes.length || bytes.length > maxBytes || bytes.toString("base64") !== value) throw httpError("Invalid image data", 400);
  let info;
  try { const { default: sharp } = await import("sharp");info = await sharp(bytes, { limitInputPixels: 40_000_000 }).metadata(); }
  catch { throw httpError("Image must be a valid PNG, JPEG or WebP", 400); }
  const type = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" }[info.format];
  if (!type || mime && mime !== type) throw httpError("Image format does not match its data", 400);
}

export async function nativeImageRequest(body, operation) {
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => !FIELDS.has(key))) throw httpError("Unsupported image request field", 400);
  if (!["gpt-image-2", NATIVE_IMAGE_MODEL].includes(body.model)) throw httpError(`Image model must be ${NATIVE_IMAGE_MODEL}`, 400);
  if (typeof body.prompt !== "string" || !body.prompt.trim() || Buffer.byteLength(body.prompt) > 128 * 1024) throw httpError("Image prompt is required and must not exceed 128 KiB", 400);
  if (body.n !== undefined && body.n !== 1) throw httpError("Request one image at a time", 400);
  if (body.quality !== undefined && !["auto", "low", "medium", "high"].includes(body.quality)) throw httpError("Unsupported image quality", 400);
  if (body.size !== undefined && !SIZES.has(body.size)) throw httpError("Unsupported image size", 400);
  if (body.background !== undefined && !["auto", "opaque", "transparent"].includes(body.background)) throw httpError("Unsupported image background", 400);
  if (operation === "generations" && body.images !== undefined) throw httpError("Use images/edits for image inputs", 400);
  if (operation === "edits") {
    if (!Array.isArray(body.images) || !body.images.length || body.images.length > 5) throw httpError("Image editing requires one to five input images", 400);
    for (const image of body.images) {
      if (!image || Object.keys(image).length !== 1 || typeof image.image_url !== "string") throw httpError("Image editing requires inline image data; file IDs are unavailable through GHC", 400);
      const match = /^data:(image\/(?:png|jpeg|webp));base64,(.*)$/s.exec(image.image_url);
      if (!match) throw httpError("Image editing requires PNG, JPEG or WebP data URLs", 400);
      await checkedImage(match[2], INPUT_MAX_BYTES, match[1]);
    }
  }
  return { ...body, model: NATIVE_IMAGE_MODEL, n: 1 };
}

export function nativeImageAccess(options = {}) {
  const access = readAccessSettings(options), codex = access.clients.codex;
  return access.providers.github && codex.enabled && codex.allowed.includes("github");
}

export function createNativeImagesHandler({ client, acquireRequest, privacy, env = process.env, home,
  requestBodyTimeoutMs = 120000, timeoutMs = 180000, enabled = () => servicePreferences({ env, home }).image_enabled,
  allowed = () => nativeImageAccess({ env, home }) } = {}) {
  let active = 0;
  const metrics = { total: 0, succeeded: 0, failed: 0, busy: 0, cancelled: 0 };
  const handler = async (req, res, operation) => {
    const abort = createRequestAbort(req, res);
    let release = () => {}, admitted = false;
    metrics.total++;
    try {
      if (!isLoopbackAddress(req.socket?.remoteAddress) || req.headers.host !== undefined && !isLoopbackHostHeader(req.headers.host)
        || Object.hasOwn(req.headers, "origin")) throw httpError("Images require a native local Codex client", 403);
      if (String(req.headers["content-type"] || "").split(";", 1)[0].trim().toLowerCase() !== "application/json") throw httpError("Images require application/json", 415);
      if (!allowed()) throw httpError("GitHub Copilot access is disabled for Codex", 403);
      if (!enabled()) throw httpError("Image requests are paused", 503);
      if (active >= 2) { metrics.busy++;throw httpError("Two image requests are already active", 503); }
      active++;admitted = true;
      abort.setTimeout(requestBodyTimeoutMs, "request_body_timeout");
      release = await acquireRequest(req, { signal: abort.signal });
      const parsed = await readJsonBody(req, { admission: release, signal: abort.signal, maxBodyBytes: BODY_MAX_BYTES, maxDecodedBodyBytes: BODY_MAX_BYTES });
      const body = await nativeImageRequest(parsed, operation);
      observeRequestedModel(body);
      const context = currentRequestContext();
      if (context) { context.provider = "github";context.streamPerformance?.setProvider?.("github"); }
      abort.setTimeout(timeoutMs);
      const forward = input => client.images(operation, { ...body, prompt: input.input }, { signal: abort.signal });
      const call = privacy?.wrap ? privacy.wrap(forward, { res, protocol: "responses", client: "codex" }) : forward;
      const response = await call({ input: body.prompt }, { signal: abort.signal });
      if (!response.ok) { metrics.failed++;await sendUpstreamError(res, response, "images", { signal: abort.signal });return; }
      const text = await readBoundedResponseText(response, { maxBytes: RESPONSE_MAX_BYTES, signal: abort.signal, label: "Copilot image response" });
      let result;
      try { result = JSON.parse(text); } catch { throw httpError("Copilot returned invalid image JSON", 502); }
      if (!Number.isSafeInteger(result.created) || !Array.isArray(result.data) || result.data.length !== 1) throw httpError("Copilot returned an invalid image response", 502);
      try { await checkedImage(result.data[0]?.b64_json, IMAGE_MAX_BYTES); }
      catch { throw httpError("Copilot returned invalid image data", 502); }
      abort.signal.throwIfAborted();
      void recordResponsesUsage({ surface: "images", mode: operation, model: NATIVE_IMAGE_MODEL, response: result });
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-CCDX-Image-Model": NATIVE_IMAGE_MODEL });
      res.end(text);
      metrics.succeeded++;
    } catch (error) {
      metrics.failed++;
      if (abort.reason === "client_closed" || abort.reason === "client_aborted") metrics.cancelled++;
      logRequestFailure("images", error, abort);
      sendJsonError(res, error, error.statusCode || 502);
    } finally { release();if (admitted) active--;abort.cleanup(); }
  };
  handler.stats = () => ({ ...metrics, active, native: true, model: NATIVE_IMAGE_MODEL });
  return handler;
}
