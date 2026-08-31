import { randomUUID } from "node:crypto";
import {
  incompleteUpstreamStream,
  invalidUpstreamStream,
  ToolArgumentDeltaGuard,
  upstreamChatStreamError,
} from "./stream-contract.mjs";
import { isChatOutputDelta, markFirstOutput, markOutputTokens } from "./stream-performance.mjs";

let tokenizerModulePromise = null;

async function tokenCounter() {
  tokenizerModulePromise ||= import("gpt-tokenizer");
  return (await tokenizerModulePromise).countTokens;
}

// Anthropic Messages API to OpenAI chat/completions translation.
// Pure functions only; network calls stay in the protocol handler and copilot.mjs.

export function mapStopReason(finishReason) {
  switch (finishReason) {
    case "stop": return "end_turn";
    case "tool_calls": return "tool_use";
    case "length": return "max_tokens";
    default: return "end_turn";
  }
}

// Convert a string or text-block system field into one system message.
function systemToText(system) {
  if (!system) return null;
  if (typeof system === "string") return system;
  if (Array.isArray(system)) return system.map((b) => (typeof b === "string" ? b : b.text || "")).join("\n");
  return null;
}

// Convert tool_result content into the string payload expected by OpenAI tool messages.
function toolResultContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((b) => (b.type === "text" ? b.text : typeof b === "string" ? b : JSON.stringify(b))).join("");
  }
  return JSON.stringify(content);
}

// Convert one Anthropic message into zero or more OpenAI messages.
function convertContentBlocks(role, blocks) {
  const textImageParts = [];
  const toolCalls = [];
  for (const b of blocks) {
    if (b.type === "text") {
      textImageParts.push({ type: "text", text: b.text });
    } else if (b.type === "image") {
      const url = b.source?.type === "url"
        ? b.source.url
        : `data:${b.source.media_type};base64,${b.source.data}`;
      textImageParts.push({ type: "image_url", image_url: { url } });
    } else if (b.type === "tool_use") {
      toolCalls.push({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } });
    }
  }

  if (toolCalls.length > 0) {
    const m = { role, content: null, tool_calls: toolCalls };
    if (textImageParts.length === 1 && textImageParts[0].type === "text") m.content = textImageParts[0].text;
    else if (textImageParts.length > 0) m.content = textImageParts;
    return m;
  } else if (textImageParts.length > 0) {
    if (textImageParts.length === 1 && textImageParts[0].type === "text") {
      return { role, content: textImageParts[0].text };
    } else {
      return { role, content: textImageParts };
    }
  }
  return null;
}

function convertMessage(msg) {
  const out = [];
  const role = msg.role; // "user" | "assistant"

  if (typeof msg.content === "string") {
    out.push({ role, content: msg.content });
    return out;
  }
  if (!Array.isArray(msg.content)) return out;

  if (!msg.content.some((block) => block.type === "tool_result")) {
    const converted = convertContentBlocks(role, msg.content);
    if (converted) out.push(converted);
    return out;
  }

  let contentBlocks = [];
  const flushContent = () => {
    const converted = convertContentBlocks(role, contentBlocks);
    if (converted) out.push(converted);
    contentBlocks = [];
  };
  for (const block of msg.content) {
    if (block.type !== "tool_result") {
      contentBlocks.push(block);
      continue;
    }
    flushContent();
    out.push({
      role: "tool",
      tool_call_id: block.tool_use_id,
      content: toolResultContent(block.content),
    });
  }
  flushContent();
  return out;
}

function toolInputSchema(inputSchema) {
  if (inputSchema
    && typeof inputSchema === "object"
    && !Array.isArray(inputSchema)
    && inputSchema.type === "object"
    && Object.keys(inputSchema).length === 1) {
    return { type: "object", properties: {} };
  }
  return inputSchema;
}

function mapToolChoice(tc) {
  if (!tc) return undefined;
  switch (tc.type) {
    case "auto": return "auto";
    case "none": return "none";
    case "any": return "required";
    case "tool": return { type: "function", function: { name: tc.name } };
    default: return undefined;
  }
}

