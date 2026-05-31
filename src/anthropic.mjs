// Anthropic Messages API ⇄ OpenAI chat/completions 翻译层。
// 纯函数，不碰网络；上游由 adapter 经 copilot.mjs chatCompletions() 调用。

export function mapStopReason(finishReason) {
  switch (finishReason) {
    case "stop": return "end_turn";
    case "tool_calls": return "tool_use";
    case "length": return "max_tokens";
    default: return "end_turn";
  }
}

// system 字段(字符串或 text block 数组)→ 单条 system 文本
function systemToText(system) {
  if (!system) return null;
  if (typeof system === "string") return system;
  if (Array.isArray(system)) return system.map((b) => (typeof b === "string" ? b : b.text || "")).join("\n");
  return null;
}

// tool_result 的 content(字符串或 block 数组)→ OpenAI tool message 的 content 字符串
function toolResultContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((b) => (b.type === "text" ? b.text : typeof b === "string" ? b : JSON.stringify(b))).join("");
  }
  return JSON.stringify(content);
}

// 单条 Anthropic message → 0..N 条 OpenAI message
function convertMessage(msg) {
  const out = [];
  const role = msg.role; // "user" | "assistant"

  if (typeof msg.content === "string") {
    out.push({ role, content: msg.content });
    return out;
  }
  if (!Array.isArray(msg.content)) return out;

  // 先抽出 tool_result(它们必须成为独立的 role:"tool" 消息)
  const toolResults = msg.content.filter((b) => b.type === "tool_result");
  for (const tr of toolResults) {
    out.push({ role: "tool", tool_call_id: tr.tool_use_id, content: toolResultContent(tr.content) });
  }

  // 其余 block:text / image / tool_use
  const textImageParts = [];
  const toolCalls = [];
  for (const b of msg.content) {
    if (b.type === "text") {
      textImageParts.push({ type: "text", text: b.text });
    } else if (b.type === "image") {
      textImageParts.push({ type: "image_url", image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } });
    } else if (b.type === "tool_use") {
      toolCalls.push({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } });
    }
  }

  if (toolCalls.length > 0) {
    const m = { role, content: null, tool_calls: toolCalls };
    if (textImageParts.length === 1 && textImageParts[0].type === "text") m.content = textImageParts[0].text;
    else if (textImageParts.length > 0) m.content = textImageParts;
    out.push(m);
  } else if (textImageParts.length > 0) {
    if (textImageParts.length === 1 && textImageParts[0].type === "text") {
      out.push({ role, content: textImageParts[0].text });
    } else {
      out.push({ role, content: textImageParts });
    }
  }
  return out;
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

export function anthropicToChat(body) {
  const messages = [];
  const sys = systemToText(body.system);
  if (sys) messages.push({ role: "system", content: sys });
  for (const m of body.messages || []) {
    for (const converted of convertMessage(m)) messages.push(converted);
  }

  const chatReq = { model: body.model, messages };
  if (body.max_tokens !== undefined) chatReq.max_tokens = body.max_tokens;
  if (body.temperature !== undefined) chatReq.temperature = body.temperature;
  if (body.top_p !== undefined) chatReq.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) chatReq.stop = body.stop_sequences;

  if (Array.isArray(body.tools) && body.tools.length) {
    chatReq.tools = body.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.input_schema },
    }));
  }
  const tc = mapToolChoice(body.tool_choice);
  if (tc !== undefined) chatReq.tool_choice = tc;

  return chatReq;
}
