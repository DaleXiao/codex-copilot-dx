import { createHash } from "node:crypto";
import { webStreamLines } from "./stream.mjs";
import { MAX_UPSTREAM_CHAT_SUCCESS_BODY_BYTES } from "./http-transport.mjs";
import { ToolArgumentDeltaGuard, upstreamChatStreamError } from "./stream-contract.mjs";

const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const names = /^[A-Za-z0-9_-]{1,64}$/;
const types = new Set(["OBJECT", "ARRAY", "STRING", "NUMBER", "INTEGER", "BOOLEAN", "NULL"]);
const schemaChildren = new Set(["items", "additionalProperties", "not", "if", "then", "else", "contains", "propertyNames"]);
const schemaMaps = new Set(["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]);
const schemaLists = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);

function invalid(message, statusCode = 400) {
  return Object.assign(new Error(message), { code: "ccdx_antigravity_protocol", statusCode });
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

export function antigravityToChat(request, { model, effort, stream = true } = {}) {
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
    let content = [], calls = [], reasoning = "";
    const flush = () => {
      if (!content.length && !calls.length && !reasoning) return;
      messages.push({ role, content: contentValue(content), ...(reasoning ? { reasoning_content: reasoning } : {}), ...(calls.length ? { tool_calls: calls } : {}) });
      content = [];calls = [];reasoning = "";
    };
    for (let j = 0; j < item.parts.length; j++) {
      const part = item.parts[j];if (!object(part) || part.thoughtSignature || part.thought_signature) throw invalid("Unsupported Gemini message part");
      const count = [typeof part.text === "string", Boolean(part.inlineData || part.inline_data), Boolean(part.functionCall), Boolean(part.functionResponse)].filter(Boolean).length;
      if (count !== 1 || Object.keys(part).some(key => !["text", "thought", "inlineData", "inline_data", "functionCall", "functionResponse"].includes(key)))
        throw invalid("Unsupported Gemini message part");
      if (typeof part.text === "string") {
        if (part.thought) { if (role !== "assistant") throw invalid("Invalid Gemini thought");reasoning += part.text; }
        else content.push({ type: "text", text: part.text });
      } else if (part.inlineData || part.inline_data) content.push(imagePart(part));
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
      } else throw invalid("Unsupported Gemini message part");
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
  if (level && !["low", "medium", "high"].includes(level)) throw invalid("Unsupported Gemini reasoning level");
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

export function chatToAntigravity(response, originalNames) {
  const choice = response?.choices?.[0], message = choice?.message;
  if (!object(message)) throw invalid("Invalid upstream Chat response", 502);
  const parts = [];
  if (typeof message.reasoning_content === "string" && message.reasoning_content) parts.push({ text: message.reasoning_content, thought: true });
  if (typeof message.content === "string" && message.content) parts.push({ text: message.content });
  if (Array.isArray(message.tool_calls)) for (const call of message.tool_calls) parts.push(chatFunctionPart(call, originalNames));
  const finish = { stop: "STOP", tool_calls: "STOP", length: "MAX_TOKENS", content_filter: "SAFETY" }[choice.finish_reason];
  if (!finish || finish === "STOP" && !parts.some(part => !part.thought)) throw invalid("Upstream Chat response did not complete", 502);
  const usage = response.usage;
  return { candidates: [{ content: { role: "model", parts }, finishReason: finish, index: 0 }],
    ...(usage ? { usageMetadata: { promptTokenCount: usage.prompt_tokens || 0, candidatesTokenCount: usage.completion_tokens || 0, totalTokenCount: usage.total_tokens || 0 } } : {}) };
}

export async function* chatStreamToAntigravity(response, originalNames, { onChunk } = {}) {
  if (!response?.body) throw invalid("Upstream Chat stream has no body", 502);
  const calls = new Map(), data = [], guard = new ToolArgumentDeltaGuard();let done = false, finish = null, usage = null, bytes = 0, visible = false;
  const frame = async function* () {
    if (!data.length) return;
    const raw = data.join("\n");data.length = 0;
    if (raw === "[DONE]") { done = true;return; }
    let event;try { event = JSON.parse(raw); } catch { throw invalid("Invalid upstream Chat stream event", 502); }
    const upstreamError = upstreamChatStreamError(event);if (upstreamError) throw upstreamError;
    if (event?.usage) usage = event.usage;
    const choice = event?.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason) finish = choice.finish_reason;
    const delta = choice.delta || {};
    for (const [key, thought] of [["reasoning_content", true], ["content", false], ["refusal", false]]) {
      if (delta[key] === undefined || delta[key] === null || delta[key] === "") continue;
      if (typeof delta[key] !== "string") throw invalid("Unsupported upstream Chat stream content", 502);
      if (!thought) visible = true;
      yield { response: { candidates: [{ index: 0, content: { role: "model", parts: [{ text: delta[key], ...(thought ? { thought: true } : {}) }] } }] } };
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
  if (!done || !finish) throw invalid("Upstream Chat stream ended before completion", 502);
  const finishReason = { stop: "STOP", tool_calls: "STOP", length: "MAX_TOKENS", content_filter: "SAFETY" }[finish];
  if (!finishReason || finish === "tool_calls" && !calls.size || finish !== "tool_calls" && calls.size || finish === "stop" && !visible)
    throw invalid("Invalid upstream Chat stream completion", 502);
  for (const [, call] of [...calls].sort(([a], [b]) => a - b)) {
    yield { response: { candidates: [{ index: 0, content: { role: "model", parts: [chatFunctionPart(call, originalNames)] } }] } };
  }
  yield { response: { candidates: [{ index: 0, finishReason }],
    ...(usage ? { usageMetadata: { promptTokenCount: usage.prompt_tokens || 0, candidatesTokenCount: usage.completion_tokens || 0, totalTokenCount: usage.total_tokens || 0 } } : {}) } };
}
