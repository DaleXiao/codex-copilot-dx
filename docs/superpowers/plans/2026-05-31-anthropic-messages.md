# /v1/messages (Anthropic API) 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在新版 adapter 中实现 Anthropic Messages API(`/v1/messages` 流式+非流式、`/v1/messages/count_tokens`),使新版同时完整服务 Codex 与 Claude Code,彻底替代 4141/copilot-api。

**Architecture:** 新增 `src/anthropic.mjs` 纯翻译层(Anthropic ⇄ OpenAI chat),复用现有 `copilot.mjs` `chatCompletions()` 打上游;adapter 新增两个路由。count_tokens 用 `gpt-tokenizer` 精确计数。

**Tech Stack:** Node v26 ESM、`node --test`、唯一运行时依赖 `gpt-tokenizer@^3.4.0`(零传递依赖)。

设计文档:`docs/superpowers/specs/2026-05-31-anthropic-messages-design.md`

---

## 文件结构

| 文件 | 责任 |
|---|---|
| `src/anthropic.mjs` 【新】 | `anthropicToChat`、`chatToAnthropic`、`streamChatToAnthropic`、`countTokens`、`mapStopReason` |
| `src/adapter.mjs` 【改】 | 新增 POST `/v1/messages`、POST `/v1/messages/count_tokens` 路由 |
| `package.json` 【改】 | deps 加 gpt-tokenizer;version 0.2.0→0.3.0 |
| `test/anthropic.test.mjs` 【新】 | 翻译纯函数单测 |
| `test/e2e.sh` 【改】 | 增 Anthropic 端点冒烟 |

---

## Task 1: mapStopReason + anthropicToChat 请求翻译

**Files:**
- Create: `src/anthropic.mjs`
- Test: `test/anthropic.test.mjs`

- [ ] **Step 1: 写失败测试**

Create `test/anthropic.test.mjs`:

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { mapStopReason, anthropicToChat } from "../src/anthropic.mjs";

test("mapStopReason: 四种映射", () => {
  assert.equal(mapStopReason("stop"), "end_turn");
  assert.equal(mapStopReason("tool_calls"), "tool_use");
  assert.equal(mapStopReason("length"), "max_tokens");
  assert.equal(mapStopReason(undefined), "end_turn");
});

test("anthropicToChat: system 字符串 → system message", () => {
  const r = anthropicToChat({ model: "m", system: "be nice", messages: [{ role: "user", content: "hi" }], max_tokens: 10 });
  assert.deepEqual(r.messages[0], { role: "system", content: "be nice" });
  assert.equal(r.messages[1].role, "user");
  assert.equal(r.messages[1].content, "hi");
  assert.equal(r.max_tokens, 10);
  assert.equal(r.model, "m");
});

test("anthropicToChat: system 数组 → 拼接", () => {
  const r = anthropicToChat({ model: "m", system: [{ type: "text", text: "a" }, { type: "text", text: "b" }], messages: [{ role: "user", content: "hi" }] });
  assert.equal(r.messages[0].content, "a\nb");
});

test("anthropicToChat: text content block", () => {
  const r = anthropicToChat({ model: "m", messages: [{ role: "user", content: [{ type: "text", text: "yo" }] }] });
  assert.equal(r.messages[0].role, "user");
  // 单 text block 扁平为字符串或 [{type:text}] 皆可被上游接受；本实现用字符串
  assert.equal(r.messages[0].content, "yo");
});

