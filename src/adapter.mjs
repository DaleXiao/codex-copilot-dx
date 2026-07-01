import http from "node:http";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import * as zlib from "node:zlib";
import { chatCompletions, listModels, responses as copilotResponses, responsesCompact as copilotResponsesCompact } from "./copilot.mjs";
import { webStreamLines } from "./stream.mjs";
import { anthropicToChat, chatToAnthropic, streamAnthropicFromLines, countTokens } from "./anthropic.mjs";
import { claudeDesktopModelsResponse, resolveAnthropicModel } from "./models.mjs";
import { status } from "./status.mjs";
import { recordAnthropicUsage, recordResponsesUsage } from "./usage.mjs";

// Models that only support Responses API (not chat/completions)
const RESPONSES_ONLY = new Set([
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex",
  "gpt-5.2-codex",
]);

// Direct Copilot Responses API proxy.

const RESPONSE_HISTORY_LIMIT = 64;
const responseHistories = new Map();
const DEFAULT_MAX_BODY_BYTES = 128 * 1024 * 1024;
const DEFAULT_MAX_DECODED_BODY_BYTES = 256 * 1024 * 1024;
const DEFAULT_UPSTREAM_TIMEOUT_MS = 120 * 1000;
const gunzipAsync = promisify(zlib.gunzip);
const inflateAsync = promisify(zlib.inflate);
const brotliDecompressAsync = promisify(zlib.brotliDecompress);
const zstdDecompressAsync = zlib.zstdDecompress ? promisify(zlib.zstdDecompress) : null;

function positiveInt(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const MAX_BODY_BYTES = positiveInt(process.env.CCDX_MAX_BODY_BYTES, DEFAULT_MAX_BODY_BYTES);
const MAX_DECODED_BODY_BYTES = positiveInt(process.env.CCDX_MAX_DECODED_BODY_BYTES, DEFAULT_MAX_DECODED_BODY_BYTES);
const UPSTREAM_TIMEOUT_MS = positiveInt(process.env.CCDX_UPSTREAM_TIMEOUT_MS, DEFAULT_UPSTREAM_TIMEOUT_MS);

export function requestPath(reqUrl) {
  return new URL(reqUrl || "/", "http://localhost").pathname;
}

function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function httpError(message, statusCode) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function payloadTooLarge(kind, maxBytes) {
  return httpError(`${kind} request body exceeds ${maxBytes} bytes`, 413);
}

async function readRequestBuffer(req, maxBytes) {
  const contentLength = Number.parseInt(req.headers?.["content-length"] || "", 10);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw payloadTooLarge("Raw", maxBytes);
  }

  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) throw payloadTooLarge("Raw", maxBytes);
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

async function decompressBody(decompress, buffer, maxBytes) {
  try {
    return await decompress(buffer, { maxOutputLength: maxBytes });
  } catch (e) {
    if (e?.code === "ERR_BUFFER_TOO_LARGE" || /maxOutputLength/i.test(e?.message || "")) {
      throw payloadTooLarge("Decoded", maxBytes);
    }
    throw e;
  }
}

async function decodeRequestBuffer(buffer, contentEncoding, maxBytes) {
  const encodings = String(contentEncoding || "identity")
    .split(",")
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);

  let decoded = buffer;
  for (const encoding of encodings.reverse()) {
    if (encoding === "identity") continue;
    if (encoding === "gzip" || encoding === "x-gzip") {
      decoded = await decompressBody(gunzipAsync, decoded, maxBytes);
    } else if (encoding === "deflate") {
      decoded = await decompressBody(inflateAsync, decoded, maxBytes);
    } else if (encoding === "br") {
      decoded = await decompressBody(brotliDecompressAsync, decoded, maxBytes);
    } else if (encoding === "zstd") {
      if (!zstdDecompressAsync) throw new Error("Unsupported Content-Encoding: zstd");
      decoded = await decompressBody(zstdDecompressAsync, decoded, maxBytes);
    } else {
      throw new Error(`Unsupported Content-Encoding: ${encoding}`);
    }
    if (decoded.length > maxBytes) throw payloadTooLarge("Decoded", maxBytes);
  }
  if (decoded.length > maxBytes) throw payloadTooLarge("Decoded", maxBytes);
  return decoded;
}

