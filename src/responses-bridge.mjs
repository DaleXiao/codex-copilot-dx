import { randomUUID } from "node:crypto";
import { chatCompletions } from "./copilot.mjs";
import { webStreamLines } from "./stream.mjs";
import { abortErrorStatusCode, isAbortLikeError } from "./http-transport.mjs";

function cloneJson(value) {
  return value === undefined ? undefined : structuredClone(value);
}

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

export function chatToResponses(chatResp, model) {
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
    try {
      resp = await chatCompletionsFn({
        ...chatReq,
        stream: true,
      }, { signal: options.signal });
    } finally {
      options.releaseRequest?.();
    }
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
