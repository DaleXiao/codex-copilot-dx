import { createHash } from "node:crypto";
import { webStreamLines } from "./stream.mjs";
import { MAX_UPSTREAM_CHAT_SUCCESS_BODY_BYTES } from "./http-transport.mjs";
import { ToolArgumentDeltaGuard, upstreamChatStreamError } from "./stream-contract.mjs";
import { observeSourceStreamFailure } from "./source-admission.mjs";
import { sourceResponseAccepted } from "./source-response.mjs";
import { chatOutputParts } from "./chat-output-parts.mjs";
import { MAX_OPAQUE_LENGTH } from "./antigravity-opaque-reasoning.mjs";

const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const names = /^[A-Za-z0-9_-]{1,64}$/;
const types = new Set(["OBJECT", "ARRAY", "STRING", "NUMBER", "INTEGER", "BOOLEAN", "NULL"]);
const schemaChildren = new Set(["items", "additionalProperties", "not", "if", "then", "else", "contains", "propertyNames"]);
const schemaMaps = new Set(["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]);
const schemaLists = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
const chatPartFields = new Set(["text", "thought", "inlineData", "inline_data", "functionCall", "functionResponse"]);

function invalid(message, statusCode = 400, code = "ccdx_antigravity_protocol") {
  return Object.assign(new Error(message), { code, statusCode });
}

function unsupportedPart(part, messageIndex, partIndex) {
  const location = "Message " + (messageIndex + 1) + ", part " + (partIndex + 1) + ". ";
  if (object(part)) {
    if (part.thoughtSignature || part.thought_signature)
      return invalid(location + "The Copilot Chat route cannot use a Gemini thought signature. Continue with the original Gemini model or start a new Copilot conversation.", 400, "ccdx_antigravity_thought_signature");
    if (Object.hasOwn(part, "fileData") || Object.hasOwn(part, "file_data"))
      return invalid(location + "The Copilot Chat route cannot use a Gemini file reference.", 400, "ccdx_antigravity_file_reference");
    if (Object.hasOwn(part, "partMetadata") || Object.hasOwn(part, "part_metadata"))
      return invalid(location + "The Copilot Chat route cannot represent Gemini part metadata.", 400, "ccdx_antigravity_part_metadata");
  }
  return invalid(location + "Unsupported Gemini message part.", 400, "ccdx_antigravity_message_part");
}

// Preserve the spelling of numbers which JavaScript cannot round-trip.
export function parseAntigravityJSON(text) {
  return JSON.parse(text, (_key, value, context) => typeof value === "number" && String(value) !== context.source
    ? JSON.rawJSON(context.source) : value);
}

function schemaForChat(schema) {
  if (!object(schema)) throw invalid("Invalid Gemini function schema");
  const result = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "type" && typeof value === "string" && types.has(value)) result[key] = value.toLowerCase();
    else if (schemaChildren.has(key) && object(value)) result[key] = schemaForChat(value);
    else if (schemaMaps.has(key) && object(value)) result[key] = Object.fromEntries(Object.entries(value).map(([name, child]) => [name, schemaForChat(child)]));
    else if (schemaLists.has(key) && Array.isArray(value)) result[key] = value.map(schemaForChat);
    else result[key] = value;
  }
  if (result.type === "object" && !Object.hasOwn(result, "properties")) result.properties = {};
  return result;
}

function modelToolName(name) {
  if (typeof name !== "string" || !name) throw invalid("Gemini function name is missing");
  return names.test(name) ? name : "ccdx_" + createHash("sha256").update(name).digest("hex").slice(0, 40);
}

function imagePart(part) {
  const inline = part.inlineData || part.inline_data;
  if (!object(inline) || typeof (inline.mimeType || inline.mime_type) !== "string" || typeof inline.data !== "string")
    throw invalid("Invalid inline image");
  const mime = inline.mimeType || inline.mime_type;
  if (!/^image\/[a-z0-9.+-]+$/i.test(mime)) throw invalid("This attachment is not supported by the Copilot Chat route");
  return { type: "image_url", image_url: { url: `data:${mime};base64,${inline.data}` } };
}

function contentValue(parts) {
  if (!parts.length) return null;
  return parts.length === 1 && parts[0].type === "text" ? parts[0].text : parts;
}

