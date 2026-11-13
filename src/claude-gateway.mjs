import { isProviderId } from "./provider-metadata.mjs";
import { claudeModelEntries, resolveClaudeModel } from "./claude-models.mjs";
import http from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { createRequestAbort, abortErrorStatusCode, readJsonBody, readBoundedResponseText, writeOrDrain, MAX_UPSTREAM_ERROR_BODY_BYTES } from "./http-transport.mjs";
import { createRequestAdmission } from "./request-admission.mjs";
import { loadRuntimeConfig } from "./runtime-config.mjs";
import { isLoopbackAddress, isLoopbackHostHeader } from "./security.mjs";
import { safeUpstreamResponseHeaders } from "./upstream-headers.mjs";
import { runWithRequestContext, currentRequestContext, observeRequestedModel } from "./request-context.mjs";
import { upstreamErrorEvidence, requestOptionsEvidence } from "./response-failures.mjs";
import { createStreamPerformanceMetrics, isMessagesOutputDelta, markRequestObservation } from "./stream-performance.mjs";
import { buildMessagesUsageRecord, recordUsage } from "./usage-store.mjs";
import { redactDiagnosticText } from "./diagnostic-text.mjs";
import { decodedBodyLimitPreference } from "./user-settings.mjs";
import { operationErrorDetails, transportErrorDetails } from "./operation-error.mjs";
import { requestApplication } from "./request-application.mjs";
import { observeContextSession } from "./context-metrics.mjs";
import { catalogCapabilities } from "./model-capabilities.mjs";
import { applyMessagesSystemPolicy } from "./messages-system-policy.mjs";
import { createApiTokenCounter } from "./providers/api-token-count.mjs";
import { MESSAGES_TOOL_GUARD } from "./messages-tool-schema.mjs";

function observeMessagesWindow(provider, model, capability, entry) {
  try {
    if (capability == null) {
      entry ||= resolveClaudeModel(provider.models("claude"), model);
      capability = entry?.protocol_capabilities?.messages ?? entry?.capability;
    }
    if (capability == null && !entry) return;
    const values = capability == null ? catalogCapabilities(entry) : capability.values;
    markRequestObservation({ context_window_tokens: values?.context_window });
  } catch { /* Optional catalog metadata must not change inference availability. */ }
}

function send(res, code, value) {
  if (res.destroyed || res.writableEnded) return;
  const context = currentRequestContext();
  if (code >= 400) context?.onHttpError?.({ code: value?.error?.code, origin: context.errorOrigin || "client_validation" });
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });res.end(JSON.stringify(value));
}
const apiError = (code, message) => ({ type: "error", error: { type: "api_error", code, message } });
const MAX_TERMINAL_DRAIN_BYTES = 64 * 1024;
const TERMINAL_DRAIN_TIMEOUT_MS = 1000;
async function drainAfterMessageStop(reader) {
  let bytes = 0, ended = false;
  const cancel = () => { try { void reader.cancel().catch(() => {}); } catch {} };
  const timer = setTimeout(cancel, TERMINAL_DRAIN_TIMEOUT_MS);timer.unref?.();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) { ended = true;break; }
      bytes += value.byteLength;
      if (bytes > MAX_TERMINAL_DRAIN_BYTES) break;
    }
  } catch { /* The response has already ended for the client. */ }
  finally {
    clearTimeout(timer);if (!ended) cancel();
    try { reader.releaseLock(); } catch {}
  }
}
const hasMessageState = block => Boolean(block && (block.id || block.signature || block.data
  || typeof block.text === "string" && block.text.length || typeof block.thinking === "string" && block.thinking.length));
function authenticated(headers, key) {
  const candidates = [headers["x-api-key"], typeof headers.authorization === "string" ? /^Bearer (.+)$/i.exec(headers.authorization)?.[1] : null];
  const expected = Buffer.from(key);
  return candidates.some(value => typeof value === "string" && Buffer.byteLength(value) === expected.length && timingSafeEqual(Buffer.from(value), expected));
}

