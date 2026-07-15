import http from "node:http";
import { randomUUID } from "node:crypto";
import { chatCompletions, listModels, responses as copilotResponses, responsesCompact as copilotResponsesCompact, getCachedModelEndpoints } from "./copilot.mjs";
import { webStreamLines } from "./stream.mjs";
import { anthropicToChat, chatToAnthropic, streamAnthropicFromLines, countTokens } from "./anthropic.mjs";
import { CODEX_AUTO_REVIEW_MODEL, claudeDesktopModelsResponse, resolveAnthropicModel, resolveOpenAIModel, modelIsResponsesOnly, modelSupportsChatCompletions } from "./models.mjs";
import { isValidModelList } from "./model-cache.mjs";
import { status } from "./status.mjs";
import { recordAnthropicUsage, recordResponsesUsage } from "./usage.mjs";
import { ADAPTER_HEALTH_PATH, adapterHealthPayload } from "./running-adapter.mjs";
import {
  abortErrorStatusCode,
  createRequestAbort,
  httpError,
  isAbortLikeError,
  logRequestFailure,
  readJsonBody,
  sendJsonError,
  sendUpstreamError,
  writeOrDrain,
} from "./http-transport.mjs";
import {
  clearResponseHistoryForTests,
  configureResponseHistoryForTests,
  materializeResponseHistory,
  rememberResponseHistoryNode,
  responseHistoryStats,
} from "./response-history.mjs";

export {
  abortErrorStatusCode,
  createRequestAbort,
  isAbortLikeError,
  readJsonBody,
  writeOrDrain,
} from "./http-transport.mjs";
export {
  clearResponseHistoryForTests,
  configureResponseHistoryForTests,
  responseHistoryStats,
} from "./response-history.mjs";

// Fallback list for models known to only support the Responses API, used when
// live model metadata (supported_endpoints) has not been cached yet.
const RESPONSES_ONLY_FALLBACK = new Set([
  "gpt-5.6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex",
  "gpt-5.2-codex",
]);

// Decide whether a model must be proxied straight to /responses (vs converted to
// /chat/completions). Prefer real endpoint metadata; fall back to the static list.
function isResponsesOnlyModel(model) {
  const endpoints = getCachedModelEndpoints(model);
  if (endpoints) {
    const fakeModel = { supported_endpoints: endpoints };
    if (modelSupportsChatCompletions(fakeModel)) return false;
    if (modelIsResponsesOnly(fakeModel)) return true;
  }
  return RESPONSES_ONLY_FALLBACK.has(model);
}

// Direct Copilot Responses API proxy.

const DEFAULT_UPSTREAM_TIMEOUT_MS = 120 * 1000;
const DEFAULT_STREAM_HANDSHAKE_TIMEOUT_MS = 120 * 1000;
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 120 * 1000;
const DEFAULT_MAX_SSE_BUFFER_BYTES = 8 * 1024 * 1024;