export function antigravityToChat(request, { model, effort, stream = true, reasoningEfforts = ["none","minimal","low","medium","high","xhigh","max"], acceptSignedToolTurn } = {}) {
  if (!object(request) || !Array.isArray(request.contents) || typeof model !== "string" || !model)
    throw invalid("Invalid Gemini generation request");
  if (Object.keys(request).some(key => !["contents", "systemInstruction", "tools", "toolConfig", "generationConfig", "labels", "sessionId"].includes(key))
    || request.tools !== undefined && !Array.isArray(request.tools)) throw invalid("Unsupported Gemini request field");
  const originalNames = new Map(), tools = [];
  for (const group of request.tools || []) {
    if (!object(group) || !Array.isArray(group.functionDeclarations) || Object.keys(group).some(key => key !== "functionDeclarations"))
      throw invalid("This Gemini tool cannot be represented by Chat Completions");
    for (const definition of group.functionDeclarations) {
      if (!object(definition)) throw invalid("Invalid Gemini function definition");
      const alias = modelToolName(definition.name), previous = originalNames.get(alias);
      if (previous && previous !== definition.name) throw invalid("Gemini function names collide");
      if (previous) throw invalid("Duplicate Gemini function definition");
      originalNames.set(alias, definition.name);
      const parameters = definition.parametersJsonSchema || definition.parameters || { type: "object", properties: {} };
      tools.push({ type: "function", function: { name: alias,
        ...(typeof definition.description === "string" ? { description: definition.description } : {}), parameters: schemaForChat(parameters) } });
    }
  }
  const config = request.toolConfig?.functionCallingConfig;
  if (request.toolConfig && (!object(config) || Object.keys(request.toolConfig).some(key => key !== "functionCallingConfig")))
    throw invalid("Unsupported Gemini tool configuration");
  if (config?.allowedFunctionNames !== undefined) {
    if (!Array.isArray(config.allowedFunctionNames) || config.allowedFunctionNames.some(name => typeof name !== "string"))
      throw invalid("Invalid allowed function list");
    const allowed = new Set(config.allowedFunctionNames.map(modelToolName));
    if ([...allowed].some(name => !originalNames.has(name))) throw invalid("Allowed function is not declared");
    for (let i = tools.length - 1; i >= 0; i--) if (!allowed.has(tools[i].function.name)) tools.splice(i, 1);
  }
  const mode = config?.mode || "AUTO", choices = { AUTO: "auto", ANY: "required", NONE: "none" };
  if (!Object.hasOwn(choices, mode)) throw invalid("Unsupported Gemini function calling mode");
  if (mode === "ANY" && !tools.length) throw invalid("Required Gemini functions are unavailable");
  const messages = [], pending = new Map(), queues = new Map();
  if (request.systemInstruction) {
    const parts = request.systemInstruction.parts;
    if (!Array.isArray(parts) || parts.some(part => !object(part) || typeof part.text !== "string" || Object.keys(part).some(key => key !== "text")))
      throw invalid("Unsupported Gemini system instruction");
    messages.push({ role: "system", content: parts.map(part => part.text).join("") });
  }
  for (let i = 0; i < request.contents.length; i++) {
    const item = request.contents[i], role = item?.role === "model" ? "assistant" : item?.role === "user" ? "user" : null;
    if (!role || !Array.isArray(item.parts)) throw invalid("Invalid Gemini message");
    let content = [], calls = [], reasoning = "", trustedToolTurn;
    const flush = () => {
      if (!content.length && !calls.length && !reasoning) return;
      messages.push({ role, content: contentValue(content), ...(reasoning ? { reasoning_content: reasoning } : {}), ...(calls.length ? { tool_calls: calls } : {}) });
      content = [];calls = [];reasoning = "";
    };
    for (let j = 0; j < item.parts.length; j++) {
      const part = item.parts[j];
      if (!object(part)) throw unsupportedPart(part, i, j);
      const signatureField = part.thoughtSignature !== undefined ? "thoughtSignature"
        : part.thought_signature !== undefined ? "thought_signature" : null;
      if (signatureField) {
        if (role !== "assistant" || !part.functionCall || typeof part[signatureField] !== "string" || !part[signatureField]
          || part[signatureField].length > MAX_OPAQUE_LENGTH
          || !(trustedToolTurn ??= acceptSignedToolTurn?.(item.parts) === true)) throw unsupportedPart(part, i, j);
      }
      const textPart = typeof part.text === "string", inline = part.inlineData || part.inline_data;
      const count = Number(textPart) + Number(Boolean(inline)) + Number(Boolean(part.functionCall)) + Number(Boolean(part.functionResponse));
      if (count !== 1 || Object.keys(part).some(key => !chatPartFields.has(key) && key !== signatureField))
        throw unsupportedPart(part, i, j);
      if (textPart) {
        if (part.thought) { if (role !== "assistant") throw invalid("Invalid Gemini thought");reasoning += part.text; }
        else content.push({ type: "text", text: part.text });
      } else if (inline) content.push(imagePart(part));
      else if (part.functionCall) {
        if (role !== "assistant" || !object(part.functionCall) || !object(part.functionCall.args)) throw invalid("Invalid Gemini function call");
        const call = part.functionCall, alias = modelToolName(call.name), id = call.id || "call_" + createHash("sha256").update(`${i}\0${j}\0${call.name}`).digest("hex").slice(0, 24);
        if (typeof id !== "string" || !id || pending.has(id)) throw invalid("Invalid Gemini function call ID");
        pending.set(id, call.name);const queue = queues.get(call.name) || [];queue.push(id);queues.set(call.name, queue);
        calls.push({ id, type: "function", function: { name: alias, arguments: JSON.stringify(call.args) } });
      } else if (part.functionResponse) {
        flush();const response = part.functionResponse;
        if (!object(response) || typeof response.name !== "string" || !object(response.response)) throw invalid("Invalid Gemini function response");
        const queue = queues.get(response.name) || [], id = response.id || queue[0];
        if (!id || pending.get(id) !== response.name) throw invalid("Gemini function response has no matching call");
        pending.delete(id);const at = queue.indexOf(id);if (at >= 0) queue.splice(at, 1);
        messages.push({ role: "tool", tool_call_id: id, content: JSON.stringify(response.response) });
      } else throw unsupportedPart(part, i, j);
    }
    flush();
  }
  if (pending.size) throw invalid("Gemini function call has no matching response");
  const generation = request.generationConfig || {};
  if (!object(generation)) throw invalid("Invalid Gemini generation configuration");
  const supported = new Set(["maxOutputTokens", "temperature", "topP", "stopSequences", "thinkingConfig", "candidateCount"]);
  if (Object.keys(generation).some(key => !supported.has(key)) || generation.candidateCount !== undefined && generation.candidateCount !== 1)
    throw invalid("Unsupported Gemini generation configuration");
  if (generation.thinkingConfig && (!object(generation.thinkingConfig)
    || Object.keys(generation.thinkingConfig).some(key => !["includeThoughts", "thinkingBudget", "thinkingLevel"].includes(key))
    || generation.thinkingConfig.thinkingBudget !== undefined && (!Number.isSafeInteger(generation.thinkingConfig.thinkingBudget)
      || generation.thinkingConfig.thinkingBudget < -1
      || !effort && ![0, -1].includes(generation.thinkingConfig.thinkingBudget))))
    throw invalid("Unsupported Gemini reasoning configuration");
  // A CCDX model alias advertises the Copilot effort selected in the App.
  // Its explicit effort takes precedence over Google's internal token budget.
  const level = effort || generation.thinkingConfig?.thinkingLevel?.toLowerCase();
  if (level && !reasoningEfforts.includes(level)) throw invalid("Unsupported Gemini reasoning level");
  const chat = { model, messages, stream,
    ...(stream ? { stream_options: { include_usage: true } } : {}),
    ...(tools.length ? { tools, tool_choice: choices[mode] } : {}),
    ...(generation.maxOutputTokens !== undefined ? { max_completion_tokens: generation.maxOutputTokens } : {}),
    ...(generation.temperature !== undefined ? { temperature: generation.temperature } : {}),
    ...(generation.topP !== undefined ? { top_p: generation.topP } : {}),
    ...(generation.stopSequences !== undefined ? { stop: generation.stopSequences } : {}),
    ...(level ? { reasoning_effort: level } : {}) };
  const allowedNames = mode === "NONE" ? new Map() : new Map(tools.map(tool => [tool.function.name, originalNames.get(tool.function.name)]));
  return { chat, originalNames: allowedNames };
}