test("anthropicToChat: image block → image_url data URI", () => {
  const r = anthropicToChat({ model: "m", messages: [{ role: "user", content: [
    { type: "text", text: "look" },
    { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
  ] }] });
  const parts = r.messages[0].content;
  assert.ok(Array.isArray(parts));
  assert.deepEqual(parts[0], { type: "text", text: "look" });
  assert.equal(parts[1].type, "image_url");
  assert.equal(parts[1].image_url.url, "data:image/png;base64,AAAA");
});

test("anthropicToChat: tool_use block → assistant tool_calls", () => {
  const r = anthropicToChat({ model: "m", messages: [
    { role: "assistant", content: [{ type: "tool_use", id: "tu_1", name: "get_x", input: { a: 1 } }] },
  ] });
  const m = r.messages[0];
  assert.equal(m.role, "assistant");
  assert.equal(m.tool_calls[0].id, "tu_1");
  assert.equal(m.tool_calls[0].type, "function");
  assert.equal(m.tool_calls[0].function.name, "get_x");
  assert.equal(m.tool_calls[0].function.arguments, JSON.stringify({ a: 1 }));
});

test("anthropicToChat: tool_result block → tool message", () => {
  const r = anthropicToChat({ model: "m", messages: [
    { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: "42" }] },
  ] });
  const m = r.messages[0];
  assert.equal(m.role, "tool");
  assert.equal(m.tool_call_id, "tu_1");
  assert.equal(m.content, "42");
});

test("anthropicToChat: tools input_schema → function.parameters", () => {
  const r = anthropicToChat({ model: "m", messages: [{ role: "user", content: "hi" }],
    tools: [{ name: "get_x", description: "d", input_schema: { type: "object", properties: { a: { type: "string" } } } }] });
  assert.equal(r.tools[0].type, "function");
  assert.equal(r.tools[0].function.name, "get_x");
  assert.equal(r.tools[0].function.description, "d");
  assert.deepEqual(r.tools[0].function.parameters, { type: "object", properties: { a: { type: "string" } } });
});

test("anthropicToChat: tool_choice 映射", () => {
  assert.equal(anthropicToChat({ model: "m", messages: [], tool_choice: { type: "auto" } }).tool_choice, "auto");
  assert.equal(anthropicToChat({ model: "m", messages: [], tool_choice: { type: "any" } }).tool_choice, "required");
  assert.deepEqual(anthropicToChat({ model: "m", messages: [], tool_choice: { type: "tool", name: "get_x" } }).tool_choice,
    { type: "function", function: { name: "get_x" } });
});

test("anthropicToChat: stop_sequences → stop, 透传采样参数", () => {
  const r = anthropicToChat({ model: "m", messages: [{ role: "user", content: "hi" }], stop_sequences: ["X"], temperature: 0.5, top_p: 0.9 });
  assert.deepEqual(r.stop, ["X"]);
  assert.equal(r.temperature, 0.5);
  assert.equal(r.top_p, 0.9);
});
```

- [ ] **Step 2: 运行测试,确认失败**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/anthropic.mjs'`。

- [ ] **Step 3: 实现 src/anthropic.mjs(本任务部分)**

Create `src/anthropic.mjs`:

```javascript
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
    // assistant 带工具调用
    const m = { role, content: null, tool_calls: toolCalls };
    // 若同时有文本,放入 content(OpenAI 允许 content + tool_calls)
    if (textImageParts.length === 1 && textImageParts[0].type === "text") m.content = textImageParts[0].text;
    else if (textImageParts.length > 0) m.content = textImageParts;
    out.push(m);
  } else if (textImageParts.length > 0) {
    // 单一 text → 扁平为字符串;含 image 或多 part → 数组
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
```

- [ ] **Step 4: 运行测试,确认通过**

Run: `npm test`
Expected: PASS — 本任务 11 个新测试 + 既有 26 = 37 通过。

- [ ] **Step 5: 提交**

```bash
git add src/anthropic.mjs test/anthropic.test.mjs
git commit -m "feat: anthropic request translation (anthropicToChat) + mapStopReason"
```

---

## Task 2: chatToAnthropic 非流式响应翻译

**Files:**
- Modify: `src/anthropic.mjs`
- Test: `test/anthropic.test.mjs`

- [ ] **Step 1: 写失败测试 — 追加到 test/anthropic.test.mjs**