function positiveInt(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const UPSTREAM_TIMEOUT_MS = positiveInt(process.env.CCDX_UPSTREAM_TIMEOUT_MS, DEFAULT_UPSTREAM_TIMEOUT_MS);
const STREAM_HANDSHAKE_TIMEOUT_MS = positiveInt(process.env.CCDX_STREAM_HANDSHAKE_TIMEOUT_MS, DEFAULT_STREAM_HANDSHAKE_TIMEOUT_MS);
const STREAM_IDLE_TIMEOUT_MS = positiveInt(process.env.CCDX_STREAM_IDLE_TIMEOUT_MS, DEFAULT_STREAM_IDLE_TIMEOUT_MS);
const MAX_SSE_BUFFER_BYTES = positiveInt(process.env.CCDX_MAX_SSE_BUFFER_BYTES, DEFAULT_MAX_SSE_BUFFER_BYTES);

export function requestPath(reqUrl) {
  return new URL(reqUrl || "/", "http://localhost").pathname;
}

function cloneJson(value) {
  return value === undefined ? undefined : structuredClone(value);
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

function modelListCanUseLastKnownGood(statusCode) {
  return [408, 425, 429].includes(statusCode) || statusCode >= 500;
}

function sendLastKnownGoodModels(res, modelRegistry) {
  if (!isValidModelList(modelRegistry?.models) || res.destroyed || res.writableEnded) return false;
  res.writeHead(200, {
    "Content-Type": "application/json",
    "X-CCDX-Model-Source": "last-known-good",
  });
  res.end(JSON.stringify(modelRegistry.models));
  return true;
}

function responsesInputItems(input, { clone = true } = {}) {
  if (input === undefined || input === null) return [];
  if (typeof input === "string") {
    return [{ type: "message", role: "user", content: [{ type: "input_text", text: input }] }];
  }
  if (Array.isArray(input)) return clone ? cloneJson(input) : input;
  return [clone ? cloneJson(input) : input];
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
  return output.filter((item) => item?.type === "message" || item?.type === "function_call");
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
  const historyInputItems = Array.isArray(reqContext.historyInputItems)
    ? reqContext.historyInputItems
      .filter((item) => !isEncryptedReasoningInputItem(item))
      .map((item) => stripEncryptedReasoningValue(item, { changed: false }))
    : reqContext.historyInputItems;
  return {
    ...reqContext,
    body,
    inputItems: Array.isArray(body.input) ? body.input : reqContext.inputItems,
    historyInputItems,
  };
}

export function isEncryptedContentVerificationError(statusCode, text) {
  if (statusCode < 400 || !text) return false;
  const lower = String(text).toLowerCase();
  return lower.includes("encrypted content")
    && lower.includes("could not be verified")
    && (lower.includes("could not be decrypted") || lower.includes("could not be parsed"));
}

export function isImageNamespaceCollisionError(statusCode, text) {
  if (statusCode < 400 || !text) return false;
  const lower = String(text).toLowerCase();
  return lower.includes("namespace")
    && lower.includes("image_gen")
    && lower.includes("collid");
}

function isImageNamespaceTool(tool, { collisionFallback = false } = {}) {
  if (!tool || typeof tool !== "object") return false;
  const type = String(tool.type || "").toLowerCase();
  const name = String(tool.name || tool.function?.name || "").toLowerCase();
  const namespace = String(tool.namespace || "").toLowerCase();
  if (["image_gen", "image_generation"].includes(type)) return true;
  if (["image_gen", "image_generation"].includes(name)) return true;
  if (namespace === "image_gen" || namespace === "image_generation") return true;
  return collisionFallback && [type, name, namespace].some((value) => value.startsWith("image_gen"));
}

export function sanitizeImageNamespaceCollisionRequest(reqContext) {
  if (!Array.isArray(reqContext?.body?.tools)) return null;
  const body = cloneJson(reqContext.body);
  const filtered = body.tools.filter((tool) => !isImageNamespaceTool(tool, { collisionFallback: true }));
  if (filtered.length === body.tools.length) return null;
  if (filtered.length) body.tools = filtered;
  else delete body.tools;
  return { ...reqContext, body };
}

export async function openCopilotResponse(reqContext, upstream = copilotResponses, options = {}) {
  let encryptedRetried = false;
  let imageNamespaceRetried = false;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const resp = await upstream(reqContext.body, { signal: options.signal });
    if (resp.ok) return { resp, reqContext };

    const errorText = await resp.text();
    if (!imageNamespaceRetried && isImageNamespaceCollisionError(resp.status, errorText)) {
      const retryContext = sanitizeImageNamespaceCollisionRequest(reqContext);
      if (retryContext) {
        imageNamespaceRetried = true;
        reqContext = retryContext;
        console.warn(status("warn", "image_gen namespace rejected by upstream; retrying without the conflicting image tool"));
        continue;
      }
    }
    if (!encryptedRetried && isEncryptedContentVerificationError(resp.status, errorText)) {
      const retryContext = sanitizeEncryptedReasoningRequest(reqContext);
      if (retryContext) {
        encryptedRetried = true;
        reqContext = retryContext;
        console.warn(status("warn", "encrypted reasoning rejected by upstream; retrying without encrypted reasoning"));
        continue;
      }
    }
    return { resp, reqContext, errorText };
  }
  throw httpError("Responses compatibility retry limit exceeded", 502);
}

// The GPT (gpt-5.6) Responses backend registers a built-in `image_gen` tool
// namespace. When the client also sends an image generation tool, the upstream
// rejects the request with "User-defined namespace 'image_gen' collides ...".
// Strip exact built-in image tools before proxying. Broader namespace variants
// are removed only after the upstream explicitly reports a collision.
function isBuiltinImageTool(tool) {
  return isImageNamespaceTool(tool);
}

export function prepareResponsesRequest(reqBody, { mutate = false } = {}) {
  const body = mutate ? reqBody : cloneJson(reqBody);
  const currentInputItems = responsesInputItems(body.input, { clone: !mutate });
  const previousId = body.previous_response_id;

  if (previousId !== undefined && previousId !== null) {
    body.input = [...materializeResponseHistory(previousId), ...currentInputItems];
  } else {
    body.input = currentInputItems;
  }

  delete body.previous_response_id;
  delete body.store;
  if (Array.isArray(body.tools)) {
    body.tools = body.tools.filter((tool) => !isBuiltinImageTool(tool));
    if (!body.tools.length) delete body.tools;
  }
  stripInternalResponsesInputFields(body.input);
  stripInternalResponsesInputFields(currentInputItems);

  return {
    body,
    inputItems: body.input,
    historyParentId: previousId ?? null,
    historyInputItems: currentInputItems,
    takeHistoryOwnership: mutate,
  };
}

export function rememberResponseHistory(reqContext, responseJson) {
  if (!responseJson?.id || !Array.isArray(reqContext?.historyInputItems || reqContext?.inputItems)) return;
  const sourceInputItems = reqContext.historyInputItems || reqContext.inputItems;
  const sourceOutputItems = responsesOutputItems(responseJson.output);
  rememberResponseHistoryNode({
    id: responseJson.id,
    parentId: reqContext.historyParentId,
    inputItems: sourceInputItems,
    outputItems: sourceOutputItems,
    takeOwnership: reqContext.takeHistoryOwnership,
  });
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
    if (Buffer.byteLength(chunk) > MAX_SSE_BUFFER_BYTES) {
      throw httpError(`Upstream SSE buffer exceeds ${MAX_SSE_BUFFER_BYTES} bytes`, 502);
    }
    buffer = buffer.slice(match.index + match[0].length);
    const data = chunk
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (data) onData(data);
  }
}