export function chatFunctionPart(call, originalNames) {
  const name = originalNames.get(call?.function?.name);
  if (!name || typeof call?.id !== "string" || !call.id || typeof call.function.arguments !== "string")
    throw invalid("Invalid upstream Chat function call", 502);
  let args;try { args = parseAntigravityJSON(call.function.arguments); } catch { throw invalid("Invalid upstream Chat function arguments", 502); }
  if (!object(args)) throw invalid("Invalid upstream Chat function arguments", 502);
  return { functionCall: { id: call.id, name, args } };
}

const validCount = value => Number.isSafeInteger(value) && value >= 0;
export function mergeChatUsage(previous, value) {
  if (!value || typeof value !== "object") return previous;
  let next = previous;
  for (const key of ["prompt_tokens", "completion_tokens", "total_tokens", "reasoning_tokens"]) {
    if (validCount(value[key])) (next ||= {})[key] = value[key];
  }
  for (const [key, field] of [["prompt_tokens_details", "cached_tokens"], ["completion_tokens_details", "reasoning_tokens"]]) {
    if (validCount(value[key]?.[field])) (next ||= {})[key] = { [field]: value[key][field] };
  }
  return next;
}

export function chatReasoningTokens(usage) {
  const reasoning = usage?.completion_tokens_details?.reasoning_tokens ?? usage?.reasoning_tokens;
  return validCount(reasoning) && (!validCount(usage.completion_tokens) || reasoning <= usage.completion_tokens) ? reasoning : undefined;
}