```javascript
import { chatToAnthropic } from "../src/anthropic.mjs";

test("chatToAnthropic: 纯文本响应", () => {
  const openai = { model: "Claude", choices: [{ message: { content: "hello" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 9, completion_tokens: 2 } };
  const a = chatToAnthropic(openai, "claude-sonnet-4.5");
  assert.equal(a.type, "message");
  assert.equal(a.role, "assistant");
  assert.deepEqual(a.content, [{ type: "text", text: "hello" }]);
  assert.equal(a.stop_reason, "end_turn");
  assert.equal(a.usage.input_tokens, 9);
  assert.equal(a.usage.output_tokens, 2);
  assert.ok(a.id);
});

test("chatToAnthropic: tool_use 响应", () => {
  const openai = { choices: [{ message: { content: null, tool_calls: [
    { id: "tu_1", function: { name: "get_x", arguments: '{"a":1}' } },
  ] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 5, completion_tokens: 3 } };
  const a = chatToAnthropic(openai, "m");
  assert.equal(a.content[0].type, "tool_use");
  assert.equal(a.content[0].id, "tu_1");
  assert.equal(a.content[0].name, "get_x");
  assert.deepEqual(a.content[0].input, { a: 1 });
  assert.equal(a.stop_reason, "tool_use");
});

test("chatToAnthropic: 文本+工具混合", () => {
  const openai = { choices: [{ message: { content: "let me check", tool_calls: [
    { id: "tu_2", function: { name: "f", arguments: "{}" } },
  ] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
  const a = chatToAnthropic(openai, "m");
  assert.equal(a.content[0].type, "text");
  assert.equal(a.content[0].text, "let me check");
  assert.equal(a.content[1].type, "tool_use");
});

test("chatToAnthropic: cached_tokens → cache_read_input_tokens", () => {
  const openai = { choices: [{ message: { content: "x" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 30 } } };
  const a = chatToAnthropic(openai, "m");
  assert.equal(a.usage.input_tokens, 70); // 100 - 30
  assert.equal(a.usage.cache_read_input_tokens, 30);
});
```

- [ ] **Step 2: 运行测试,确认失败**

Run: `npm test`
Expected: FAIL — `chatToAnthropic` 未导出。

- [ ] **Step 3: 实现 chatToAnthropic**

追加到 `src/anthropic.mjs`:

```javascript
import { randomUUID } from "node:crypto";

function uid() { return randomUUID().replace(/-/g, ""); }

export function chatToAnthropic(openaiResp, model) {
  const choice = openaiResp.choices?.[0];
  const msg = choice?.message || {};
  const content = [];

  if (msg.content) content.push({ type: "text", text: msg.content });
  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      let input = {};
      try { input = JSON.parse(tc.function.arguments || "{}"); } catch { input = {}; }
      content.push({ type: "tool_use", id: tc.id, name: tc.function.name, input });
    }
  }

  const u = openaiResp.usage || {};
  const cached = u.prompt_tokens_details?.cached_tokens ?? 0;
  const usage = {
    input_tokens: (u.prompt_tokens ?? 0) - cached,
    output_tokens: u.completion_tokens ?? 0,
  };
  if (cached > 0) usage.cache_read_input_tokens = cached;

  return {
    id: `msg_${uid()}`,
    type: "message",
    role: "assistant",
    model: openaiResp.model || model,
    content,
    stop_reason: mapStopReason(choice?.finish_reason),
    stop_sequence: null,
    usage,
  };
}
```

> 注意:`randomUUID` 的 import 放文件顶部(若已被前序任务引入则合并,勿重复声明 `uid`)。

- [ ] **Step 4: 运行测试,确认通过**

Run: `npm test`
Expected: PASS — 新增 4 个 + 既有 = 41 通过。

- [ ] **Step 5: 提交**

```bash
git add src/anthropic.mjs test/anthropic.test.mjs
git commit -m "feat: anthropic non-stream response translation (chatToAnthropic)"
```

---

## Task 3: streamChatToAnthropic 流式翻译

**Files:**
- Modify: `src/anthropic.mjs`
- Test: `test/anthropic.test.mjs`

> 该函数消费 OpenAI chat SSE(经 webStreamLines 逐行),产出 Anthropic 事件。为可单测,设计成接收一个**已是行迭代器**的输入而非 fetch Response —— 这样测试可喂入数组,adapter 侧用 webStreamLines 适配。

- [ ] **Step 1: 写失败测试 — 追加**