export function anthropicToChat(body, options = {}) {
  const messages = [];
  const sys = systemToText(body.system);
  if (sys) messages.push({ role: "system", content: sys });
  for (const m of body.messages || []) {
    for (const converted of convertMessage(m)) messages.push(converted);
  }

  const chatReq = { model: options.upstreamModel || body.model, messages };
  if (body.max_tokens !== undefined) chatReq.max_tokens = body.max_tokens;
  if (body.temperature !== undefined) chatReq.temperature = body.temperature;
  if (body.top_p !== undefined) chatReq.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) chatReq.stop = body.stop_sequences;

  if (Array.isArray(body.tools) && body.tools.length) {
    chatReq.tools = body.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: toolInputSchema(t.input_schema) },
    }));
  }
  const tc = mapToolChoice(body.tool_choice);
  if (tc !== undefined) chatReq.tool_choice = tc;

  return chatReq;
}

function uid() { return randomUUID().replace(/-/g, ""); }

function nonNegativeTokenCount(value) {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function invalidToolArguments(toolName) {
  const name = String(toolName || "unknown").slice(0, 100);
  return invalidUpstreamStream(
    `Upstream Chat Completions tool "${name}" did not return valid JSON object arguments`,
    "upstream_tool_arguments_json_invalid",
  );
}

export function chatToAnthropic(openaiResp, model, options = {}) {
  const choice = openaiResp.choices?.[0];
  const msg = choice?.message || {};
  const content = [];

  if (msg.content) content.push({ type: "text", text: msg.content });
  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      const rawArguments = tc.function?.arguments;
      let input;
      if (rawArguments === undefined || rawArguments === null || rawArguments === "") {
        input = {};
      } else {
        try {
          input = JSON.parse(rawArguments);
        } catch {
          throw invalidToolArguments(tc.function?.name);
        }
        if (!input || typeof input !== "object" || Array.isArray(input)) {
          throw invalidToolArguments(tc.function?.name);
        }
      }
      content.push({ type: "tool_use", id: tc.id, name: tc.function.name, input });
    }
  }

  const u = openaiResp.usage || {};
  const prompt = nonNegativeTokenCount(u.prompt_tokens);
  const cached = Math.min(prompt, nonNegativeTokenCount(u.prompt_tokens_details?.cached_tokens));
  const usage = {
    input_tokens: prompt - cached,
    output_tokens: nonNegativeTokenCount(u.completion_tokens),
  };
  if (cached > 0) usage.cache_read_input_tokens = cached;

  return {
    id: `msg_${uid()}`,
    type: "message",
    role: "assistant",
    model: options.forceModel ? model : (openaiResp.model || model),
    content,
    stop_reason: mapStopReason(choice?.finish_reason),
    stop_sequence: null,
    usage,
  };
}