function streamErrorData(protocol, error, abort) {
  const code = abort?.reason || "upstream_stream_error";
  const message = `${code}: ${error?.message || "Upstream stream failed"}`;
  if (protocol === "anthropic") {
    return { type: "error", error: { type: "api_error", message } };
  }
  return { type: "error", code, message, param: null };
}

async function endStreamWithError(res, protocol, error, abort) {
  if (res.destroyed || res.writableEnded) return;
  const data = streamErrorData(protocol, error, abort);
  await writeOrDrain(res, `event: error\ndata: ${JSON.stringify(data)}\n\n`).catch(() => false);
  if (!res.destroyed && !res.writableEnded) res.end();
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
    options.abort?.setTimeout(options.streamIdleTimeoutMs, "stream_idle_timeout");
    res.writeHead(resp.status, {
      "Content-Type": resp.headers.get("content-type") || "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          buffer += decoder.decode();
          if (Buffer.byteLength(buffer) > MAX_SSE_BUFFER_BYTES) {
            throw httpError(`Upstream SSE buffer exceeds ${MAX_SSE_BUFFER_BYTES} bytes`, 502);
          }
          readSseEvents(buffer, (data) => storeCompletedResponseFromSse(reqContext, data));
          res.end();
          return;
        }
        options.abort?.setTimeout(options.streamIdleTimeoutMs, "stream_idle_timeout");
        buffer += decoder.decode(value, { stream: true });
        buffer = readSseEvents(buffer, (data) => storeCompletedResponseFromSse(reqContext, data));
        if (Buffer.byteLength(buffer) > MAX_SSE_BUFFER_BYTES) {
          throw httpError(`Upstream SSE buffer exceeds ${MAX_SSE_BUFFER_BYTES} bytes`, 502);
        }
        if (!await writeOrDrain(res, value)) return;
      }
    } catch (e) {
      logRequestFailure("Responses", e, options.abort);
      await endStreamWithError(res, "responses", e, options.abort);
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
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

export function responsesToChat(body) {
  const messages = [];
  if (body.instructions) messages.push({ role: "system", content: body.instructions });

  const messageContent = (content) => {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return JSON.stringify(content);
    const parts = [];
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      if (["input_text", "output_text", "text"].includes(part.type)) {
        parts.push({ type: "text", text: String(part.text || "") });
      } else if (part.type === "input_image" || part.type === "image_url") {
        const raw = part.image_url ?? part.url;
        const imageUrl = typeof raw === "string"
          ? { url: raw }
          : raw && typeof raw === "object" ? cloneJson(raw) : null;
        if (imageUrl && part.detail !== undefined && imageUrl.detail === undefined) imageUrl.detail = part.detail;
        if (imageUrl?.url) parts.push({ type: "image_url", image_url: imageUrl });
      } else {
        parts.push({ type: "text", text: JSON.stringify(part) });
      }
    }
    if (parts.length === 1 && parts[0].type === "text") return parts[0].text;
    return parts;
  };

  if (typeof body.input === "string") {
    messages.push({ role: "user", content: body.input });
  } else if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (item.type === "message") {
        messages.push({ role: item.role, content: messageContent(item.content) });
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
      .map((tool) => {
        if (tool?.type !== "function") return null;
        if (tool.function?.name) return cloneJson(tool);
        const fn = {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          strict: tool.strict,
        };
        for (const key of Object.keys(fn)) if (fn[key] === undefined) delete fn[key];
        return { type: "function", function: fn };
      })
      .filter(Boolean)
      .filter((t) => t.function?.name);
    if (!chatReq.tools.length) delete chatReq.tools;
  }
  if (body.tool_choice !== undefined) {
    if (typeof body.tool_choice === "string") {
      chatReq.tool_choice = body.tool_choice;
    } else if (body.tool_choice?.type === "function" && body.tool_choice.name) {
      chatReq.tool_choice = { type: "function", function: { name: body.tool_choice.name } };
    }
  }
  if (body.parallel_tool_calls !== undefined) chatReq.parallel_tool_calls = body.parallel_tool_calls;
  const textFormat = body.text?.format;
  if (textFormat?.type === "json_schema") {
    chatReq.response_format = {
      type: "json_schema",
      json_schema: Object.fromEntries(Object.entries({
        name: textFormat.name,
        description: textFormat.description,
        schema: textFormat.schema,
        strict: textFormat.strict,
      }).filter(([, value]) => value !== undefined)),
    };
  } else if (textFormat?.type === "json_object") {
    chatReq.response_format = { type: "json_object" };
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

export async function forwardToChat(chatReq, emitEvent, onDone, onError, options = {}) {
  delete chatReq.max_tokens;
  let resp;
  try {
    const chatCompletionsFn = options.chatCompletionsFn || chatCompletions;
    resp = await chatCompletionsFn({
      ...chatReq,
      stream: true,
    }, { signal: options.signal });
  } catch (e) {
    const statusCode = isAbortLikeError(e) ? abortErrorStatusCode(options.abort?.reason) : 502;
    await onError(statusCode, e.message);
    return;
  }
  if (!resp.ok) {
    await onError(resp.status, await resp.text());
    return;
  }
  options.abort?.setTimeout(options.streamIdleTimeoutMs, "stream_idle_timeout");
  const respId = `resp_${uid()}`;
  let actualModel = chatReq.model || "unknown";
  let fullText = "";
  let messageItem = null;
  let nextOutputIndex = 0;
  let usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  const toolCalls = new Map();

  await emitEvent("response.created", { response: { id: respId, object: "response", status: "in_progress", model: actualModel, output: [] } });

  const ensureMessageItem = async () => {
    if (messageItem) return messageItem;
    messageItem = { id: `msg_${uid()}`, outputIndex: nextOutputIndex++ };
    await emitEvent("response.output_item.added", {
      output_index: messageItem.outputIndex,
      item: { type: "message", id: messageItem.id, role: "assistant", status: "in_progress", content: [] },
    });
    await emitEvent("response.content_part.added", {
      output_index: messageItem.outputIndex,
      content_index: 0,
      part: { type: "output_text", text: "" },
    });
    return messageItem;
  };

  const ensureToolCall = async (chunk) => {
    const key = Number.isInteger(chunk.index) ? `index:${chunk.index}` : `id:${chunk.id || toolCalls.size}`;
    if (toolCalls.has(key)) return { tool: toolCalls.get(key), created: false };
    const id = chunk.id || `call_${uid()}`;
    const tool = {
      id,
      callId: id,
      name: chunk.function?.name || "",
      arguments: "",
      outputIndex: nextOutputIndex++,
    };
    toolCalls.set(key, tool);
    await emitEvent("response.output_item.added", {
      output_index: tool.outputIndex,
      item: {
        type: "function_call",
        id: tool.id,
        call_id: tool.callId,
        name: tool.name,
        arguments: "",
        status: "in_progress",
      },
    });
    return { tool, created: true };
  };

  const emitCompleted = async () => {
    if (!messageItem && toolCalls.size === 0) await ensureMessageItem();
    const output = [];
    if (messageItem) {
      const item = {
        type: "message",
        id: messageItem.id,
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: fullText }],
      };
      await emitEvent("response.output_text.done", { output_index: messageItem.outputIndex, content_index: 0, text: fullText });
      await emitEvent("response.content_part.done", { output_index: messageItem.outputIndex, content_index: 0, part: item.content[0] });
      await emitEvent("response.output_item.done", { output_index: messageItem.outputIndex, item });
      output[messageItem.outputIndex] = item;
    }
    for (const tool of toolCalls.values()) {
      const item = {
        type: "function_call",
        id: tool.id,
        call_id: tool.callId,
        name: tool.name,
        arguments: tool.arguments,
        status: "completed",
      };
      await emitEvent("response.function_call_arguments.done", {
        output_index: tool.outputIndex,
        item_id: tool.id,
        arguments: tool.arguments,
      });
      await emitEvent("response.output_item.done", { output_index: tool.outputIndex, item });
      output[tool.outputIndex] = item;
    }
    await emitEvent("response.completed", {
      response: {
        id: respId,
        object: "response",
        status: "completed",
        model: actualModel,
        output: output.filter(Boolean),
        usage,
      },
    });
  };

  try {
    for await (const line of webStreamLines(resp, {
      onChunk: () => options.abort?.setTimeout(options.streamIdleTimeoutMs, "stream_idle_timeout"),
    })) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (data === "[DONE]") { await emitCompleted(); onDone(); return; }
      let parsed;
      try { parsed = JSON.parse(data); } catch { continue; }
      if (parsed.model) actualModel = parsed.model;
      if (parsed.usage) {
        usage = {
          input_tokens: parsed.usage.prompt_tokens || 0,
          output_tokens: parsed.usage.completion_tokens || 0,
          total_tokens: parsed.usage.total_tokens || 0,
        };
        const cached = parsed.usage.prompt_tokens_details?.cached_tokens;
        if (cached) usage.input_tokens_details = { cached_tokens: cached };
      }
      const delta = parsed.choices?.[0]?.delta;
      if (!delta) continue;
      if (delta.content) {
        const message = await ensureMessageItem();
        fullText += delta.content;
        await emitEvent("response.output_text.delta", { output_index: message.outputIndex, content_index: 0, delta: delta.content });
      }
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const { tool, created } = await ensureToolCall(tc);
          if (tc.id) tool.callId = tc.id;
          if (!created && tc.function?.name) tool.name += tc.function.name;
          if (tc.function?.arguments) {
            tool.arguments += tc.function.arguments;
            await emitEvent("response.function_call_arguments.delta", {
              output_index: tool.outputIndex,
              item_id: tool.id,
              delta: tc.function.arguments,
            });
          }
        }
      }
    }
  } catch (e) {
    const statusCode = isAbortLikeError(e) ? abortErrorStatusCode(options.abort?.reason) : 502;
    await onError(statusCode, e?.message || "upstream stream error");
    return;
  }
  await emitCompleted();
  onDone();
}