// Observe bounded SSE frames. Alias clients rewrite only message_start.model;
// other frames retain their wire text. Client backpressure controls upstream reads.
export function createMessagesObserver(onEvent, maxBytes = 8 * 1024 * 1024, clientModel = null) {
  const decoder = new TextDecoder("utf-8", { fatal: true });let fragments = [], lineBytes = 0, data = [], frameBytes = 0, wire = [], wireBytes = 0, output = [];
  let pendingCR = false, bareCR = false, optionalLF = false;
  const frame = () => {
    let value;
    if (data.length) { try { value = JSON.parse(data.join("\n")); } catch { throw new Error("Invalid Claude stream event"); }onEvent(value); }
    if (wire.length) {
      if (clientModel && value?.type === "message_start" && value.message && typeof value.message === "object" && !Array.isArray(value.message)) {
        const replacement = JSON.stringify({ ...value, message: { ...value.message, model: clientModel } });let replaced = false;
        wire = wire.map(line => {
          if (!line.startsWith("data:")) return line;
          if (replaced) return "";replaced = true;
          return `data: ${replacement}${line.endsWith("\r\n") ? "\r\n" : line.endsWith("\n") ? "\n" : line.endsWith("\r") ? "\r" : ""}`;
        });
      }
      output.push(Buffer.from(wire.join("")));wire = [];wireBytes = 0;
    }
    data = [];frameBytes = 0;
  };
  const line = (value, newline = true, bytes) => {
    {
      wireBytes += (bytes ?? Buffer.byteLength(value)) + (newline ? 1 : 0);
      if (wireBytes > maxBytes) throw new Error("Claude stream event exceeds its limit");
      wire.push(value + (newline ? "\n" : ""));
    }
    if (value.endsWith("\r")) value = value.slice(0, -1);
    if (!value) frame();
    else if (value.startsWith("{")) {
      let error;try { error = JSON.parse(value); } catch {}
      if (error?.type === "error" || error?.error && typeof error.error === "object") {
        onEvent({ ...error, type: "error" });
        throw new Error("Upstream returned a JSON error outside an SSE data frame");
      }
    }
    else if (value.startsWith("data:")) {
      const part = value.slice(5).replace(/^ /, "");frameBytes += Buffer.byteLength(part);
      if (frameBytes > maxBytes) throw new Error("Claude stream event exceeds its limit");data.push(part);
    }
  };
  const completeLine = ending => { line(fragments.join("") + (ending.startsWith("\r") ? "\r" : ""), ending.endsWith("\n"));fragments = [];lineBytes = 0; };
  function consume(text) {
    let start = 0;
    if (!bareCR && text.length) {
      const tailCR = fragments.at(-1)?.endsWith("\r") === true;
      if (tailCR && text[0] !== "\n") {
        bareCR = true;
        fragments[fragments.length - 1] = fragments.at(-1).slice(0, -1);lineBytes--;
        completeLine("\r");
      }
    }
    if (!bareCR) {
      let nextCR = text.indexOf("\r", start);
      while (start < text.length) {
        const newline = text.indexOf("\n", start), end = newline < 0 ? text.length : newline, part = text.slice(start, end);
        if (nextCR >= 0 && nextCR < end - 1) { bareCR = true;break; }
        lineBytes += Buffer.byteLength(part);
        if (lineBytes > maxBytes || wireBytes + lineBytes > maxBytes) throw new Error("Claude stream line exceeds its limit");
        fragments.push(part);
        if (newline < 0) break;
        line(fragments.length === 1 ? fragments[0] : fragments.join(""), true, lineBytes);
        fragments = [];lineBytes = 0;start = newline + 1;
        if (nextCR >= 0 && nextCR === end - 1) nextCR = text.indexOf("\r", start);
      }
      if (!bareCR) return;
    }
    if (optionalLF) {
      optionalLF = false;
      if (text.startsWith("\n")) { output.push(Buffer.from("\n"));start = 1; }
    }
    if (pendingCR && start < text.length) {
      pendingCR = false;
      if (text[start] === "\n") { completeLine("\r\n");start++; }
      else { bareCR = true;completeLine("\r"); }
    }
    while (start < text.length) {
      const lf = text.indexOf("\n", start), cr = text.indexOf("\r", start);
      const end = lf < 0 ? (cr < 0 ? text.length : cr) : cr < 0 ? lf : Math.min(lf, cr);
      const part = text.slice(start, end);
      lineBytes += Buffer.byteLength(part);
      if (lineBytes > maxBytes || wireBytes + lineBytes > maxBytes) throw new Error("Claude stream line exceeds its limit");
      fragments.push(part);
      if (end === text.length) break;
      if (text[end] === "\n") { completeLine("\n");start = end + 1;continue; }
      if (end + 1 === text.length) {
        if (bareCR && lineBytes === 0) { completeLine("\r");optionalLF = true; }
        else pendingCR = true;
        break;
      }
      if (text[end + 1] === "\n") { completeLine("\r\n");start = end + 2; }
      else { bareCR = true;completeLine("\r");start = end + 1; }
    }
  }
  return { write(chunk) { output = [];consume(decoder.decode(chunk, { stream: true }));return output; },
    finish() { output = [];consume(decoder.decode());if (pendingCR) { pendingCR = false;completeLine("\r"); }
      if (!bareCR && fragments.at(-1)?.endsWith("\r")) { fragments[fragments.length - 1] = fragments.at(-1).slice(0, -1);lineBytes--;completeLine("\r"); }
      if (fragments.length) completeLine("");if (wire.length) wire.push("\n\n");frame();return output; } };
}

