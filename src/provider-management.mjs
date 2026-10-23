import { isLoopbackAddress, isLoopbackHostHeader } from "./security.mjs";
import { createRequestAbort, readJsonBody, sendJsonError } from "./http-transport.mjs";
import { httpError } from "./http-errors.mjs";

export const PROVIDER_MANAGEMENT_PATH = "/_ccdx/providers";
export async function handleProviderManagement(req, res, runtime) {
  if (!isLoopbackAddress(req.socket?.remoteAddress) || req.headers?.host === undefined || !isLoopbackHostHeader(req.headers.host)
    || Object.hasOwn(req.headers, "origin")) { sendJsonError(res, httpError("Provider management requires a native loopback client", 403));return; }
  if (!runtime) { sendJsonError(res, httpError("This service does not support provider management; restart the updated CCDX service", 503));return; }
  if (req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });res.end(JSON.stringify(runtime.snapshot()));return;
  }
  if (req.method !== "POST") { sendJsonError(res, httpError("Provider changes require POST", 405));return; }
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] || "")) { sendJsonError(res, httpError("Expected application/json", 415));return; }
  const abort = createRequestAbort(req, res);abort.setTimeout(2000, "request_body_timeout");
  try {
    const input = await readJsonBody(req, { maxBodyBytes: 4096, maxDecodedBodyBytes: 4096, signal: abort.signal });
    const allowed = new Set(["action", "provider", "model", "auto_review_model", "family", "effort", "account_id"]);
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !allowed.has(key))
      || !["models", "switch", "on", "off", "remove", "auto-review", "accounts", "account"].includes(input.action)) throw httpError("Invalid provider action", 400);
    if (input.action === "account" && (typeof input.account_id !== "string" || !/^[a-f0-9]{64}$/.test(input.account_id))) throw httpError("Select an available company account", 400);
    if (input.effort !== undefined && input.effort !== null && (typeof input.effort !== "string" || input.effort.length > 16)) throw httpError("Invalid reasoning effort", 400);
    for (const key of ["provider", "model", "auto_review_model", "family"]) if (input[key] !== undefined && (typeof input[key] !== "string" || input[key].length > (key.includes("model") ? 160 : 128))) throw httpError("Invalid provider selection", 400);
    abort.clearTimeout();
    const result = await runtime.action(input);
    if (!res.destroyed && !res.writableEnded) { res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });res.end(JSON.stringify(result)); }
  } catch (error) { sendJsonError(res, error, error.statusCode || 503); }
  finally { abort.cleanup(); }
}