export async function readJsonBody(req, {
  maxBodyBytes = MAX_BODY_BYTES,
  maxDecodedBodyBytes = MAX_DECODED_BODY_BYTES,
} = {}) {
  const buffer = await readRequestBuffer(req, maxBodyBytes);
  const decoded = await decodeRequestBuffer(buffer, req.headers?.["content-encoding"], maxDecodedBodyBytes);
  return JSON.parse(decoded.toString("utf8"));
}

function sendJsonError(res, err, fallbackStatus = 400) {
  if (res.destroyed || res.writableEnded) return;
  if (!res.headersSent) res.writeHead(err?.statusCode || fallbackStatus, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: err?.message || "Request failed" }));
}

function sendUpstreamError(res, resp, text) {
  if (!res.headersSent) {
    res.writeHead(resp.status || 502, { "Content-Type": resp.headers?.get("content-type") || "application/json" });
  }
  res.end(text || JSON.stringify({ error: "Upstream request failed" }));
}

function bearerToken(headers = {}) {
  const value = headers.authorization || headers.Authorization || "";
  const match = /^Bearer\s+(.+)$/i.exec(String(value));
  return match?.[1]?.trim() || "";
}

export function shouldServeClaudeDesktopModels(req, claudeDesktopApiKey) {
  if (!claudeDesktopApiKey || claudeDesktopApiKey === "dummy") return false;
  const token = bearerToken(req.headers);
  const xApiKey = req.headers?.["x-api-key"] || req.headers?.["X-Api-Key"] || req.headers?.["X-API-Key"] || "";
  return token === claudeDesktopApiKey || xApiKey === claudeDesktopApiKey;
}

export function writeOrDrain(res, chunk) {
  if (res.destroyed || res.writableEnded) return Promise.resolve(false);
  if (res.write(chunk)) return Promise.resolve(true);
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      res.off("drain", onDrain);
      res.off("error", onError);
      res.off("close", onClose);
    };
    const onDrain = () => { cleanup(); resolve(true); };
    const onClose = () => { cleanup(); resolve(false); };
    const onError = (err) => { cleanup(); reject(err); };
    res.once("drain", onDrain);
    res.once("close", onClose);
    res.once("error", onError);
  });
}

export function isAbortLikeError(err) {
  return err?.name === "AbortError" || /operation was aborted/i.test(String(err?.message || ""));
}

export function abortErrorStatusCode(reason) {
  if (reason === "upstream_timeout") return 504;
  if (reason === "client_aborted" || reason === "client_closed") return 499;
  return 400;
}

export function createRequestAbort(req, res) {
  const controller = new AbortController();
  let timer = null;
  let cleaned = false;
  let reason = null;
  const abort = (nextReason = "aborted") => {
    if (!cleaned && !controller.signal.aborted) {
      reason = nextReason;
      controller.abort();
    }
  };
  const onReqAborted = () => abort("client_aborted");
  const onResClose = () => {
    if (!res.writableEnded) abort("client_closed");
  };
  req.on("aborted", onReqAborted);
  res.on("close", onResClose);
  return {
    signal: controller.signal,
    get reason() { return reason; },
    setTimeout(ms) {
      if (timer) clearTimeout(timer);
      if (ms > 0) timer = setTimeout(() => abort("upstream_timeout"), ms);
    },
    cleanup() {
      cleaned = true;
      if (timer) clearTimeout(timer);
      req.off("aborted", onReqAborted);
      res.off("close", onResClose);
    },
  };
}

function logRequestFailure(label, err, abort) {
  if (!isAbortLikeError(err)) {
    console.error(status("err", `${label} request failed: ${err.message}`));
    return;
  }

  const reason = abort?.reason || "aborted";
  err.statusCode ||= abortErrorStatusCode(reason);
  const detail = reason === "upstream_timeout" ? `${reason} after ${UPSTREAM_TIMEOUT_MS}ms` : reason;
  console.warn(status("warn", `${label} request aborted: ${detail}`));
}

