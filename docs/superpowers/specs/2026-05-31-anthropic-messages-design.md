# /v1/messages 子系统设计(Anthropic Messages API 支持)

日期:2026-05-31
状态:已确认范围,待实现
前置:本设计建立在 all-in-one 重构(`2026-05-30-codex-copilot-dx-allinone-design.md`)之上,该重构已完成 Task 1-8。

## 背景

all-in-one 重构让新版 adapter 进程内服务 Codex(`/v1/responses`、`/v1/models`),并彻底移除了对 copilot-api 子进程(4141)的依赖。但实测发现:**Claude Code 同样依赖 4141**——它通过 `ANTHROPIC_BASE_URL=http://localhost:4141` 使用 Anthropic Messages API(`/v1/messages`、`/v1/messages/count_tokens`),而新版 adapter 未实现这些端点(404)。

因此,若关闭 4141,Claude Code 即断。本子系统补齐 Anthropic 端点,使新版 adapter **同时完整服务 Codex 与 Claude Code**,真正彻底告别 4141 与 copilot-api 包。

## 目标

在新版 adapter 中实现 Anthropic Messages API,使 Claude Code 可直接连新版 adapter:

- `POST /v1/messages`(流式 + 非流式)
- `POST /v1/messages/count_tokens`

完成后的能力矩阵:

| 端点 | 使用者 | 状态 |
|---|---|---|
| `GET /v1/models` | Codex + Claude Code | 已实现 |
| `POST /v1/responses` | Codex | 已实现 |
| `POST /v1/messages` | Claude Code | **本子系统新增** |
| `POST /v1/messages/count_tokens` | Claude Code | **本子系统新增** |

## 范围决策(已确认)

| 决策 | 选择 | 理由 |
|---|---|---|
| 中转路线 | **A1:Anthropic ⇄ OpenAI chat/completions ⇄ Anthropic** | 复用已实现且已验证的 `copilot.mjs` `chatCompletions()`;与 copilot-api 同款路线;Copilot 无原生 Anthropic 端点,无法直连 |
| 完整度 | **B2:全功能** | 彻底替代 copilot-api 服务 Claude Code,含 image、count_tokens,避免日后边角功能回归 |
| count_tokens 计数 | **C1:引入 `gpt-tokenizer`(精确)** | Claude Code 用 count_tokens 决定上下文压缩时机,需精确值;`gpt-tokenizer@3.4.0` 零传递依赖,纯数据包 |

> C1 是项目中唯一的运行时依赖。它随包发布,`npx` 拉取时一次性带上,不会触发交互确认。

## 架构

翻译层不碰网络,一律经现有 `copilot.mjs` `chatCompletions()` 打上游。这与 adapter 现有的 `responsesToChat`/`chatToResponses` 是同构模式,只是把 OpenAI 这一头换成 Anthropic。

```
Claude Code ──(Anthropic Messages API)──► adapter:/v1/messages
                                              │
                                anthropic.mjs: anthropicToChat()
                                              │ (OpenAI chat 请求)
                                              ▼
                                copilot.mjs: chatCompletions()  ──► api.*.githubcopilot.com/chat/completions
                                              │ (OpenAI 响应/SSE)
                                              ▼
                  非流式: chatToAnthropic()   流式: streamChatToAnthropic()
                                              │ (Anthropic 响应/SSE)
                                              ▼
                                          Claude Code
```

## 模块结构

| 文件 | 责任 |
|---|---|
| `src/anthropic.mjs` 【新】 | Anthropic ⇄ OpenAI 纯翻译函数 + count_tokens 计数 |
| `src/adapter.mjs` 【改】 | 新增路由:POST `/v1/messages`、POST `/v1/messages/count_tokens` |
| `package.json` 【改】 | `dependencies: { "gpt-tokenizer": "^3.4.0" }`;version 0.2.0 → 0.3.0 |
| `test/anthropic.test.mjs` 【新】 | 翻译纯函数单测 |

`anthropic.mjs` 导出:

```
anthropicToChat(body) -> openaiChatReq          请求翻译(含 system/tools/image/tool_use/tool_result)
chatToAnthropic(openaiResp, model) -> anthropicMessage   非流式响应翻译
streamChatToAnthropic(webResponse, emit, model)          流式翻译(OpenAI SSE → Anthropic SSE 事件)
countTokens(body) -> { input_tokens }           gpt-tokenizer 计数
mapStopReason(finishReason) -> anthropicStopReason
```

## 翻译规则(基于活体抓包 + copilot-api 源码)

### 请求:Anthropic → OpenAI(`anthropicToChat`)

| Anthropic 输入 | → OpenAI |
|---|---|
| 顶层 `system`(字符串) | `{role:"system", content: system}` |
| 顶层 `system`(text block 数组) | 各 block.text 以 `\n` 拼接为单条 system |
| `messages[].content`(字符串) | `{role, content: 字符串}` |
| content block `{type:"text"}` | text(多 block 时进 content 数组) |
| content block `{type:"image", source:{media_type, data}}` | `{type:"image_url", image_url:{url:`data:${media_type};base64,${data}`}}`,并触发 vision header |
| content block `{type:"tool_use", id, name, input}` | assistant `tool_calls:[{id, type:"function", function:{name, arguments: JSON.stringify(input)}}]` |
| content block `{type:"tool_result", tool_use_id, content}` | `{role:"tool", tool_call_id: tool_use_id, content: mapContent(content)}` |
| `tools[].input_schema` | `tools[].function.parameters` |
| `tool_choice` `auto`/`none` | 直接映射 |
| `tool_choice` `any` | `required` |
| `tool_choice` `{type:"tool", name}` | `{type:"function", function:{name}}` |
| `max_tokens` | `max_tokens`(透传) |
| `temperature`/`top_p`/`stop_sequences` | 对应 OpenAI 字段(stop_sequences→stop) |

> tool_result 的 content 可能是字符串或 block 数组;字符串直接用,数组中 text block 取 text、拼接。

### 非流式响应:OpenAI → Anthropic(`chatToAnthropic`)

| OpenAI 输出 | → Anthropic |
|---|---|
| `choices[0].message.content` | content block `{type:"text", text}` |
| `choices[0].message.tool_calls[]` | content block `{type:"tool_use", id, name, input: JSON.parse(arguments)}` |
| `finish_reason` | `stop_reason`(见 mapStopReason) |
| `usage.prompt_tokens - prompt_tokens_details.cached_tokens` | `usage.input_tokens` |
| `usage.completion_tokens` | `usage.output_tokens` |
| `usage.prompt_tokens_details.cached_tokens` | `usage.cache_read_input_tokens`(有则填) |

返回结构(抓包实证):
```json
{"id","type":"message","role":"assistant","model","content":[...],"stop_reason","stop_sequence":null,"usage":{...}}
```

### mapStopReason

| OpenAI finish_reason | Anthropic stop_reason |
|---|---|
| `stop` | `end_turn` |
| `tool_calls` | `tool_use` |
| `length` | `max_tokens` |
| 其它/缺失 | `end_turn`(兜底) |

> 当响应含 tool_calls 时优先 `tool_use`(copilot-api 行为)。

### 流式:OpenAI SSE → Anthropic SSE(`streamChatToAnthropic`)

抓包实证的事件序列:

```
message_start            (一次:message 骨架,content:[], usage 初值)
content_block_start      (text 块:{type:"text",text:""})
content_block_delta      ({type:"text_delta", text: delta.content})  ×N
content_block_stop
  ── 若有工具调用,关闭文本块后,每个工具:
content_block_start      ({type:"tool_use", id, name, input:{}}),index 递增
content_block_delta      ({type:"input_json_delta", partial_json: arguments 片段})  ×N
content_block_stop
message_delta            ({delta:{stop_reason, stop_sequence}, usage:{output_tokens}})
message_stop
```