function emptyChatReply(usage) {
  const facts = [];
  if (validCount(usage?.completion_tokens)) facts.push("output tokens: " + usage.completion_tokens);
  const reasoning = chatReasoningTokens(usage);
  if (reasoning !== undefined) facts.push("reasoning tokens: " + reasoning);
  return invalid("Copilot reply contained no text or tool calls" + (facts.length ? " (" + facts.join(", ") + ")" : "") + ".", 502);
}

function geminiUsage(usage) {
  if (!usage) return {};
  const result = {}, reasoning = chatReasoningTokens(usage);
  const separateThinking = reasoning !== undefined && usage.completion_tokens !== undefined && reasoning <= usage.completion_tokens;
  const candidates = separateThinking ? usage.completion_tokens - reasoning : usage.completion_tokens;
  for (const [key, value] of [["promptTokenCount", usage.prompt_tokens], ["candidatesTokenCount", candidates],
    ["totalTokenCount", usage.total_tokens], ["cachedContentTokenCount", usage.prompt_tokens_details?.cached_tokens],
    ["thoughtsTokenCount", separateThinking ? reasoning : undefined]]) {
    if (value !== undefined) result[key] = value;
  }
  return { usageMetadata: result };
}

export function chatToAntigravity(response, originalNames, usage = mergeChatUsage(null, response?.usage)) {
  const choice = response?.choices?.[0], message = choice?.message;
  if (!object(message)) throw invalid("Invalid upstream Chat response", 502);
  const parts = [];
  if (typeof message.reasoning_content === "string" && message.reasoning_content) parts.push({ text: message.reasoning_content, thought: true });
  for (const { text, thought } of chatOutputParts(message.content)) parts.push({ text, ...(thought ? { thought: true } : {}) });
  if (Array.isArray(message.tool_calls)) for (const call of message.tool_calls) parts.push(chatFunctionPart(call, originalNames));
  const finish = { stop: "STOP", tool_calls: "STOP", length: "MAX_TOKENS", content_filter: "SAFETY" }[choice.finish_reason];
  if (!finish) throw invalid("Upstream Chat response did not complete", 502);
  if (finish === "STOP" && !parts.some(part => !part.thought)) throw emptyChatReply(usage);
  return { candidates: [{ content: { role: "model", parts }, finishReason: finish, index: 0 }],
    ...geminiUsage(usage) };
}