```javascript
import { streamAnthropicFromLines } from "../src/anthropic.mjs";

// 把 OpenAI chat SSE 行喂入,收集产出的 Anthropic 事件 [event, data]
async function collect(lines, model = "m") {
  async function* gen() { for (const l of lines) yield l; }
  const events = [];
  await streamAnthropicFromLines(gen(), (event, data) => events.push([event, data]), model);
  return events;
}

test("streamAnthropicFromLines: 纯文本流", async () => {
  const lines = [
    'data: {"model":"claude","choices":[{"delta":{"content":"He"}}]}',
    'data: {"choices":[{"delta":{"content":"llo"}}]}',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
    'data: [DONE]',
  ];
  const ev = await collect(lines);
  const types = ev.map((e) => e[0]);
  assert.deepEqual(types, [
    "message_start", "content_block_start", "content_block_delta", "content_block_delta",
    "content_block_stop", "message_delta", "message_stop",
  ]);
  // 文本 delta 内容
  assert.equal(ev[2][1].delta.text, "He");
  assert.equal(ev[3][1].delta.text, "llo");
  // stop_reason
  assert.equal(ev[5][1].delta.stop_reason, "end_turn");
});

test("streamAnthropicFromLines: 工具调用流", async () => {
  const lines = [
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"tu_1","function":{"name":"get_x","arguments":""}}]}}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"a\\":"}}]}}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"1}"}}]}}]}',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
    'data: [DONE]',
  ];
  const ev = await collect(lines);
  const types = ev.map((e) => e[0]);
  // 应含 tool_use 的 content_block_start 与 input_json_delta
  const startTool = ev.find((e) => e[0] === "content_block_start" && e[1].content_block.type === "tool_use");
  assert.ok(startTool);
  assert.equal(startTool[1].content_block.name, "get_x");
  assert.equal(startTool[1].content_block.id, "tu_1");
  const jsonDeltas = ev.filter((e) => e[0] === "content_block_delta" && e[1].delta.type === "input_json_delta");
  assert.equal(jsonDeltas.map((e) => e[1].delta.partial_json).join(""), '{"a":1}');
  const md = ev.find((e) => e[0] === "message_delta");
  assert.equal(md[1].delta.stop_reason, "tool_use");
  assert.equal(types[types.length - 1], "message_stop");
});
```

- [ ] **Step 2: 运行测试,确认失败**

Run: `npm test`
Expected: FAIL — `streamAnthropicFromLines` 未导出。

- [ ] **Step 3: 实现 streamAnthropicFromLines**

追加到 `src/anthropic.mjs`(注:导出 `streamAnthropicFromLines` 接收行异步迭代器;Task 4 在 adapter 中用 webStreamLines 包装 fetch Response 再调它):

```javascript
// 消费 OpenAI chat SSE 行迭代器,产出 Anthropic 事件。emit(event, dataObj)。
export async function streamAnthropicFromLines(lineIterator, emit, model) {
  const msgId = `msg_${uid()}`;
  let started = false;
  let blockIndex = -1;
  let textOpen = false;
  let actualModel = model;
  let finishReason = null;
  const toolBlocks = {}; // openaiIndex -> { anthropicIndex, started }
  let sawToolUse = false;
  let outputTokens = 0;

  const ensureStart = () => {
    if (started) return;
    started = true;
    emit("message_start", { type: "message_start", message: {
      id: msgId, type: "message", role: "assistant", model: actualModel,
      content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    } });
  };

  const openText = () => {
    if (textOpen) return;
    blockIndex += 1;
    textOpen = true;
    emit("content_block_start", { type: "content_block_start", index: blockIndex,
      content_block: { type: "text", text: "" } });
  };
  const closeText = () => {
    if (!textOpen) return;
    emit("content_block_stop", { type: "content_block_stop", index: blockIndex });
    textOpen = false;
  };

  for await (const line of lineIterator) {
    if (!line.startsWith("data: ")) continue;
    const data = line.slice(6).trim();
    if (data === "[DONE]") break;
    let parsed;
    try { parsed = JSON.parse(data); } catch { continue; }
    if (parsed.model) actualModel = parsed.model;
    const choice = parsed.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta || {};
    ensureStart();

    if (delta.content) {
      openText();
      emit("content_block_delta", { type: "content_block_delta", index: blockIndex,
        delta: { type: "text_delta", text: delta.content } });
    }

    if (Array.isArray(delta.tool_calls)) {
      sawToolUse = true;
      closeText();
      for (const tc of delta.tool_calls) {
        const oi = tc.index ?? 0;
        if (!toolBlocks[oi]) {
          blockIndex += 1;
          toolBlocks[oi] = { anthropicIndex: blockIndex };
          emit("content_block_start", { type: "content_block_start", index: blockIndex,
            content_block: { type: "tool_use", id: tc.id || `tu_${uid()}`, name: tc.function?.name || "", input: {} } });
        }
        if (tc.function?.arguments) {
          emit("content_block_delta", { type: "content_block_delta", index: toolBlocks[oi].anthropicIndex,
            delta: { type: "input_json_delta", partial_json: tc.function.arguments } });
        }
      }
    }

    if (choice.finish_reason) finishReason = choice.finish_reason;
    if (parsed.usage?.completion_tokens) outputTokens = parsed.usage.completion_tokens;
  }

  ensureStart();
  // 关闭仍打开的块
  if (textOpen) closeText();
  for (const oi of Object.keys(toolBlocks)) {
    emit("content_block_stop", { type: "content_block_stop", index: toolBlocks[oi].anthropicIndex });
  }

  const stop_reason = finishReason ? mapStopReason(finishReason) : (sawToolUse ? "tool_use" : "end_turn");
  emit("message_delta", { type: "message_delta", delta: { stop_reason, stop_sequence: null },
    usage: { output_tokens: outputTokens } });
  emit("message_stop", { type: "message_stop" });
}
```