// Shared request handler. Keeping this separate from the listener makes the
// complete HTTP routing layer testable without opening a local port.
export function createAdapterHandler(options = {}) {
  const claudeDesktopApiKey = options.claudeDesktopApiKey
    || process.env.CCDX_CLAUDE_DESKTOP_API_KEY
    || process.env.CCDX_PROXY_API_KEY
    || "";
  const chatCompletionsFn = options.chatCompletionsFn || chatCompletions;
  const responsesFn = options.responsesFn || copilotResponses;
  const responsesCompactFn = options.responsesCompactFn || copilotResponsesCompact;
  const listModelsFn = options.listModelsFn || listModels;
  const openAIModelEnv = options.openAIModelEnv || process.env;
  const upstreamTimeoutMs = positiveInt(options.upstreamTimeoutMs, UPSTREAM_TIMEOUT_MS);
  const streamHandshakeTimeoutMs = positiveInt(options.streamHandshakeTimeoutMs, STREAM_HANDSHAKE_TIMEOUT_MS);
  const streamIdleTimeoutMs = positiveInt(options.streamIdleTimeoutMs, STREAM_IDLE_TIMEOUT_MS);
  const claudeDesktopModelOptions = () => {
    const modelDefs = options.modelRegistry?.modelDefs || options.claudeDesktopModelDefs;
    return Array.isArray(modelDefs) ? { modelDefs } : {};
  };

  return (req, res) => {
    const pathname = requestPath(req.url);

    if (req.method === "GET" && pathname === ADAPTER_HEALTH_PATH) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(adapterHealthPayload()));
      return;
    }

    if (req.method === "POST" && pathname === "/v1/responses") {
      return (async () => {
        const abort = createRequestAbort(req, res);
        try {
          const parsed = await readJsonBody(req);
          abort.setTimeout(
            parsed.stream ? streamHandshakeTimeoutMs : upstreamTimeoutMs,
              parsed.stream ? "stream_handshake_timeout" : "upstream_timeout",
          );
          const prepared = prepareResponsesRequest(parsed, { mutate: true });
          prepared.surface = "responses";
          const model = parsed.model || "unknown";
          const { requestedModel, upstreamModel } = resolveOpenAIModel(model, openAIModelEnv);
          if (upstreamModel !== requestedModel) prepared.body.model = upstreamModel;
          const upstreamLog = upstreamModel === requestedModel ? "" : ` upstream_model=${upstreamModel}`;
          console.log(status("info", `responses model=${requestedModel}${upstreamLog} stream=${!!parsed.stream}`));
          if (requestedModel === CODEX_AUTO_REVIEW_MODEL || isResponsesOnlyModel(upstreamModel)) {
            await proxyCopilotResponses(prepared, req, res, responsesFn, {
              signal: abort.signal,
              abort,
              streamIdleTimeoutMs,
            });
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
              }, () => { if (!res.writableEnded) res.end(); }, async (statusCode, errMsg) => {
                if (!res.headersSent) {
                  res.writeHead(statusCode || 500, { "Content-Type": "text/plain; charset=utf-8" });
                  res.end(errMsg);
                  return;
                }
                await endStreamWithError(res, "responses", new Error(errMsg), abort);
              }, {
                signal: abort.signal,
                abort,
                streamIdleTimeoutMs,
                chatCompletionsFn,
              });
            } else {
              chatReq.stream = false;
              delete chatReq.max_tokens;
              try {
                const upstream = await chatCompletionsFn({ ...chatReq, stream: false }, { signal: abort.signal });
                const data = await upstream.text();
                if (!upstream.ok) {
                  sendUpstreamError(res, upstream, data);
                  return;
                }
                const resp = chatToResponses(JSON.parse(data), model);
                rememberResponseHistory(prepared, resp);
                recordResponsesUsage({ surface: prepared.surface, mode: "json", model, response: resp, event: resp });
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify(resp));
              } catch (e) {
                logRequestFailure("Responses", e, abort);
                sendJsonError(res, e, 502);
              }
            }
          }
        } catch (e) {
          logRequestFailure("Responses", e, abort);
          sendJsonError(res, e, 502);
        } finally {
          abort.cleanup();
        }
      })();
    }

    if (req.method === "POST" && pathname === "/v1/responses/compact") {
      (async () => {
        const abort = createRequestAbort(req, res);
        try {
          const parsed = await readJsonBody(req);
          abort.setTimeout(
            parsed.stream ? streamHandshakeTimeoutMs : upstreamTimeoutMs,
            parsed.stream ? "stream_handshake_timeout" : "upstream_timeout",
          );
          const prepared = prepareResponsesRequest(parsed, { mutate: true });
          prepared.surface = "responses_compact";
          const model = parsed.model || "unknown";
          const { requestedModel, upstreamModel } = resolveOpenAIModel(model, openAIModelEnv);
          if (upstreamModel !== requestedModel) prepared.body.model = upstreamModel;
          const upstreamLog = upstreamModel === requestedModel ? "" : ` upstream_model=${upstreamModel}`;
          console.log(status("info", `responses compact model=${requestedModel}${upstreamLog} stream=${!!parsed.stream}`));
          await proxyCopilotResponses(prepared, req, res, responsesCompactFn, {
            signal: abort.signal,
            abort,
            streamIdleTimeoutMs,
          });
        } catch (e) {
          logRequestFailure("Responses compact", e, abort);
          sendJsonError(res, e, 502);
        } finally {
          abort.cleanup();
        }
      })();
      return;
    }

    if (req.method === "GET" && pathname === "/v1/models") {
      if (shouldServeClaudeDesktopModels(req, claudeDesktopApiKey)) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(claudeDesktopModelsResponse(process.env, claudeDesktopModelOptions())));
        return;
      }
      const abort = createRequestAbort(req, res);
      abort.setTimeout(upstreamTimeoutMs);
      listModelsFn({ signal: abort.signal })
        .then(({ status, body }) => {
          if (status >= 200 && status < 300) {
            let models;
            try { models = JSON.parse(body); } catch {}
            if (isValidModelList(models)) {
              if (options.modelRegistry) {
                options.modelRegistry.models = models;
              }
              res.writeHead(status, { "Content-Type": "application/json" });
              res.end(body);
              return;
            }
            if (sendLastKnownGoodModels(res, options.modelRegistry)) return;
            sendJsonError(res, httpError("Copilot models response contained no valid models", 502), 502);
            return;
          }
          if (modelListCanUseLastKnownGood(status) && sendLastKnownGoodModels(res, options.modelRegistry)) return;
          res.writeHead(status, { "Content-Type": "application/json" });
          res.end(body);
        })
        .catch((e) => {
          logRequestFailure("Models", e, abort);
          if (sendLastKnownGoodModels(res, options.modelRegistry)) return;
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
          res.end(JSON.stringify(await countTokens(parsed)));
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
          abort.setTimeout(
            parsed.stream ? streamHandshakeTimeoutMs : upstreamTimeoutMs,
            parsed.stream ? "stream_handshake_timeout" : "upstream_timeout",
          );
          const { requestedModel, upstreamModel } = resolveAnthropicModel(parsed.model || "unknown", process.env, claudeDesktopModelOptions());
          const modelNote = upstreamModel === requestedModel ? requestedModel : `${requestedModel} -> ${upstreamModel}`;
          console.log(status("info", `messages model=${modelNote} stream=${!!parsed.stream}`));
          const chatReq = anthropicToChat(parsed, { upstreamModel });
          const forceRequestedModel = upstreamModel !== requestedModel;
          if (parsed.stream) {
            const upstream = await chatCompletionsFn({ ...chatReq, stream: true }, { signal: abort.signal });
            if (!upstream.ok) {
              if (!res.headersSent) res.writeHead(upstream.status);
              res.end(await upstream.text());
              return;
            }
            abort.setTimeout(streamIdleTimeoutMs, "stream_idle_timeout");
            res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
            let messageId;
            let usage;
            try {
              await streamAnthropicFromLines(
                webStreamLines(upstream, {
                  onChunk: () => abort.setTimeout(streamIdleTimeoutMs, "stream_idle_timeout"),
                }),
                async (event, data) => {
                  if (event === "message_start") messageId = data.message?.id;
                  if (event === "message_delta") usage = data.usage;
                  await writeOrDrain(res, `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
                },
                requestedModel,
                { forceModel: forceRequestedModel },
              );
            } catch (e) {
              logRequestFailure("Messages", e, abort);
              await endStreamWithError(res, "anthropic", e, abort);
              return;
            }
            recordAnthropicUsage({ surface: "messages", mode: "stream", model: requestedModel, responseId: messageId, usage });
            if (!res.writableEnded) res.end();
          } else {
            const upstream = await chatCompletionsFn({ ...chatReq, stream: false }, { signal: abort.signal });
            const data = await upstream.text();
            if (!upstream.ok) {
              sendUpstreamError(res, upstream, data);
              return;
            }
            const anthropicMsg = chatToAnthropic(JSON.parse(data), requestedModel, { forceModel: forceRequestedModel });
            recordAnthropicUsage({ surface: "messages", mode: "json", model: anthropicMsg.model, responseId: anthropicMsg.id, usage: anthropicMsg.usage });
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(anthropicMsg));
          }
        } catch (e) {
          logRequestFailure("Messages", e, abort);
          sendJsonError(res, e, 502);
        } finally {
          abort.cleanup();
        }
      })();
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  };
}

// Public server entry point.

export function startAdapter(port = 2026, host = "127.0.0.1", options = {}) {
  const server = http.createServer(createAdapterHandler(options));

  server.on("upgrade", (req, socket) => {
    // Codex Desktop 0.130+ negotiates a "responses_websockets" server-push
    // protocol on WS upgrade. We don't implement that protocol; accepting the
    // upgrade and waiting for a client request just hangs and triggers a
    // 5-attempt reconnect storm. Refuse the upgrade so Codex falls back to
    // plain HTTP SSE, which this adapter handles correctly.
    socket.write("HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    socket.destroy();
  });

  return new Promise((resolve, reject) => {
    const onListenError = (e) => {
      if (e?.code === "EADDRINUSE") {
        reject(new Error(`Adapter address http://${host}:${port} is already in use. Stop the existing codex-copilot-dx process or set ADAPTER_PORT to another port.`));
        return;
      }
      reject(e);
    };

    server.once("error", onListenError);
    server.listen(port, host, () => {
      server.off("error", onListenError);
      const actualPort = server.address()?.port || port;
      console.log(status("ok", `Adapter listening on http://${host}:${actualPort}`));
      resolve(server);
    });
  });
}