function responsesInputItems(input) {
  if (input === undefined || input === null) return [];
  if (typeof input === "string") {
    return [{ type: "message", role: "user", content: [{ type: "input_text", text: input }] }];
  }
  return Array.isArray(input) ? cloneJson(input) : [cloneJson(input)];
}

export function stripInternalResponsesInputFields(inputItems) {
  if (!Array.isArray(inputItems)) return inputItems;
  for (const item of inputItems) {
    if (!item || typeof item !== "object") continue;
    for (const key of Object.keys(item)) {
      if (key.startsWith("internal_")) delete item[key];
    }
  }
  return inputItems;
}

function responsesOutputItems(output) {
  if (!Array.isArray(output)) return [];
  return cloneJson(output.filter((item) => item?.type === "message" || item?.type === "function_call"));
}

function stripEncryptedReasoningValue(value, state) {
  if (Array.isArray(value)) {
    return value.map((item) => stripEncryptedReasoningValue(item, state));
  }

  if (value && typeof value === "object") {
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      if (key === "encrypted_content") {
        state.changed = true;
        continue;
      }
      out[key] = stripEncryptedReasoningValue(child, state);
    }
    return out;
  }

  return value;
}

function isEncryptedReasoningInputItem(item) {
  return item && typeof item === "object"
    && (item.type === "reasoning" || Object.prototype.hasOwnProperty.call(item, "encrypted_content"));
}

export function sanitizeEncryptedReasoningRequest(reqContext) {
  const state = { changed: false };
  let body = cloneJson(reqContext.body);
  if (Array.isArray(body.input)) {
    const input = [];
    for (const item of body.input) {
      if (isEncryptedReasoningInputItem(item)) {
        state.changed = true;
        continue;
      }
      input.push(stripEncryptedReasoningValue(item, state));
    }
    body.input = input;
  } else {
    body = stripEncryptedReasoningValue(body, state);
  }
  if (!state.changed) return null;
  return {
    ...reqContext,
    body,
    inputItems: Array.isArray(body.input) ? body.input : reqContext.inputItems,
  };
}

export function isEncryptedContentVerificationError(statusCode, text) {
  if (statusCode < 400 || !text) return false;
  const lower = String(text).toLowerCase();
  return lower.includes("encrypted content")
    && lower.includes("could not be verified")
    && (lower.includes("could not be decrypted") || lower.includes("could not be parsed"));
}

export async function openCopilotResponse(reqContext, upstream = copilotResponses, options = {}) {
  let resp = await upstream(reqContext.body, { signal: options.signal });
  if (resp.ok) return { resp, reqContext };

  const errorText = await resp.text();
  if (!isEncryptedContentVerificationError(resp.status, errorText)) {
    return { resp, reqContext, errorText };
  }

  const retryContext = sanitizeEncryptedReasoningRequest(reqContext);
  if (!retryContext) return { resp, reqContext, errorText };

  console.warn(status("warn", "encrypted reasoning rejected by upstream; retrying without encrypted reasoning"));
  resp = await upstream(retryContext.body, { signal: options.signal });
  if (resp.ok) return { resp, reqContext: retryContext };
  return { resp, reqContext: retryContext, errorText: await resp.text() };
}

export function clearResponseHistoryForTests() {
  responseHistories.clear();
}

export function prepareResponsesRequest(reqBody) {
  const body = cloneJson(reqBody);
  const currentInputItems = responsesInputItems(body.input);
  const previousId = body.previous_response_id;

  if (previousId !== undefined && previousId !== null) {
    const previousItems = responseHistories.get(previousId);
    if (!previousItems) {
      const err = new Error(`previous_response_id is not available in local adapter history: ${previousId}`);
      err.statusCode = 400;
      throw err;
    }
    body.input = [...cloneJson(previousItems), ...currentInputItems];
  } else {
    body.input = currentInputItems;
  }

  delete body.previous_response_id;
  delete body.store;
  if (Array.isArray(body.tools)) {
    body.tools = body.tools.filter((tool) => tool?.type !== "image_generation");
    if (!body.tools.length) delete body.tools;
  }
  stripInternalResponsesInputFields(body.input);

  return { body, inputItems: body.input };
}