// Only schema-recovery responses need this extra frame pass. Keep the ordinary
// Messages parser unchanged so normal streams do not pay for tool validation.
function createGuardedMessagesObserver(onEvent, maxBytes, clientModel, guard, restore) {
  const pending = [], observer = createMessagesObserver(event => pending.push(event), maxBytes, clientModel);
  const filter = frames => {
    const output = [];
    for (const chunk of frames) {
      const parts = chunk.toString("utf8").split(/\r\n|\r|\n/).filter(line => line.startsWith("data:"))
        .map(line => line.slice(5).replace(/^ /, ""));
      if (parts.length && !pending.length) throw new Error("Missing Claude stream event");
      const event = parts.length ? pending.shift() : undefined;
      for (const result of guard.frame(event, chunk, parts.join("\n"), restore)) {
        if (result.event !== undefined) onEvent(result.event);
        output.push(result.chunk);
      }
    }
    if (pending.length) throw new Error("Missing Claude stream frame");
    return output;
  };
  const run = (method, chunk) => {
    try { return filter(method === "write" ? observer.write(chunk) : observer.finish()); }
    catch (error) {
      for (const event of pending.splice(0)) if (event?.type === "error") onEvent(event);
      throw error;
    }
  };
  return { write: chunk => run("write", chunk), finish: () => run("finish") };
}