export async function* chatStreamToAntigravity(response, originalNames, { onChunk, onUsage, onError, onOpaque } = {}) {
  if (!response?.body) throw invalid("Upstream Chat stream has no body", 502);
  const calls = new Map(), data = [], guard = new ToolArgumentDeltaGuard();let done = false, finish = null, usage = null, bytes = 0, visible = false, opaque;
  const frame = async function* () {
    if (!data.length) return;
    const raw = data.join("\n");data.length = 0;
    if (raw === "[DONE]") { done = true;return; }
    let event;try { event = JSON.parse(raw); } catch { throw invalid("Invalid upstream Chat stream event", 502); }
    if (event?.usage) usage = mergeChatUsage(usage, event.usage);
    if (event?.usage || event?.copilot_usage) onUsage?.(event, usage);
    const upstreamError = upstreamChatStreamError(event);
    if (upstreamError) {
      observeSourceStreamFailure(response, event.error);
      onError?.(upstreamError, event.error);
      throw upstreamError;
    }
    const choice = event?.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason) { finish = choice.finish_reason;sourceResponseAccepted(response); }
    const delta = choice.delta || {};
    if (onOpaque && typeof delta.reasoning_opaque === "string" && delta.reasoning_opaque) {
      // Copilot sends a full replacement value in each such delta.
      opaque = delta.reasoning_opaque.length <= MAX_OPAQUE_LENGTH ? delta.reasoning_opaque : undefined;
    }
    const parts = [];
    for (const [key, thought] of [["reasoning_content", true], ["refusal", false]]) {
      if (delta[key] === undefined || delta[key] === null || delta[key] === "") continue;
      if (typeof delta[key] !== "string") throw invalid("Unsupported upstream Chat stream content", 502);
      parts.push({ text: delta[key], thought });
    }
    const reasoning = parts.filter(part => part.thought);
    const refusal = parts.filter(part => !part.thought);
    for (const { text, thought } of [...reasoning, ...chatOutputParts(delta.content), ...refusal]) {
      if (!thought) visible = true;
      yield { response: { candidates: [{ index: 0, content: { role: "model", parts: [{ text, ...(thought ? { thought: true } : {}) }] } }] } };
    }
    if (delta.function_call) throw invalid("Unsupported upstream Chat function call", 502);
    if (delta.tool_calls !== undefined && !Array.isArray(delta.tool_calls)) throw invalid("Invalid upstream Chat tool calls", 502);
    for (const call of delta.tool_calls || []) {
      if (!Number.isSafeInteger(call.index) || call.index < 0 || call.index > 255) throw invalid("Invalid upstream Chat tool index", 502);
      let state = calls.get(call.index);
      if (!state) { state = { id: "", function: { name: "", arguments: "" } };calls.set(call.index, state); }
      if (call.id) {
        if (typeof call.id !== "string") throw invalid("Invalid upstream Chat tool ID", 502);
        if (state.id && state.id !== call.id) throw invalid("Upstream Chat tool ID changed", 502);
        state.id = call.id;
      }
      if (call.function?.name) {
        if (typeof call.function.name !== "string") throw invalid("Invalid upstream Chat tool name", 502);
        const name = call.function.name, duplicate = name === state.function.name && originalNames.has(name)
          && ![...originalNames.keys()].some(declared => declared.startsWith(state.function.name + name));
        if (!duplicate) state.function.name += name;
      }
      if (call.function?.arguments) {
        if (typeof call.function.arguments !== "string") throw invalid("Invalid upstream Chat tool arguments", 502);
        guard.observe(call.index, call.function.arguments);
        state.function.arguments += call.function.arguments;bytes += Buffer.byteLength(call.function.arguments);
      }
      if (bytes > MAX_UPSTREAM_CHAT_SUCCESS_BODY_BYTES) throw invalid("Upstream Chat tool arguments are too large", 502);
    }
  };
  for await (const line of webStreamLines(response, { onChunk })) {
    if (!line) { yield* frame();if (done) break;continue; }
    if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
  }
  if (!done && data.length) yield* frame();
  if (!done || !finish) {
    if (!visible && !calls.size && validCount(usage?.completion_tokens) && usage.completion_tokens > 0) throw emptyChatReply(usage);
    throw invalid("Upstream Chat stream ended before completion", 502);
  }
  const finishReason = { stop: "STOP", tool_calls: "STOP", length: "MAX_TOKENS", content_filter: "SAFETY" }[finish];
  if (finish === "stop" && !visible && !calls.size) throw emptyChatReply(usage);
  if (!finishReason || finish === "tool_calls" && !calls.size || finish !== "tool_calls" && calls.size)
    throw invalid("Invalid upstream Chat stream completion", 502);
  for (const [, call] of [...calls].sort(([a], [b]) => a - b)) {
    yield { response: { candidates: [{ index: 0, content: { role: "model", parts: [chatFunctionPart(call, originalNames)] } }] } };
  }
  yield { response: { candidates: [{ index: 0, finishReason }],
    ...geminiUsage(usage) } };
  if (opaque && finish === "tool_calls") onOpaque(opaque, [...calls.values()].map(call => call.id));
}
