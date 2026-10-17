import { isProviderId } from "./provider-metadata.mjs";
import { claudeModelEntries } from "./claude-models.mjs";
import http from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { createRequestAbort, readJsonBody, readBoundedResponseText, writeOrDrain, MAX_UPSTREAM_ERROR_BODY_BYTES } from "./http-transport.mjs";
import { createRequestAdmission } from "./request-admission.mjs";
import { loadRuntimeConfig } from "./runtime-config.mjs";
import { isLoopbackAddress, isLoopbackHostHeader } from "./security.mjs";
import { safeUpstreamResponseHeaders } from "./upstream-headers.mjs";
import { runWithRequestContext, currentRequestContext } from "./request-context.mjs";
import { createStreamPerformanceMetrics } from "./stream-performance.mjs";
import { buildMessagesUsageRecord, recordUsage } from "./usage-store.mjs";
import { redactDiagnosticText } from "./diagnostic-text.mjs";
import { decodedBodyLimitPreference } from "./user-settings.mjs";

function send(res, code, value) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });res.end(JSON.stringify(value));
}
const apiError = (code, message) => ({ type: "error", error: { type: "api_error", code, message } });
function authenticated(headers, key) {
  const candidates = [headers["x-api-key"], typeof headers.authorization === "string" ? /^Bearer (.+)$/i.exec(headers.authorization)?.[1] : null];
  const expected = Buffer.from(key);
  return candidates.some(value => typeof value === "string" && Buffer.byteLength(value) === expected.length && timingSafeEqual(Buffer.from(value), expected));
}

// Observe bounded SSE frames while retaining the original wire bytes for the
// client. A slow client controls upstream reads; there is no independent tee.
export function createMessagesObserver(onEvent, maxBytes = 8 * 1024 * 1024) {
  const decoder = new TextDecoder();let fragments = [], lineBytes = 0, data = [], frameBytes = 0;
  const frame = () => {
    if (data.length) { let value;try { value = JSON.parse(data.join("\n")); } catch { throw new Error("Invalid Claude stream event"); }onEvent(value); }
    data = [];frameBytes = 0;
  };
  const line = value => {
    if (value.endsWith("\r")) value = value.slice(0, -1);
    if (!value) frame();
    else if (value.startsWith("data:")) {
      const part = value.slice(5).replace(/^ /, "");frameBytes += Buffer.byteLength(part);
      if (frameBytes > maxBytes) throw new Error("Claude stream event exceeds its limit");data.push(part);
    }
  };
  function consume(text) {
    let start = 0;
    while (start < text.length) {
      const newline = text.indexOf("\n", start), end = newline < 0 ? text.length : newline, part = text.slice(start, end);
      lineBytes += Buffer.byteLength(part);
      if (lineBytes > maxBytes) throw new Error("Claude stream line exceeds its limit");
      fragments.push(part);
      if (newline < 0) break;
      line(fragments.join(""));fragments = [];lineBytes = 0;start = newline + 1;
    }
  }
  return { write(chunk) { consume(decoder.decode(chunk, { stream: true })); },
    finish() { consume(decoder.decode());if (fragments.length) line(fragments.join(""));frame(); } };
}