export function createClaudeGatewayHandler({ provider, apiKey, desktopAliases = false, appContract, messagesSystemMode = "passthrough", log = () => {}, onRequest = () => {}, env = process.env, performance: sharedPerformance, validateConversation,
  resolveRequest, privacy, privacyClient = "claude", record = recordUsage, acquireRequest = createRequestAdmission({ maxBytes: 16 * 1024 * 1024, maxQueued: 8 }) } = {}) {
  if (!provider || !isProviderId(provider.id) || typeof apiKey !== "string" || apiKey.length < 32) throw new Error("Claude gateway requires a provider and private local key");
  const config = loadRuntimeConfig(env), performance = sharedPerformance || createStreamPerformanceMetrics({ routeNames: ["messages"] });
  const decodedLimit = decodedBodyLimitPreference({ env }).bytes;
  const stats = { total: 0, active: 0, completed: 0, incomplete: 0, failed: 0, cancelled: 0, last_request_at: null, last_model: null };
  const countCoordinators = new WeakMap();
  async function dispatch(req, res) {
    let selectedProvider = provider, finishProvider = () => {};
    if (!isLoopbackAddress(req.socket?.remoteAddress) || req.headers.host === undefined || !isLoopbackHostHeader(req.headers.host)
      || Object.hasOwn(req.headers, "origin")) { send(res, 403, apiError("ccdx_local_only", "The Claude gateway accepts native local clients only"));return; }
    if (!authenticated(req.headers, apiKey)) { send(res, 401, apiError("ccdx_gateway_auth", "Invalid local gateway credential"));return; }
    let pathname;try { pathname = new URL(req.url, "http://localhost").pathname; } catch { send(res, 400, apiError("ccdx_invalid_path", "Invalid request path"));return; }
    if (req.method === "GET" && pathname === "/v1/models") {
      try {
        const entries = provider.models("claude");
        const models = claudeModelEntries(entries, { desktopAliases, appContract }).map((entry, index) => ({ id: entry.name, type: "model", ...(entry.supports1m ? { supports_1m: true } : {}),
          ...(entry.behavesAs ? { behaves_as: entry.behavesAs, max_effort_level: entry.maxEffort } : {}),
          display_name: entry.labelOverride || typeof entries[index].name === "string" && entries[index].name || entry.name }));
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
    const tracker = countTokens ? parent?.streamPerformance : performance.begin("messages", { requestId, purpose: req.headers["x-ccdx-purpose"], application: requestApplication(req.headers, "claude") });
    if (!resolveRequest) tracker?.setProvider(provider.id);
    const abort = createRequestAbort(req, res);
    let release = () => {}, conversation, outcome = "failed", model = null, configuredModel = null, clientModel = null, responseId = null, usage = null, stopReason = null, streamed = false, sawStop = false, failedEvent = false;
    let selectedModel, selectedCapability;
    let terminalOrigin = "client_validation", failureStatus = null, countDeadline = null, rejectionReason;
    if (!countTokens) { stats.total++;stats.active++;stats.last_request_at = new Date().toISOString(); }
    const context = parent || { requestId, purpose: req.headers["x-ccdx-purpose"] };
    context.provider = selectedProvider.id;context.application = requestApplication(req.headers, "claude");
    context.streamPerformance = tracker;context.route = countTokens ? "messages_count_tokens" : "messages";
    await runWithRequestContext(context, async () => {
      try {
        release = await acquireRequest(req, { signal: abort.signal });
        abort.setTimeout(config.requestBodyTimeoutMs, "request_body_timeout");
        let body = await readJsonBody(req, { admission: release, signal: abort.signal, maxBodyBytes: config.maxBodyBytes, maxDecodedBodyBytes: decodedLimit });
        abort.setTimeout(config.upstreamTimeoutMs, "messages_prepare_timeout");
        observeRequestedModel(body);
        context.requestOptions = requestOptionsEvidence(body);
        if (context.requestOptions.client_tool_errors_received) markRequestObservation({ client_tool_errors_received: context.requestOptions.client_tool_errors_received });
        if (!body || typeof body.model !== "string" || !Array.isArray(body.messages)) {
          send(res, 400, apiError("ccdx_messages_invalid", "Expected a model and messages array"));return;
        }
        if (resolveRequest) {
          const resolved = await resolveRequest(body, req);
          selectedProvider = resolved.provider;finishProvider = resolved.finish || finishProvider;
          configuredModel = resolved.model;clientModel = body.model === configuredModel ? null : body.model;
          selectedCapability = resolved.capability;
          body = { ...body, model: configuredModel };tracker?.setProvider(selectedProvider.id);
          const context = currentRequestContext();if (context) context.provider = selectedProvider.id;
        }
        const inlineSystem = selectedCapability?.values?.mid_conversation_system;
        body = applyMessagesSystemPolicy(body, inlineSystem === true ? "native" : inlineSystem === false ? "legacy" : selectedProvider.messagesSystemMode ?? messagesSystemMode);
        model = body.model;streamed = !countTokens && body.stream === true;
        if (!resolveRequest && (provider.configuredModels || desktopAliases)) {
          selectedModel = resolveClaudeModel(provider.models("claude"), model, { desktopAliases });
          configuredModel = selectedModel?.id;
        }
        if (desktopAliases && !configuredModel) throw Object.assign(new Error("The selected model is unavailable"), { code: "ccdx_api_model_unavailable", statusCode: 400 });
        if (desktopAliases && configuredModel !== model) { clientModel = model;model = configuredModel;body = { ...body, model }; }
        stats.last_model = model;
        context.model = configuredModel || model;
        if (!countTokens) {
          markRequestObservation({ max_output_tokens_requested: body.max_tokens, reasoning_effort_requested: body.output_config?.effort });
          observeMessagesWindow(selectedProvider, configuredModel || model, selectedCapability, selectedModel);
        }
        tracker?.setModel(configuredModel || model, { configured: Boolean(configuredModel) });
        conversation = await validateConversation?.(body, req.headers, selectedProvider, abort.signal);
        if (!countTokens) observeContextSession(body, req.headers, selectedProvider, "messages");
        terminalOrigin = "transport";
        const call = privacy?.wrap(selectedProvider.client.messages, { res, protocol: "messages", client: privacyClient }) || selectedProvider.client.messages;
        let upstreamHeadersObserved = false;
        const callOptions = { headers: req.headers, countTokens, signal: abort.signal,
          onUpstreamErrorHeaders(status) { upstreamHeadersObserved = true;tracker?.upstreamHeaders(status);body = null;release();release = () => {}; },
          onCountObservation(value) {
            context.countObservation = { ...context.countObservation, ...value };
            if (value.upstream) { context.upstreamAttempts = (context.upstreamAttempts || 0) + 1;tracker?.upstreamStarted(false); }
          },
          onUpstreamStart() {
            if (abort.signal.aborted) throw abort.signal.reason;
            const timeout = streamed ? config.streamHandshakeTimeoutMs : config.upstreamTimeoutMs;
            if (countTokens) countDeadline ??= Date.now() + timeout;
            abort.setTimeout(countTokens ? Math.max(1, countDeadline - Date.now()) : timeout, "upstream_timeout");
          } };
        let upstream;
        if (countTokens && selectedProvider.coordinateMessagesCounts) {
          let counter = countCoordinators.get(selectedProvider);
          if (!counter) {
            counter = createApiTokenCounter({ request: (value, options) => options.perform(value, options) });
            countCoordinators.set(selectedProvider, counter);
          }
          upstream = await counter.count(body, { ...callOptions, perform: call });
        } else upstream = await call(body, callOptions);
        const toolGuard = upstream[MESSAGES_TOOL_GUARD];
        const restoreToolInput = toolGuard && privacy?.restoreResponse ? value => privacy.restoreResponse(res, value) : null;
        body = null;
        terminalOrigin = upstream.ok ? "upstream_response" : "upstream_http";
        if (!upstreamHeadersObserved) tracker?.upstreamHeaders(upstream.status);
        release();release = () => {};
        try { onRequest({ client: req.headers["x-ccdx-client"] === "claude-app" ? "claude_app" : req.headers["x-ccdx-client"] === "claude-code" ? "claude_code" : "claude" }); } catch {}
        const headers = safeUpstreamResponseHeaders(upstream.headers);
        for (const [name, value] of upstream.headers) if (/^anthropic-ratelimit-[a-z0-9-]+$/.test(name)) headers[name] = value;
        if (!upstream.ok || !streamed) {
          const raw = await readBoundedResponseText(upstream, { maxBytes: upstream.ok ? config.maxUpstreamResponsesResponseBytes : MAX_UPSTREAM_ERROR_BODY_BYTES,
            label: "Claude gateway response", signal: abort.signal });
          let value;
          if (toolGuard && upstream.ok && !countTokens) value = toolGuard.validateMessage(raw, restoreToolInput);
          else try { value = JSON.parse(raw); } catch {}
          const modelFailure = upstream.ok && (!value?.type || value.type === "error") && value?.error && typeof value.error === "object" && !Array.isArray(value.error)
            && ["code", "type", "message"].some(key => typeof value.error[key] === "string" && value.error[key].trim())
            && !["content", "output", "choices", "candidates"].some(key => Array.isArray(value[key]) && value[key].length);
          if (modelFailure) {
            const evidence = upstreamErrorEvidence(raw);
            context.onHttpError?.({ ...evidence, code: evidence.code || evidence.error_type || "upstream_error", model_error: true, origin: "upstream_response", headers: upstream.headers });
          }
          if (!upstream.ok) context.onHttpError?.({ ...upstreamErrorEvidence(raw, { status: upstream.status }),
            origin: context.countObservation?.cached ? "capability_cache" : "upstream_http", headers: upstream.headers });
          if (!countTokens && upstream.ok && value?.type === "message" && Array.isArray(value.content)) {
            if (value.content.some(hasMessageState)) await conversation?.commit?.({ tool: value.content.some(block => block?.type === "tool_use") });
            abort.signal.throwIfAborted();
            model = value.model || model;responseId = value.id;usage = value.usage;stopReason = value.stop_reason;
            sawStop = typeof stopReason === "string";outcome = stopReason === "max_tokens" ? "incomplete" : sawStop ? "completed" : "failed";
          } else if (countTokens && upstream.ok && !modelFailure) outcome = "completed";
          const outgoing = clientModel && !countTokens && upstream.ok && value?.type === "message" ? JSON.stringify({ ...value, model: clientModel }) : raw;
          if (!res.destroyed && !res.writableEnded) { res.writeHead(upstream.status, headers);res.end(outgoing); }
        } else {
          if (!/^text\/event-stream(?:\s*;|$)/i.test(upstream.headers.get("content-type") || "")) throw new Error("Expected a Claude event stream");
          abort.setTimeout(config.streamIdleTimeoutMs, "stream_idle_timeout");
          res.writeHead(upstream.status, { ...headers, "Cache-Control": "no-cache" });
          let commitState = null, conversationCommitted = false;
          const commitOutput = async () => {
            if (commitState && !conversationCommitted && conversation?.commit) {
              conversationCommitted = await conversation.commit(commitState) === true;
              abort.signal.throwIfAborted();
            }
            commitState = null;
          };
          const observe = event => {
            if (event.type === "error") {
              failedEvent = true;outcome = "failed";
              const evidence = upstreamErrorEvidence(JSON.stringify(event));
              context.onHttpError?.({ ...evidence, code: evidence.code || evidence.error_type || "upstream_error", model_error: true, origin: "upstream_event", headers: upstream.headers });return;
            }
            if (sawStop || failedEvent) return;
            if (event.type === "content_block_start" && hasMessageState(event.content_block)
              || event.type === "content_block_delta" && (isMessagesOutputDelta(event.delta) || event.delta?.type === "signature_delta" && event.delta.signature)) {
              if (!conversationCommitted) commitState = { tool: commitState?.tool === true || event.content_block?.type === "tool_use" };
            }
            if (event.type === "message_start") { responseId = event.message?.id;model = event.message?.model || model;usage = event.message?.usage || {}; }
            if (event.type === "content_block_delta" && isMessagesOutputDelta(event.delta)) tracker?.firstOutput();
            if (event.type === "message_delta") {
              usage = { ...usage, ...Object.fromEntries(Object.entries(event.usage || {}).filter(([, value]) => value != null)) };
              stopReason = event.delta?.stop_reason || stopReason;
            }
            if (event.type === "message_stop") { sawStop = true;outcome = stopReason === "max_tokens" ? "incomplete" : "completed"; }
          };
          const observer = toolGuard
            ? createGuardedMessagesObserver(observe, config.maxSseBufferBytes, clientModel, toolGuard, restoreToolInput)
            : createMessagesObserver(observe, config.maxSseBufferBytes, clientModel);
          const reader = upstream.body.getReader();
          let draining = false;
          try {
            while (true) {
              const { value, done } = await reader.read();if (done) break;
              tracker?.upstreamActivity();abort.setTimeout(config.streamIdleTimeoutMs, "stream_idle_timeout");
              const frames = observer.write(value);
              await commitOutput();
              let writable = true;
              for (const chunk of frames) if (!await writeOrDrain(res, chunk, { signal: abort.signal })) { writable = false;break; }
              if (!writable) break;
              if (sawStop || failedEvent) break;
            }
            const tail = observer.finish();await commitOutput();
            for (const chunk of tail) if (!await writeOrDrain(res, chunk, { signal: abort.signal })) break;
            if (!sawStop && !failedEvent) throw new Error("Claude stream ended before message_stop");
            if (!res.writableEnded) res.end();
            if (sawStop && !failedEvent && !abort.signal.aborted && !res.destroyed) {
              draining = true;void drainAfterMessageStop(reader);
            }
          } finally {
            if (!draining) { await reader.cancel().catch(() => {});reader.releaseLock(); }
          }
        }
      } catch (error) {
        rejectionReason = error.jsonBody?.error?.reason || (error.code === "ccdx_client_source_disabled" ? error.code : undefined);
        const detail = operationErrorDetails(error, { reason: abort.reason });
        outcome = detail.source === "cancelled" ? "cancelled" : "failed";
        const statusCode = detail.status || (abort.reason ? abortErrorStatusCode(abort.reason) : 502);
        failureStatus = statusCode;terminalOrigin = outcome === "cancelled" ? "client_disconnect" : error.origin === "privacy" ? "privacy" : statusCode < 500 && statusCode !== 429 ? "client_validation" : "transport";
        context.errorOrigin = terminalOrigin;
        const message = redactDiagnosticText(error.message).split(apiKey).join("[redacted]").slice(0, 240);
        const diagnostic = error.code === "ccdx_api_network_unavailable" ? transportErrorDetails(error) : null;
        log(outcome === "cancelled" ? "info" : "warn", `Claude request ${requestId}: ${detail.code}${diagnostic ? ` (${diagnostic.code}, ${diagnostic.phase})` : ""}`);
        tracker?.setErrorOrigin(terminalOrigin);
        context.onHttpError?.({ code: detail.code, origin: terminalOrigin, ...(rejectionReason ? { reason: rejectionReason } : {}), ...(diagnostic ? { transport: diagnostic } : {}) });
        if (outcome === "cancelled") return;
        if (!res.headersSent) {
          if (error.origin === "privacy" && Number.isInteger(error.retryAfter) && error.retryAfter > 0) res.setHeader("Retry-After", String(error.retryAfter));
          const value = apiError(abort.reason || error.code || "ccdx_gateway_error", message);
          if (rejectionReason) value.error.reason = rejectionReason;
          if (diagnostic) value.error.diagnostic = diagnostic;
          send(res, statusCode, value);
        }
        else if (!res.destroyed && !res.writableEnded) res.end(`event: error\ndata: ${JSON.stringify(apiError("ccdx_gateway_error", message))}\n\n`);
      } finally {
        conversation?.release?.();release();abort.cleanup();finishProvider();
        if (!countTokens) {
          stats.active--;stats[outcome]++;
          const usageRecord = buildMessagesUsageRecord({ model: configuredModel || model, responseId, usage, mode: streamed ? "stream" : "json",
            client: req.headers["x-ccdx-client"] === "claude-app" ? "claude_app" : req.headers["x-ccdx-client"] === "claude-code" ? "claude_code" : "claude", provider: selectedProvider.id });
          markRequestObservation({ input_tokens: usageRecord?.usage?.input_tokens, output_tokens: usageRecord?.usage?.output_tokens,
            cached_input_tokens: usageRecord?.usage?.cached_input_tokens });
          tracker?.setModel(configuredModel || model, { configured: Boolean(configuredModel) });tracker?.setOutputTokens(usage?.output_tokens);
          tracker?.terminal(outcome, { origin: failedEvent ? "upstream_event" : terminalOrigin, stopReason, reason: stopReason === "max_tokens" ? "max_output_tokens" : undefined });
          tracker?.finish({ failed: outcome === "failed" || outcome === "cancelled", aborted: outcome === "cancelled", statusCode: failureStatus || res.statusCode, rejectionReason });
          try { void Promise.resolve(record(usageRecord)).catch(() => {}); } catch {}
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