- [ ] **Step 4: 运行测试,确认通过**

Run: `npm test`
Expected: PASS — 新增 2 个 + 既有 = 43 通过。

- [ ] **Step 5: 提交**

```bash
git add src/anthropic.mjs test/anthropic.test.mjs
git commit -m "feat: anthropic streaming translation (streamAnthropicFromLines)"
```

---

## Task 4: countTokens + gpt-tokenizer 依赖

**Files:**
- Modify: `package.json`, `src/anthropic.mjs`
- Test: `test/anthropic.test.mjs`

- [ ] **Step 1: 安装依赖**

Run: `cd /Users/dingxiao/codex-copilot-dx && npm install gpt-tokenizer@^3.4.0`
Expected: package.json 的 dependencies 出现 `"gpt-tokenizer": "^3.4.0"`,生成 package-lock.json。

- [ ] **Step 2: 写失败测试 — 追加**

```javascript
import { countTokens } from "../src/anthropic.mjs";

test("countTokens: 返回正整数 input_tokens", () => {
  const r = countTokens({ model: "m", messages: [{ role: "user", content: "hello world how many tokens is this" }] });
  assert.equal(typeof r.input_tokens, "number");
  assert.ok(r.input_tokens > 0);
});

test("countTokens: 更多内容 → 更多 token(单调)", () => {
  const small = countTokens({ model: "m", messages: [{ role: "user", content: "hi" }] }).input_tokens;
  const big = countTokens({ model: "m", system: "you are a helpful assistant with many rules",
    tools: [{ name: "t", description: "a tool", input_schema: { type: "object", properties: { x: { type: "string" } } } }],
    messages: [{ role: "user", content: "hello world this is a much longer message with more tokens" }] }).input_tokens;
  assert.ok(big > small);
});

test("countTokens: 确定性(同输入同输出)", () => {
  const body = { model: "m", messages: [{ role: "user", content: "stable input" }] };
  assert.equal(countTokens(body).input_tokens, countTokens(body).input_tokens);
});
```

- [ ] **Step 3: 运行测试,确认失败**

Run: `npm test`
Expected: FAIL — `countTokens` 未导出。

- [ ] **Step 4: 实现 countTokens**

在 `src/anthropic.mjs` 顶部加 import:

```javascript
import { encode } from "gpt-tokenizer";
```

追加函数:

```javascript
// 用 gpt-tokenizer 对请求文本化后计 token。Copilot 上游无 count_tokens 端点，本地计算（与 copilot-api 一致）。
export function countTokens(body) {
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
        // image 不计入文本 token(其 token 由像素规模决定,此处省略,与近似策略一致)
      }
    }
  }

  if (Array.isArray(body.tools)) {
    for (const t of body.tools) {
      parts.push(t.name + (t.description || "") + JSON.stringify(t.input_schema || {}));
    }
  }

  const text = parts.join("\n");
  return { input_tokens: encode(text).length };
}
```

- [ ] **Step 5: 运行测试,确认通过**

Run: `npm test`
Expected: PASS — 新增 3 个 + 既有 = 46 通过。

- [ ] **Step 6: 提交**

```bash
git add package.json package-lock.json src/anthropic.mjs test/anthropic.test.mjs
git commit -m "feat: countTokens via gpt-tokenizer (exact token counting)"
```

---

## Task 5: adapter 路由 + 端到端验证

**Files:**
- Modify: `src/adapter.mjs`, `package.json`, `test/e2e.sh`

- [ ] **Step 1: adapter 顶部加 import**

读 `src/adapter.mjs`,在 import 区追加:

```javascript
import { anthropicToChat, chatToAnthropic, streamAnthropicFromLines, countTokens } from "./anthropic.mjs";
```

(`webStreamLines`、`chatCompletions` 已在 Task 6 引入,确认仍在。)

- [ ] **Step 2: 新增 POST /v1/messages/count_tokens 路由**

在 `createServer` 回调内、`GET /v1/models` 路由之后、404 fallthrough 之前,加入(放在更具体的 count_tokens 之前):

```javascript
if (req.method === "POST" && req.url?.startsWith("/v1/messages/count_tokens")) {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    try {
      const parsed = JSON.parse(body);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(countTokens(parsed)));
    } catch (e) {
      if (!res.headersSent) res.writeHead(400);
      res.end(JSON.stringify({ error: e.message }));
    }
  });
  return;
}
```

- [ ] **Step 3: 新增 POST /v1/messages 路由**

紧接其后加入(注意:此判断要在 count_tokens 之后,避免前缀误匹配 —— 因为 count_tokens 的 url 也以 `/v1/messages` 开头。用精确判断):

```javascript
if (req.method === "POST" && req.url === "/v1/messages") {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    try {
      const parsed = JSON.parse(body);
      const model = parsed.model || "unknown";
      console.log(`[codex-copilot-dx] messages ${model} stream=${!!parsed.stream}`);
      const chatReq = anthropicToChat(parsed);
      if (parsed.stream) {
        const upstream = await chatCompletions({ ...chatReq, stream: true });
        if (!upstream.ok) {
          if (!res.headersSent) res.writeHead(upstream.status);
          res.end(await upstream.text());
          return;
        }
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
        await streamAnthropicFromLines(
          webStreamLines(upstream),
          (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
          model,
        );
        if (!res.writableEnded) res.end();
      } else {
        const upstream = await chatCompletions({ ...chatReq, stream: false });
        const data = await upstream.text();
        const anthropicMsg = chatToAnthropic(JSON.parse(data), model);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(anthropicMsg));
      }
    } catch (e) {
      console.error("[codex-copilot-dx] messages error:", e.message);
      if (!res.headersSent) res.writeHead(400);
      res.end(JSON.stringify({ error: e.message }));
    }
  });
  return;
}
```

> 关键:`count_tokens` 路由用 `startsWith("/v1/messages/count_tokens")` 且**必须在** `/v1/messages` 精确匹配(`=== "/v1/messages"`)之前判断;两者不会冲突,因为一个是精确 `=== "/v1/messages"`,另一个是 `/v1/messages/count_tokens`。

- [ ] **Step 4: 语法检查 + 回归单测**

Run: `node --check src/adapter.mjs && npm test`
Expected: 46 pass(adapter 无新单测,确保没破坏既有)。

- [ ] **Step 5: bump 版本**

编辑 `package.json`:version `0.2.0` → `0.3.0`。

- [ ] **Step 6: 扩展 test/e2e.sh — 增 Anthropic 端点冒烟**

读 `test/e2e.sh`,在 kill 之前追加:

```bash
echo "=== 4. POST /v1/messages 非流式 ==="
curl -s -X POST "http://localhost:$PORT/v1/messages" \
  -H 'Content-Type: application/json' \
  -d '{"model":"claude-sonnet-4.5","max_tokens":50,"messages":[{"role":"user","content":"say OK"}]}' | head -c 400; echo

echo "=== 5. POST /v1/messages 流式 ==="
curl -s -N -X POST "http://localhost:$PORT/v1/messages" \
  -H 'Content-Type: application/json' \
  -d '{"model":"claude-sonnet-4.5","max_tokens":50,"stream":true,"messages":[{"role":"user","content":"say OK"}]}' 2>&1 | grep -aE "^event:" | head -10; echo

echo "=== 6. POST /v1/messages/count_tokens ==="
curl -s -X POST "http://localhost:$PORT/v1/messages/count_tokens" \
  -H 'Content-Type: application/json' \
  -d '{"model":"claude-sonnet-4.5","messages":[{"role":"user","content":"hello world how many tokens"}]}'; echo
```

- [ ] **Step 7: 执行端到端手测(真 token,独立端口)**

Run: `cd /Users/dingxiao/codex-copilot-dx && ADAPTER_PORT=4198 bash test/e2e.sh`
Expected:
- `/v1/messages` 非流式返回 `{"id":...,"type":"message","role":"assistant","content":[{"type":"text",...}],"stop_reason":"end_turn","usage":...}`
- 流式返回 `message_start → content_block_start → content_block_delta → content_block_stop → message_delta → message_stop`
- count_tokens 返回 `{"input_tokens":N}`
- 若上游对某模型报错,显示真实错误(数据/plan 问题,非代码缺陷)

> 对照基线:可同时对 4141 打同样请求,比对结构是否一致。

- [ ] **Step 8: 提交**

```bash
git add src/adapter.mjs package.json test/e2e.sh
git commit -m "feat: adapter /v1/messages + count_tokens routes, bump 0.3.0"
```

---

## Task 6: 真机验证(Claude Code 指向新版)

**Files:** 无(纯验证,需用户参与)

> 验证 Claude Code 实际连新版 adapter 工作。此步改 Claude Code 的 ANTHROPIC_BASE_URL 指向,需用户确认;可一键回滚。

- [ ] **Step 1: 起新版 adapter(独立端口,不碰 4141/4142)**

Run(后台):`cd /Users/dingxiao/codex-copilot-dx && ADAPTER_PORT=4143 node bin/cli.mjs`(或仅 startAdapter)
确认监听 4143。

- [ ] **Step 2: 对比验证 /v1/messages 与 4141 输出结构一致**

对 4143 与 4141 分别打相同的非流式 messages 请求,确认返回 JSON 结构字段一致(id/type/role/content/stop_reason/usage)。

- [ ] **Step 3: 让一个 Claude Code 会话指向 4143**

设置 `ANTHROPIC_BASE_URL=http://localhost:4143`(单会话环境变量,不改全局),启动一个 Claude Code 实例,执行:
- 多轮对话
- 一次工具调用(读文件 / 跑命令)
确认正常,无断流、无格式错误。

- [ ] **Step 4: 记录结果**

通过则记录;失败则保留 4141 兜底,回报具体错误。

---

## 自检结论

- **spec 覆盖**:anthropicToChat(system/text/image/tool_use/tool_result/tools/tool_choice)✓ T1;chatToAnthropic(text/tool_use/usage/stop_reason)✓ T2;流式事件序列✓ T3;count_tokens+gpt-tokenizer✓ T4;两个路由✓ T5;真机✓ T6。回归保护(不动现有路由、26 测试保持)✓ T5 Step4。成功标准 1-7 分别由 T2/T3/T3/T4/T6/T5/T4 覆盖。
- **占位符**:无 TBD;每步含完整代码。
- **命名一致**:anthropicToChat / chatToAnthropic / streamAnthropicFromLines / countTokens / mapStopReason / systemToText / toolResultContent / convertMessage / mapToolChoice / uid 在定义与调用处一致。
- **依赖**:仅 gpt-tokenizer(T4 引入),符合 spec C1。
- **路由顺序风险**:已显式说明 count_tokens(startsWith /v1/messages/count_tokens)与 messages(=== /v1/messages)不冲突。