export function createClaudeGatewayHandler({ provider, apiKey, log = () => {}, onRequest = () => {}, env = process.env,
  record = recordUsage, acquireRequest = createRequestAdmission({ maxBytes: 16 * 1024 * 1024, maxQueued: 8 }) } = {}) {
  if (!provider || !isProviderId(provider.id) || typeof apiKey !== "string" || apiKey.length < 32) throw new Error("Claude gateway requires a provider and private local key");
  const config = loadRuntimeConfig(env), performance = createStreamPerformanceMetrics({ routeNames: ["messages"] });
  const decodedLimit = decodedBodyLimitPreference({ env }).bytes;
  const stats = { total: 0, active: 0, completed: 0, incomplete: 0, failed: 0, cancelled: 0, last_request_at: null, last_model: null };
  async function dispatch(req, res) {
    if (!isLoopbackAddress(req.socket?.remoteAddress) || req.headers.host === undefined || !isLoopbackHostHeader(req.headers.host)
      || Object.hasOwn(req.headers, "origin")) { send(res, 403, apiError("ccdx_local_only", "The Claude gateway accepts native local clients only"));return; }
    if (!authenticated(req.headers, apiKey)) { send(res, 401, apiError("ccdx_gateway_auth", "Invalid local gateway credential"));return; }
    let pathname;try { pathname = new URL(req.url, "http://localhost").pathname; } catch { send(res, 400, apiError("ccdx_invalid_path", "Invalid request path"));return; }
    if (req.method === "GET" && pathname === "/v1/models") {
      try {
        const entries = provider.models("claude");
        const models = claudeModelEntries(entries).map((entry, index) => ({ id: entry.name, type: "model", display_name: typeof entries[index].name === "string" && entries[index].name || entry.name }));
        send(res, 200, { data: models, has_more: false, first_id: models[0]?.id || null, last_id: models.at(-1)?.id || null });
      } catch (error) { send(res, 503, apiError(error.code || "ccdx_catalog_unavailable", "Claude model discovery is unavailable; refresh the provider catalog.")); }
      return;
    }
    if (!["/v1/messages", "/v1/messages/count_tokens"].includes(pathname)) { send(res, 404, apiError("ccdx_not_found", "Not found"));return; }
    if (req.method !== "POST") { send(res, 405, apiError("ccdx_method", "Use POST"));return; }
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] || "")) { send(res, 415, apiError("ccdx_media_type", "Expected application/json"));return; }
    const parent = currentRequestContext();
    if (parent) parent.provider = provider.id;
    const countTokens = pathname.endsWith("/count_tokens"), requestId = parent?.requestId || randomUUID();
    const tracker = countTokens ? null : performance.begin("messages", { requestId });
    tracker?.setProvider(provider.id);
    const abort = createRequestAbort(req, res);
    let release = () => {}, outcome = "failed", model = null, responseId = null, usage = null, stopReason = null, streamed = false, sawStop = false, failedEvent = false;
    if (!countTokens) { stats.total++;stats.active++;stats.last_request_at = new Date().toISOString(); }
    await runWithRequestContext({ requestId, provider: provider.id, route: "messages", streamPerformance: tracker }, async () => {
      try {
        release = await acquireRequest(req, { signal: abort.signal });
        abort.setTimeout(config.requestBodyTimeoutMs, "request_body_timeout");
        let body = await readJsonBody(req, { admission: release, signal: abort.signal, maxBodyBytes: config.maxBodyBytes, maxDecodedBodyBytes: decodedLimit });
        if (!body || typeof body.model !== "string" || !Array.isArray(body.messages)) {
          send(res, 400, apiError("ccdx_messages_invalid", "Expected a model and messages array"));return;
        }
        model = body.model;stats.last_model = model;streamed = !countTokens && body.stream === true;tracker?.setModel(model);
        const upstream = await provider.client.messages(body, { headers: req.headers, countTokens, signal: abort.signal,
          onUpstreamStart() { abort.setTimeout(streamed ? config.streamHandshakeTimeoutMs : config.upstreamTimeoutMs, "upstream_timeout"); } });
        body = null;
        tracker?.upstreamHeaders(upstream.status);
        release();release = () => {};
        try { onRequest({ client: req.headers["x-ccdx-client"] === "claude-app" ? "claude_app" : req.headers["x-ccdx-client"] === "claude-code" ? "claude_code" : "claude" }); } catch {}
        const headers = safeUpstreamResponseHeaders(upstream.headers);
        for (const [name, value] of upstream.headers) if (/^anthropic-ratelimit-[a-z0-9-]+$/.test(name)) headers[name] = value;
        if (!upstream.ok || !streamed) {
          const raw = await readBoundedResponseText(upstream, { maxBytes: upstream.ok ? config.maxUpstreamResponsesResponseBytes : MAX_UPSTREAM_ERROR_BODY_BYTES,
            label: "Claude gateway response", signal: abort.signal });
          let value;try { value = JSON.parse(raw); } catch {}
          if (!countTokens && upstream.ok && value?.type === "message" && Array.isArray(value.content)) {
            model = value.model || model;responseId = value.id;usage = value.usage;stopReason = value.stop_reason;
            sawStop = typeof stopReason === "string";outcome = stopReason === "max_tokens" ? "incomplete" : sawStop ? "completed" : "failed";
          } else if (countTokens && upstream.ok) outcome = "completed";
          if (!res.destroyed && !res.writableEnded) { res.writeHead(upstream.status, headers);res.end(raw); }
        } else {
          if (!/^text\/event-stream(?:\s*;|$)/i.test(upstream.headers.get("content-type") || "")) throw new Error("Expected a Claude event stream");
          abort.setTimeout(config.streamIdleTimeoutMs, "stream_idle_timeout");
          res.writeHead(upstream.status, { ...headers, "Cache-Control": "no-cache" });
          const observer = createMessagesObserver(event => {
            if (event.type === "error") { failedEvent = true;outcome = "failed";return; }
            if (sawStop || failedEvent) return;
            if (event.type === "message_start") { responseId = event.message?.id;model = event.message?.model || model;usage = event.message?.usage || {}; }
            if (event.type === "content_block_delta") tracker?.firstOutput(event.delta?.type === "input_json_delta" ? "tool_arguments" : "output_text");
            if (event.type === "message_delta") { usage = { ...usage, ...event.usage };stopReason = event.delta?.stop_reason || stopReason; }
            if (event.type === "message_stop") { sawStop = true;outcome = stopReason === "max_tokens" ? "incomplete" : "completed"; }
          }, config.maxSseBufferBytes);
          const reader = upstream.body.getReader();
          try {
            while (true) {
              const { value, done } = await reader.read();if (done) break;
              tracker?.upstreamActivity();abort.setTimeout(config.streamIdleTimeoutMs, "stream_idle_timeout");
              observer.write(value);
              if (!await writeOrDrain(res, value, { signal: abort.signal })) break;
              if (sawStop || failedEvent) break;
            }
            observer.finish();
            if (!sawStop && !failedEvent) throw new Error("Claude stream ended before message_stop");
            if (!res.writableEnded) res.end();
          } finally { await reader.cancel().catch(() => {});reader.releaseLock(); }
        }
      } catch (error) {
        outcome = ["client_aborted", "client_closed"].includes(abort.reason) ? "cancelled" : "failed";
        const message = redactDiagnosticText(error.message).split(apiKey).join("[redacted]").slice(0, 240);
        log("warn", `Claude request ${requestId}: ${error.code || abort.reason || "gateway_error"}`);
        if (!res.headersSent) send(res, error.statusCode || 502, apiError(error.code || "ccdx_gateway_error", message));
        else if (!res.destroyed && !res.writableEnded) res.end(`event: error\ndata: ${JSON.stringify(apiError("ccdx_gateway_error", message))}\n\n`);
      } finally {
        release();abort.cleanup();
        if (!countTokens) {
          stats.active--;stats[outcome]++;
          tracker?.setModel(model);tracker?.setOutputTokens(usage?.output_tokens);
          tracker?.terminal(outcome, { origin: failedEvent ? "upstream_event" : "upstream_response", reason: stopReason === "max_tokens" ? "max_output_tokens" : undefined });
          tracker?.finish({ failed: outcome === "failed" || outcome === "cancelled", aborted: outcome === "cancelled", statusCode: res.statusCode });
          const client = req.headers["x-ccdx-client"] === "claude-app" ? "claude_app" : req.headers["x-ccdx-client"] === "claude-code" ? "claude_code" : "claude";
          try { void Promise.resolve(record(buildMessagesUsageRecord({ model, responseId, usage, mode: streamed ? "stream" : "json", client, provider: provider.id }))).catch(() => {}); } catch {}
        }
      }
    });
  }
  const handler = (req, res) => dispatch(req, res).catch(() => send(res, 500, apiError("ccdx_gateway_error", "Claude gateway request failed")));
  handler.snapshot = () => ({ ...stats, admission: acquireRequest.stats(), performance: performance.snapshot() });
  return handler;
}

// Mounted by the main dispatcher. Own only Claude responses, never the shared listener.
export function createClaudeGateway(options = {}) {
  const handler = createClaudeGatewayHandler(options), responses = new Set();
  let closed = false;
  return { port: options.port, snapshot: handler.snapshot,
    handle(req, res) {
      if (closed) { send(res, 503, apiError("ccdx_gateway_closed", "Claude is stopping"));return; }
      responses.add(res);
      return Promise.resolve(handler(req, res)).finally(() => responses.delete(res));
    },
    async close() { closed = true;for (const res of responses) res.destroy?.();responses.clear(); },
  };
}

export async function startClaudeGateway(options = {}) {
  const handler = createClaudeGatewayHandler(options), server = http.createServer(handler);
  server.headersTimeout = 15000;server.requestTimeout = 120000;
  await new Promise((resolve, reject) => { server.once("error", reject);server.listen(options.port ?? 2027, "127.0.0.1", () => { server.off("error", reject);resolve(); }); });
  server.on("error", () => options.log?.("warn", "Claude gateway listener error"));
  return { port: server.address().port, snapshot: handler.snapshot,
    close: () => new Promise(resolve => { server.closeAllConnections();server.close(resolve); }) };
}