// Consume OpenAI chat SSE lines and emit Anthropic SSE events.
export async function streamAnthropicFromLines(lineIterator, emit, model, options = {}) {
  const msgId = `msg_${uid()}`;
  let started = false;
  let blockIndex = -1;
  let textOpen = false;
  let actualModel = model;
  let finishReason = null;
  const toolBlocks = {}; // openaiIndex -> { anthropicIndex }
  let sawToolUse = false;
  const trailingTextChunks = [];
  let outputTokens = 0;
  let sawDone = false;
  const toolArgumentGuard = new ToolArgumentDeltaGuard();
  let performanceOutputSeen = false;
  const markPerformanceOutput = () => {
    if (performanceOutputSeen) return;
    performanceOutputSeen = true;
    markFirstOutput();
  };

  const ensureStart = async () => {
    if (started) return;
    started = true;
    await emit("message_start", { type: "message_start", message: {
      id: msgId, type: "message", role: "assistant", model: actualModel,
      content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    } });
  };

  const openText = async () => {
    if (textOpen) return;
    blockIndex += 1;
    textOpen = true;
    await emit("content_block_start", { type: "content_block_start", index: blockIndex,
      content_block: { type: "text", text: "" } });
  };
  const closeText = async () => {
    if (!textOpen) return;
    await emit("content_block_stop", { type: "content_block_stop", index: blockIndex });
    textOpen = false;
  };

  for await (const line of lineIterator) {
    if (!line.startsWith("data: ")) continue;
    const data = line.slice(6).trim();
    if (data === "[DONE]") {
      sawDone = true;
      break;
    }
    let parsed;
    try {
      parsed = JSON.parse(data);
    } catch {
      throw invalidUpstreamStream(
        "Upstream Chat Completions SSE event contained invalid JSON",
        "upstream_stream_json_invalid",
      );
    }
    const upstreamError = upstreamChatStreamError(parsed);
    if (upstreamError) throw upstreamError;
    if (!options.forceModel && parsed.model) actualModel = parsed.model;
    if (parsed.usage?.completion_tokens != null) {
      outputTokens = nonNegativeTokenCount(parsed.usage.completion_tokens);
      markOutputTokens(outputTokens);
    }
    const choice = parsed.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta || {};
    if (isChatOutputDelta(delta)) markPerformanceOutput();
    await ensureStart();

    if (delta.content) {
      if (sawToolUse) {
        trailingTextChunks.push(delta.content);
      } else {
        await openText();
        await emit("content_block_delta", { type: "content_block_delta", index: blockIndex,
          delta: { type: "text_delta", text: delta.content } });
      }
    }

    if (Array.isArray(delta.tool_calls)) {
      sawToolUse = true;
      await closeText();
      for (const tc of delta.tool_calls) {
        const oi = tc.index ?? 0;
        if (!toolBlocks[oi]) {
          blockIndex += 1;
          toolBlocks[oi] = { anthropicIndex: blockIndex };
          await emit("content_block_start", { type: "content_block_start", index: blockIndex,
            content_block: { type: "tool_use", id: tc.id || `tu_${uid()}`, name: tc.function?.name || "", input: {} } });
        }
        const argumentDelta = tc.function?.arguments;
        toolArgumentGuard.observe(oi, argumentDelta);
        if (argumentDelta) {
          await emit("content_block_delta", { type: "content_block_delta", index: toolBlocks[oi].anthropicIndex,
            delta: { type: "input_json_delta", partial_json: argumentDelta } });
        }
      }
    }

    if (choice.finish_reason) finishReason = choice.finish_reason;
  }

  if (!sawDone) throw incompleteUpstreamStream("[DONE]");

  await ensureStart();
  if (textOpen) await closeText();
  for (const oi of Object.keys(toolBlocks)) {
    await emit("content_block_stop", { type: "content_block_stop", index: toolBlocks[oi].anthropicIndex });
  }
  if (trailingTextChunks.length) {
    await openText();
    for (const text of trailingTextChunks) {
      await emit("content_block_delta", { type: "content_block_delta", index: blockIndex,
        delta: { type: "text_delta", text } });
    }
    await closeText();
  }

  const stop_reason = finishReason ? mapStopReason(finishReason) : (sawToolUse ? "tool_use" : "end_turn");
  await emit("message_delta", { type: "message_delta", delta: { stop_reason, stop_sequence: null },
    usage: { output_tokens: outputTokens } });
  await emit("message_stop", { type: "message_stop" });
}

export function anthropicTokenText(body) {
  const parts = [];
  const sys = systemToText(body.system);
  if (sys) parts.push(sys);

  for (const m of body.messages || []) {
    if (typeof m.content === "string") {
      parts.push(m.content);
    } else if (Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b.type === "text") parts.push(b.text);
        else if (b.type === "tool_use") parts.push(b.name + JSON.stringify(b.input ?? {}));
        else if (b.type === "tool_result") parts.push(toolResultContent(b.content));
      }
    }
  }

  if (Array.isArray(body.tools)) {
    for (const t of body.tools) {
      parts.push(t.name + (t.description || "") + JSON.stringify(t.input_schema || {}));
    }
  }

  return parts.join("\n");
}

export async function countTokenText(text) {
  const count = await tokenCounter();
  return { input_tokens: count(text) };
}

// Copilot has no count_tokens endpoint; estimate locally with gpt-tokenizer.
export async function countTokens(body) {
  return countTokenText(anthropicTokenText(body));
}