export function rememberResponseHistory(reqContext, responseJson) {
  if (!responseJson?.id || !Array.isArray(reqContext?.inputItems)) return;
  const items = [...cloneJson(reqContext.inputItems), ...responsesOutputItems(responseJson.output)];
  responseHistories.set(responseJson.id, items);
  while (responseHistories.size > RESPONSE_HISTORY_LIMIT) {
    responseHistories.delete(responseHistories.keys().next().value);
  }
}

function storeCompletedResponseFromSse(reqContext, data) {
  if (!data || data === "[DONE]") return;
  try {
    const event = JSON.parse(data);
    const response = event.response;
    if (response?.id && response.status === "completed") {
      rememberResponseHistory(reqContext, response);
      recordResponsesUsage({
        surface: reqContext.surface,
        mode: "stream",
        model: reqContext.body?.model,
        response,
        event,
      });
    }
  } catch {
    // Ignore non-JSON stream fragments.
  }
}

function readSseEvents(buffer, onData) {
  while (true) {
    const match = buffer.match(/\r?\n\r?\n/);
    if (!match) return buffer;
    const chunk = buffer.slice(0, match.index);
    buffer = buffer.slice(match.index + match[0].length);
    const data = chunk
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (data) onData(data);
  }
}

async function proxyCopilotResponses(reqContext, req, res, upstream = copilotResponses, options = {}) {
  const opened = await openCopilotResponse(reqContext, upstream, options);
  const { resp, errorText } = opened;
  reqContext = opened.reqContext;
  if (errorText !== undefined) {
    sendUpstreamError(res, resp, errorText);
    return;
  }

  if (reqContext.body.stream) {
    res.writeHead(resp.status, {
      "Content-Type": resp.headers.get("content-type") || "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        readSseEvents(buffer, (data) => storeCompletedResponseFromSse(reqContext, data));
        res.end();
        return;
      }
      buffer += decoder.decode(value, { stream: true });
      buffer = readSseEvents(buffer, (data) => storeCompletedResponseFromSse(reqContext, data));
      await writeOrDrain(res, value);
    }
  } else {
    const data = await resp.text();
    res.writeHead(resp.status, { "Content-Type": "application/json" });
    res.end(data);
    if (resp.ok) {
      try {
        const response = JSON.parse(data);
        rememberResponseHistory(reqContext, response);
        recordResponsesUsage({
          surface: reqContext.surface,
          mode: "json",
          model: reqContext.body?.model,
          response,
          event: response,
        });
      } catch {}
    }
  }
}

// Chat Completions conversion for older models.

function responsesToChat(body) {
  const messages = [];
  if (body.instructions) messages.push({ role: "system", content: body.instructions });

  if (typeof body.input === "string") {
    messages.push({ role: "user", content: body.input });
  } else if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (item.type === "message") {
        const content =
          typeof item.content === "string"
            ? item.content
            : Array.isArray(item.content)
              ? item.content.map((p) => (p.type === "input_text" || p.type === "text" ? p.text : JSON.stringify(p))).join("")
              : JSON.stringify(item.content);
        messages.push({ role: item.role, content });
      } else if (item.type === "function_call") {
        messages.push({
          role: "assistant",
          content: null,
          tool_calls: [{ id: item.call_id || randomUUID(), type: "function", function: { name: item.name, arguments: item.arguments } }],
        });
      } else if (item.type === "function_call_output") {
        messages.push({ role: "tool", tool_call_id: item.call_id, content: typeof item.output === "string" ? item.output : JSON.stringify(item.output) });
      }
    }
  }

  const chatReq = { model: body.model, messages, stream: true };
  for (const k of ["temperature", "top_p", "stop", "presence_penalty", "frequency_penalty"]) {
    if (body[k] !== undefined) chatReq[k] = body[k];
  }
  const maxTok = body.max_output_tokens ?? body.max_tokens ?? body.max_completion_tokens;
  if (maxTok !== undefined) chatReq.max_completion_tokens = maxTok;

  if (body.tools?.length) {
    chatReq.tools = body.tools
      .map((t) => (t.type === "function" ? t : { type: "function", function: t }))
      .filter((t) => t.function?.name);
    if (!chatReq.tools.length) delete chatReq.tools;
  }
  return chatReq;
}