状态机要点(对照 copilot.mjs 现有 forwardToChat 的 tool_calls 聚合):
- 维护 `contentBlockIndex`,文本块与每个 tool_use 块各占一个递增 index。
- 文本先到则先开 text 块;遇到第一个 tool_call 前先 `content_block_stop` 关闭文本块。
- tool_call 的 `id`+`name` 到达时开 `tool_use` 块;`arguments` 片段作为 `input_json_delta` 累积。
- 多个 tool_call 各自独立 index。
- 上游结束(`[DONE]` 或流尽)时:关闭当前块 → `message_delta`(带 stop_reason)→ `message_stop`。
- 兜底:上游未给 finish_reason 时,stop_reason 用 `end_turn`(若聚合到 tool_use 则用 `tool_use`)。

### count_tokens(`countTokens`)

- 用 `gpt-tokenizer` 对「system + 各 message content + tools 定义序列化」编码计 token。
- 返回 `{ input_tokens: N }`(抓包实证结构)。
- 计数策略:把请求按 anthropicToChat 同样的文本化规则拼成一个字符串(system 文本、各 message 文本、tool 名+描述+schema 的 JSON),用 tokenizer 的 `encode().length`。这是近似 Anthropic 计数但足够精确指导压缩(copilot-api 同样用 gpt-tokenizer 估算)。

> 说明:Copilot 上游无 count_tokens 端点,此为本地计算,与 copilot-api 一致。

## adapter.mjs 改动

新增两个路由(在现有 `/v1/responses`、`/v1/models` 路由旁,纯新增,不动现有逻辑):

```
POST /v1/messages:
  解析 body → anthropicToChat(body) → chatReq
  vision 检测沿用 copilot.mjs(messages 含 image_url 自动触发 header)
  if body.stream:
    resp = await chatCompletions({...chatReq, stream:true})
    streamChatToAnthropic(resp, (event,data)=>res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`), model)
  else:
    resp = await chatCompletions({...chatReq, stream:false})
    anthropicMsg = chatToAnthropic(await resp.json(), model)
    res.end(JSON.stringify(anthropicMsg))

POST /v1/messages/count_tokens:
  res.end(JSON.stringify(countTokens(body)))
```

错误处理与现有路径一致(502/400)。

## 回归保护

- 纯新增端点,**不触碰** `/v1/responses`、`/v1/models`、`/v1/chat/completions`(内部)、426 WS 处理、RESPONSES_ONLY 集合。
- 现有 26 单测必须保持通过。
- Codex 链路(gpt-5.5 直连、老模型转换)不受影响。

## 测试策略

- **纯函数单测**(anthropic.test.mjs):
  - anthropicToChat:system 字符串/数组、text、image、tool_use、tool_result、tools input_schema→parameters、tool_choice 映射。
  - chatToAnthropic:text 响应、tool_use 响应、stop_reason 映射、usage 映射。
  - mapStopReason:四种映射。
  - countTokens:给定输入返回稳定 input_tokens(断言 >0 且确定性)。
  - streamChatToAnthropic:喂入构造的 OpenAI SSE chunk(text 流、tool_call 流),断言产出的 Anthropic 事件序列与字段。
- **端到端手测**(扩展 e2e.sh 或新增):对 adapter 打 `/v1/messages`(流式/非流式/工具)、`/v1/messages/count_tokens`,对照 4141 的真实输出比对结构。
- **真机验证**:Claude Code 的 `ANTHROPIC_BASE_URL` 指向新版 adapter,实际对话 + 工具调用走通。

## 成功标准

1. `POST /v1/messages`(非流式)返回结构与 4141 一致:`{id,type:"message",role,model,content,stop_reason,usage}`。
2. `POST /v1/messages`(流式)产出 `message_start → content_block_* → message_delta → message_stop` 完整序列。
3. 工具调用:tool_use 块 + input_json_delta 累积正确,stop_reason=tool_use。
4. `POST /v1/messages/count_tokens` 返回 `{input_tokens:N}`,N 与请求规模正相关。
5. Claude Code 指向新版 adapter 后可正常多轮对话 + 工具调用。
6. Codex 链路无回归(现有 26 单测 + Codex 真机仍正常)。
7. `dependencies` 仅 `gpt-tokenizer` 一项。