function uid() { return randomUUID().replace(/-/g, ""); }

function chatToResponses(chatResp, model) {
  const id = `resp_${uid()}`, choice = chatResp.choices?.[0], msg = choice?.message, output = [];
  if (msg?.content) output.push({ type: "message", id: `msg_${uid()}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: msg.content }] });
  if (msg?.tool_calls) for (const tc of msg.tool_calls) output.push({ type: "function_call", id: tc.id, call_id: tc.id, name: tc.function.name, arguments: tc.function.arguments, status: "completed" });
  return { id, object: "response", status: "completed", model: chatResp.model || model, output, usage: chatResp.usage ? { input_tokens: chatResp.usage.prompt_tokens || 0, output_tokens: chatResp.usage.completion_tokens || 0, total_tokens: chatResp.usage.total_tokens || 0 } : undefined };
}

async function forwardToChat(chatReq, emitEvent, onDone, onError, options = {}) {
  delete chatReq.max_tokens;
  let resp;
  try {
    resp = await chatCompletions({ ...chatReq, stream: true }, { signal: options.signal });
  } catch (e) {
    onError(502, e.message);
    return;
  }
  if (!resp.ok) {
    onError(resp.status, await resp.text());
    return;
  }
  const respId = `resp_${uid()}`, itemId = `item_${uid()}`;
  let actualModel = "unknown", fullText = "", toolCalls = {}, hasToolCalls = false;

  await emitEvent("response.created", { response: { id: respId, object: "response", status: "in_progress", model: actualModel, output: [] } });
  await emitEvent("response.output_item.added", { output_index: 0, item: { type: "message", id: itemId, role: "assistant", status: "in_progress", content: [] } });
  await emitEvent("response.content_part.added", { output_index: 0, content_index: 0, part: { type: "output_text", text: "" } });

  const emitCompleted = async () => {
    if (!hasToolCalls) {
      await emitEvent("response.output_text.done", { output_index: 0, content_index: 0, text: fullText });
      await emitEvent("response.output_item.done", { output_index: 0, item: { type: "message", id: itemId, role: "assistant", status: "completed", content: [{ type: "output_text", text: fullText }] } });
    }
    const output = hasToolCalls
      ? Object.entries(toolCalls).map(([id, tc]) => ({ type: "function_call", id, call_id: id, name: tc.name, arguments: tc.arguments, status: "completed" }))
      : [{ type: "message", id: itemId, role: "assistant", status: "completed", content: [{ type: "output_text", text: fullText }] }];
    await emitEvent("response.completed", { response: { id: respId, object: "response", status: "completed", model: actualModel, output, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } });
  };

  try {
    for await (const line of webStreamLines(resp)) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (data === "[DONE]") { await emitCompleted(); onDone(); return; }
      let parsed;
      try { parsed = JSON.parse(data); } catch { continue; }
      if (parsed.model) actualModel = parsed.model;
      const delta = parsed.choices?.[0]?.delta;
      if (!delta) continue;
      if (delta.content) { fullText += delta.content; await emitEvent("response.output_text.delta", { output_index: 0, content_index: 0, delta: delta.content }); }
      if (delta.tool_calls) {
        hasToolCalls = true;
        for (const tc of delta.tool_calls) {
          const id = tc.id || Object.keys(toolCalls)[tc.index] || `call_${tc.index}`;
          if (!toolCalls[id]) { toolCalls[id] = { name: "", arguments: "" }; await emitEvent("response.output_item.added", { output_index: Object.keys(toolCalls).length - 1, item: { type: "function_call", id, call_id: id, name: tc.function?.name || "", arguments: "", status: "in_progress" } }); }
          if (tc.function?.name) toolCalls[id].name += tc.function.name;
          if (tc.function?.arguments) toolCalls[id].arguments += tc.function.arguments;
        }
      }
    }
  } catch (e) {
    onError(500, e?.message || "upstream stream error");
    return;
  }
  await emitCompleted();
  onDone();
}

// Public server entry point.

export function startAdapter(port = 2026, host = "127.0.0.1", options = {}) {
  const claudeDesktopApiKey = options.claudeDesktopApiKey
    || process.env.CCDX_CLAUDE_DESKTOP_API_KEY
    || process.env.CCDX_PROXY_API_KEY
    || "";
  const claudeDesktopModelOptions = Array.isArray(options.claudeDesktopModelDefs)
    ? { modelDefs: options.claudeDesktopModelDefs }
    : {};

  const server = http.createServer((req, res) => {
    const pathname = requestPath(req.url);

    if (req.method === "POST" && pathname === "/v1/responses") {
      (async () => {
        const abort = createRequestAbort(req, res);
        try {
          const parsed = await readJsonBody(req);
          if (!parsed.stream) abort.setTimeout(UPSTREAM_TIMEOUT_MS);
          const prepared = prepareResponsesRequest(parsed);
          prepared.surface = "responses";
          const model = parsed.model || "unknown";
          console.log(status("info", `responses model=${model} stream=${!!parsed.stream}`));
          if (RESPONSES_ONLY.has(model)) {
            await proxyCopilotResponses(prepared, req, res, copilotResponses, { signal: abort.signal });
          } else {
            const chatReq = responsesToChat(prepared.body);
            if (parsed.stream) {
              await forwardToChat(chatReq, async (event, data) => {
                if (!res.headersSent) res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
                await writeOrDrain(res, `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
                if (event === "response.completed") {
                  rememberResponseHistory(prepared, data.response);
                  recordResponsesUsage({ surface: prepared.surface, mode: "stream", model, response: data.response, event: data });
                }
              }, () => { if (!res.writableEnded) res.end(); }, (status, errMsg) => { if (!res.headersSent) res.writeHead(status || 500); res.end(errMsg); }, { signal: abort.signal });
            } else {
              chatReq.stream = false;
              delete chatReq.max_tokens;
              try {
                const upstream = await chatCompletions({ ...chatReq, stream: false }, { signal: abort.signal });
                const data = await upstream.text();
                const resp = chatToResponses(JSON.parse(data), model);
                rememberResponseHistory(prepared, resp);
                recordResponsesUsage({ surface: prepared.surface, mode: "json", model, response: resp, event: resp });
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify(resp));
              } catch (e) {
                logRequestFailure("Responses", e, abort);
                if (!res.destroyed && !res.writableEnded) {
                  if (!res.headersSent) res.writeHead(e?.statusCode || 502);
                  res.end("Bad Gateway");
                }
              }
            }
          }
        } catch (e) {
          logRequestFailure("Responses", e, abort);
          sendJsonError(res, e);
        } finally {
          abort.cleanup();
        }
      })();
      return;
    }

    if (req.method === "POST" && pathname === "/v1/responses/compact") {
      (async () => {
        const abort = createRequestAbort(req, res);
        try {
          const parsed = await readJsonBody(req);
          if (!parsed.stream) abort.setTimeout(UPSTREAM_TIMEOUT_MS);
          const prepared = prepareResponsesRequest(parsed);
          prepared.surface = "responses_compact";
          const model = parsed.model || "unknown";
          console.log(status("info", `responses compact model=${model} stream=${!!parsed.stream}`));
          await proxyCopilotResponses(prepared, req, res, copilotResponsesCompact, { signal: abort.signal });
        } catch (e) {
          logRequestFailure("Responses compact", e, abort);
          sendJsonError(res, e);
        } finally {
          abort.cleanup();
        }
      })();
      return;
    }

    if (req.method === "GET" && pathname === "/v1/models") {
      if (shouldServeClaudeDesktopModels(req, claudeDesktopApiKey)) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(claudeDesktopModelsResponse(process.env, claudeDesktopModelOptions)));
        return;
      }
      const abort = createRequestAbort(req, res);
      abort.setTimeout(UPSTREAM_TIMEOUT_MS);
      listModels({ signal: abort.signal })
        .then(({ status, body }) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(body); })
        .catch((e) => {
          logRequestFailure("Models", e, abort);
          if (!res.destroyed && !res.writableEnded) {
            if (!res.headersSent) res.writeHead(e?.statusCode || 502);
            res.end(JSON.stringify({ error: e.message }));
          }
        })
        .finally(() => abort.cleanup());
      return;
    }

    if (req.method === "POST" && pathname === "/v1/messages/count_tokens") {
      (async () => {
        const abort = createRequestAbort(req, res);
        try {
          const parsed = await readJsonBody(req);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(countTokens(parsed)));
        } catch (e) {
          sendJsonError(res, e);
        } finally {
          abort.cleanup();
        }
      })();
      return;
    }

    if (req.method === "POST" && pathname === "/v1/messages") {
      (async () => {
        const abort = createRequestAbort(req, res);
        try {
          const parsed = await readJsonBody(req);
          if (!parsed.stream) abort.setTimeout(UPSTREAM_TIMEOUT_MS);
          const { requestedModel, upstreamModel } = resolveAnthropicModel(parsed.model || "unknown", process.env, claudeDesktopModelOptions);
          const modelNote = upstreamModel === requestedModel ? requestedModel : `${requestedModel} -> ${upstreamModel}`;
          console.log(status("info", `messages model=${modelNote} stream=${!!parsed.stream}`));
          const chatReq = anthropicToChat(parsed, { upstreamModel });
          const forceRequestedModel = upstreamModel !== requestedModel;
          if (parsed.stream) {
            const upstream = await chatCompletions({ ...chatReq, stream: true }, { signal: abort.signal });
            if (!upstream.ok) {
              if (!res.headersSent) res.writeHead(upstream.status);
              res.end(await upstream.text());
              return;
            }
            res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
            let messageId;
            let usage;
            await streamAnthropicFromLines(
              webStreamLines(upstream),
              async (event, data) => {
                if (event === "message_start") messageId = data.message?.id;
                if (event === "message_delta") usage = data.usage;
                await writeOrDrain(res, `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
              },
              requestedModel,
              { forceModel: forceRequestedModel },
            );
            recordAnthropicUsage({ surface: "messages", mode: "stream", model: requestedModel, responseId: messageId, usage });
            if (!res.writableEnded) res.end();
          } else {
            const upstream = await chatCompletions({ ...chatReq, stream: false }, { signal: abort.signal });
            const data = await upstream.text();
            const anthropicMsg = chatToAnthropic(JSON.parse(data), requestedModel, { forceModel: forceRequestedModel });
            recordAnthropicUsage({ surface: "messages", mode: "json", model: anthropicMsg.model, responseId: anthropicMsg.id, usage: anthropicMsg.usage });
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(anthropicMsg));
          }
        } catch (e) {
          logRequestFailure("Messages", e, abort);
          sendJsonError(res, e);
        } finally {
          abort.cleanup();
        }
      })();
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  server.on("upgrade", (req, socket) => {
    // Codex Desktop 0.130+ negotiates a "responses_websockets" server-push
    // protocol on WS upgrade. We don't implement that protocol; accepting the
    // upgrade and waiting for a client request just hangs and triggers a
    // 5-attempt reconnect storm. Refuse the upgrade so Codex falls back to
    // plain HTTP SSE, which this adapter handles correctly.
    socket.write("HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    socket.destroy();
  });

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const actualPort = server.address()?.port || port;
      console.log(status("ok", `Adapter listening on http://${host}:${actualPort}`));
      resolve(server);
    });
  });
}
