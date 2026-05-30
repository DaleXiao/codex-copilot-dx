# codex-copilot-dx All-in-One 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 codex-copilot-dx 从「adapter + copilot-api 子进程」双进程套壳改造为单进程 all-in-one，彻底删除 copilot-api 依赖，并修复指纹老化。

**Architecture:** 新增 `src/copilot.mjs`(上游客户端:token 交换、完整 headers、chat/completions 转发、listModels、动态版本)与 `src/auth.mjs`(GitHub device flow)。adapter.mjs 删除对 localhost:4141 的依赖，改调 copilot.mjs;cli/launcher 删除子进程逻辑。所有上游通信经进程内 fetch。

**Tech Stack:** Node.js v26(原生 `node --test`、内置 fetch)、纯 ESM `.mjs`、零运行时依赖。

设计文档:`docs/superpowers/specs/2026-05-30-codex-copilot-dx-allinone-design.md`

---

## 文件结构

| 文件 | 责任 |
|---|---|
| `src/copilot.mjs` 【新】 | 上游客户端:`getCopilotToken`、`getVSCodeVersion`、`copilotHeaders`、`chatCompletions`、`listModels` |
| `src/auth.mjs` 【新】 | device flow:`ensureAuth` + 内部 `openAndCopy` |
| `src/stream.mjs` 【新】 | `webStreamLines(response)`:把 fetch Response 的 SSE body 拆成行(供 adapter 复用) |
| `src/adapter.mjs` 【改】 | 删 4141 依赖与 proxyPassthrough;chat 路径改调 copilot.mjs;新增 GET /v1/models |
| `src/launcher.mjs` 【改】 | 删 startCopilotApi/findCopilotApi/isPortAccepting;ensureAuth 改 import auth.mjs |
| `bin/cli.mjs` 【改】 | 删子进程启动与 kill,移除 COPILOT_PORT |
| `src/config.mjs` | 不变 |
| `test/*.test.mjs` 【新】 | 纯函数单测 |
| `test/e2e.sh` 【新】 | 端到端手测脚本 |

---

## Task 1: 测试脚手架 + copilotHeaders 纯函数

**Files:**
- Modify: `package.json`(加 test 脚本)
- Create: `src/copilot.mjs`
- Test: `test/copilot.test.mjs`

- [ ] **Step 1: 加 test 脚本到 package.json**

把 `package.json` 的顶层加入 `scripts`(放在 `"license"` 之后即可):

```json
  "scripts": {
    "test": "node --test"
  },
```

- [ ] **Step 2: 写失败测试 — copilotHeaders 的 X-Initiator 与 vision 判定**

Create `test/copilot.test.mjs`:

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeInitiator, computeVision, buildHeaders } from "../src/copilot.mjs";

test("computeInitiator: 纯 user 消息 → user", () => {
  const msgs = [{ role: "user", content: "hi" }];
  assert.equal(computeInitiator(msgs), "user");
});

test("computeInitiator: 含 assistant → agent", () => {
  const msgs = [{ role: "user", content: "hi" }, { role: "assistant", content: "yo" }];
  assert.equal(computeInitiator(msgs), "agent");
});

test("computeInitiator: 含 tool → agent", () => {
  const msgs = [{ role: "tool", content: "result" }];
  assert.equal(computeInitiator(msgs), "agent");
});

test("computeVision: 纯文本 → false", () => {
  assert.equal(computeVision([{ role: "user", content: "hi" }]), false);
});

test("computeVision: 含 image_url → true", () => {
  const msgs = [{ role: "user", content: [{ type: "image_url", image_url: { url: "x" } }] }];
  assert.equal(computeVision(msgs), true);
});

test("buildHeaders: 含全部指纹 header + Bearer token", () => {
  const h = buildHeaders({ token: "tok", version: "1.122.1", initiator: "agent", vision: true });
  assert.equal(h["Authorization"], "Bearer tok");
  assert.equal(h["Editor-Version"], "vscode/1.122.1");
  assert.equal(h["Editor-Plugin-Version"], "copilot-chat/0.26.7");
  assert.equal(h["User-Agent"], "GitHubCopilotChat/0.26.7");
  assert.equal(h["Openai-Intent"], "conversation-panel");
  assert.equal(h["X-Github-Api-Version"], "2025-04-01");
  assert.equal(h["Copilot-Integration-Id"], "vscode-chat");
  assert.equal(h["X-Vscode-User-Agent-Library-Version"], "electron-fetch");
  assert.equal(h["X-Initiator"], "agent");
  assert.equal(h["Copilot-Vision-Request"], "true");
  assert.ok(h["X-Request-Id"] && h["X-Request-Id"].length > 0);
});

test("buildHeaders: vision=false 不含 Copilot-Vision-Request", () => {
  const h = buildHeaders({ token: "tok", version: "1.122.1", initiator: "user", vision: false });
  assert.equal(h["Copilot-Vision-Request"], undefined);
  assert.equal(h["X-Initiator"], "user");
});
```

- [ ] **Step 3: 运行测试，确认失败**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/copilot.mjs'` 或导出未定义。

- [ ] **Step 4: 实现 copilot.mjs 的纯函数部分**

Create `src/copilot.mjs`:

```javascript
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";

const GITHUB_TOKEN_PATH = path.join(os.homedir(), ".local", "share", "copilot-api", "github_token");
const COPILOT_API = "https://api.githubcopilot.com";
const GITHUB_API = "https://api.github.com";
const FALLBACK_VSCODE_VERSION = "1.122.1";

export function computeInitiator(messages) {
  const isAgent = Array.isArray(messages)
    && messages.some((m) => m && ["assistant", "tool"].includes(m.role));
  return isAgent ? "agent" : "user";
}

export function computeVision(messages) {
  return Array.isArray(messages) && messages.some(
    (m) => m && typeof m.content !== "string"
      && Array.isArray(m.content)
      && m.content.some((p) => p && p.type === "image_url"),
  );
}

export function buildHeaders({ token, version, initiator, vision }) {
  const h = {
    "Authorization": `Bearer ${token}`,
    "Content-Type": "application/json",
    "Copilot-Integration-Id": "vscode-chat",
    "Editor-Version": `vscode/${version}`,
    "Editor-Plugin-Version": "copilot-chat/0.26.7",
    "User-Agent": "GitHubCopilotChat/0.26.7",
    "Openai-Intent": "conversation-panel",
    "X-Github-Api-Version": "2025-04-01",
    "X-Request-Id": randomUUID(),
    "X-Vscode-User-Agent-Library-Version": "electron-fetch",
    "X-Initiator": initiator,
  };
  if (vision) h["Copilot-Vision-Request"] = "true";
  return h;
}
```

- [ ] **Step 5: 运行测试，确认通过**

Run: `npm test`
Expected: PASS — 8 个测试全绿。

- [ ] **Step 6: 提交**

```bash
git add package.json src/copilot.mjs test/copilot.test.mjs
git commit -m "feat: copilot.mjs header/initiator/vision pure functions + test infra"
```

---

## Task 2: 动态 VSCode 版本(含 fallback)

**Files:**
- Modify: `src/copilot.mjs`
- Test: `test/copilot.test.mjs`

- [ ] **Step 1: 写失败测试 — parseVSCodeVersion 解析与 fallback**

在 `test/copilot.test.mjs` 末尾追加:

```javascript
import { parseVSCodeVersion, FALLBACK_VSCODE_VERSION } from "../src/copilot.mjs";

test("parseVSCodeVersion: 正常解析 productVersion", () => {
  assert.equal(parseVSCodeVersion({ productVersion: "1.122.1" }), "1.122.1");
});

test("parseVSCodeVersion: 缺字段 → fallback", () => {
  assert.equal(parseVSCodeVersion({}), FALLBACK_VSCODE_VERSION);
});

test("parseVSCodeVersion: null → fallback", () => {
  assert.equal(parseVSCodeVersion(null), FALLBACK_VSCODE_VERSION);
});

test("FALLBACK_VSCODE_VERSION 为已知最新", () => {
  assert.equal(FALLBACK_VSCODE_VERSION, "1.122.1");
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npm test`
Expected: FAIL — `parseVSCodeVersion` 与 `FALLBACK_VSCODE_VERSION` 未导出。

- [ ] **Step 3: 实现版本逻辑**

在 `src/copilot.mjs` 中,把 `const FALLBACK_VSCODE_VERSION = "1.122.1";` 改为导出,并新增解析函数与异步抓取 + 缓存:

```javascript
export const FALLBACK_VSCODE_VERSION = "1.122.1";

let cachedVersion = FALLBACK_VSCODE_VERSION;

export function parseVSCodeVersion(json) {
  return (json && typeof json.productVersion === "string")
    ? json.productVersion
    : FALLBACK_VSCODE_VERSION;
}

export function getVSCodeVersion() {
  return cachedVersion;
}

// 启动时调用:异步抓最新版本，成功则替换缓存；失败静默保留 fallback。
export async function refreshVSCodeVersion() {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const resp = await fetch(
      "https://update.code.visualstudio.com/api/update/darwin-arm64/stable/latest",
      { signal: ctrl.signal },
    );
    clearTimeout(timer);
    if (resp.ok) {
      cachedVersion = parseVSCodeVersion(await resp.json());
      console.log(`[codex-copilot-dx] VSCode version: ${cachedVersion}`);
    }
  } catch {
    // 静默保留 fallback
  }
  return cachedVersion;
}
```

> 注意:删掉文件顶部原来那行非导出的 `const FALLBACK_VSCODE_VERSION = "1.122.1";`,避免重复声明。

- [ ] **Step 4: 运行测试，确认通过**

Run: `npm test`
Expected: PASS — 新增 4 个测试通过,共 12 个绿。

- [ ] **Step 5: 提交**

```bash
git add src/copilot.mjs test/copilot.test.mjs
git commit -m "feat: dynamic VSCode version with fallback"
```

---

## Task 3: token 交换 + chatCompletions + listModels

**Files:**
- Modify: `src/copilot.mjs`

> 本任务是网络层封装,无法用真 token 单测(需 GitHub 登录),改由 Task 7 端到端手测覆盖。这里只写实现 + 提交。

- [ ] **Step 1: 实现 token 交换(从 adapter.mjs 迁移并整合)**

在 `src/copilot.mjs` 追加:

```javascript
let copilotToken = null;
let copilotTokenExpiry = 0;

function getGithubToken() {
  if (!fs.existsSync(GITHUB_TOKEN_PATH)) {
    throw new Error("GitHub token not found. Run the tool once to log in.");
  }
  return fs.readFileSync(GITHUB_TOKEN_PATH, "utf-8").trim();
}

export async function getCopilotToken() {
  if (copilotToken && Date.now() < copilotTokenExpiry - 60000) return copilotToken;
  const ghToken = getGithubToken();
  const resp = await fetch(`${GITHUB_API}/copilot_internal/v2/token`, {
    headers: { Authorization: `token ${ghToken}`, Accept: "application/json" },
  });
  if (!resp.ok) throw new Error(`Failed to get Copilot token: ${resp.status}`);
  const data = await resp.json();
  copilotToken = data.token;
  copilotTokenExpiry = data.expires_at * 1000;
  console.log("[codex-copilot-dx] Copilot token refreshed");
  return copilotToken;
}
```

- [ ] **Step 2: 实现 chatCompletions(返回 fetch Response)**

继续追加:

```javascript
// chatReq: OpenAI chat/completions 请求体（已由 adapter 从 Responses 转换好）。
// 返回原始 fetch Response（流式 body），由调用方解析。
export async function chatCompletions(chatReq) {
  const token = await getCopilotToken();
  const messages = chatReq.messages || [];
  const headers = buildHeaders({
    token,
    version: getVSCodeVersion(),
    initiator: computeInitiator(messages),
    vision: computeVision(messages),
  });
  return fetch(`${COPILOT_API}/v1/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(chatReq),
  });
}
```

- [ ] **Step 3: 实现 listModels 与 responses 直连(从 adapter 迁移)**

继续追加:

```javascript
export async function listModels() {
  const token = await getCopilotToken();
  const headers = buildHeaders({
    token, version: getVSCodeVersion(), initiator: "user", vision: false,
  });
  const resp = await fetch(`${COPILOT_API}/v1/models`, { headers });
  return { status: resp.status, body: await resp.text() };
}

// 新模型（RESPONSES_ONLY）直连官方 /v1/responses，返回 fetch Response。
export async function responses(reqBody) {
  const token = await getCopilotToken();
  const headers = buildHeaders({
    token,
    version: getVSCodeVersion(),
    initiator: "user",
    vision: false,
  });
  return fetch(`${COPILOT_API}/v1/responses`, {
    method: "POST",
    headers,
    body: JSON.stringify(reqBody),
  });
}
```

- [ ] **Step 4: 语法自检**

Run: `node --check src/copilot.mjs`
Expected: 无输出(语法 OK)。

- [ ] **Step 5: 提交**

```bash
git add src/copilot.mjs
git commit -m "feat: copilot token exchange, chatCompletions, listModels, responses"
```

---

## Task 4: stream.mjs — web stream 行拆分

**Files:**
- Create: `src/stream.mjs`
- Test: `test/stream.test.mjs`

> adapter 现有 `processStream` 消费 node IncomingMessage 的 `data` 事件。改用 copilot.mjs 后上游是 fetch Response(web ReadableStream)。本任务提供一个把 web stream 转成「逐行」异步迭代的工具,供 adapter 复用。

- [ ] **Step 1: 写失败测试 — webStreamLines 从 Response body 逐行产出**

Create `test/stream.test.mjs`:

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { webStreamLines } from "../src/stream.mjs";

function responseFrom(chunks) {
  const stream = new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(new TextEncoder().encode(ch));
      c.close();
    },
  });
  return new Response(stream);
}

test("webStreamLines: 跨 chunk 的行被正确拼接", async () => {
  const resp = responseFrom(["data: hel", "lo\n", "data: wor", "ld\n"]);
  const lines = [];
  for await (const line of webStreamLines(resp)) lines.push(line);
  assert.deepEqual(lines, ["data: hello", "data: world"]);
});

test("webStreamLines: 末尾无换行的残留行也产出", async () => {
  const resp = responseFrom(["a\n", "b"]);
  const lines = [];
  for await (const line of webStreamLines(resp)) lines.push(line);
  assert.deepEqual(lines, ["a", "b"]);
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/stream.mjs'`。

- [ ] **Step 3: 实现 webStreamLines**

Create `src/stream.mjs`:

```javascript
// 把 fetch Response 的 body 按 \n 拆成行，逐行 yield（保留 SSE 语义，调用方自行处理 data:/event:）。
export async function* webStreamLines(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop();
    for (const line of lines) yield line;
  }
  if (buf.length > 0) yield buf;
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `npm test`
Expected: PASS — 2 个新测试通过。

- [ ] **Step 5: 提交**

```bash
git add src/stream.mjs test/stream.test.mjs
git commit -m "feat: webStreamLines for parsing fetch Response SSE bodies"
```

---

## Task 5: auth.mjs — GitHub device flow

**Files:**
- Create: `src/auth.mjs`
- Test: `test/auth.test.mjs`

- [ ] **Step 1: 写失败测试 — pollResult 状态机解析**

Create `test/auth.test.mjs`:

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { interpretPoll } from "../src/auth.mjs";

test("interpretPoll: 拿到 access_token → done", () => {
  assert.deepEqual(interpretPoll({ access_token: "gho_x" }), { state: "done", token: "gho_x" });
});

test("interpretPoll: authorization_pending → wait", () => {
  assert.deepEqual(interpretPoll({ error: "authorization_pending" }), { state: "wait" });
});

test("interpretPoll: slow_down → slow", () => {
  assert.deepEqual(interpretPoll({ error: "slow_down" }), { state: "slow" });
});

test("interpretPoll: expired_token → fail", () => {
  assert.equal(interpretPoll({ error: "expired_token" }).state, "fail");
});

test("interpretPoll: 未知 error → fail", () => {
  assert.equal(interpretPoll({ error: "access_denied" }).state, "fail");
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/auth.mjs'`。

- [ ] **Step 3: 实现 auth.mjs**

Create `src/auth.mjs`:

```javascript
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";

const CLIENT_ID = "Iv1.b507a08c87ecfe98"; // GitHub Copilot 官方公开 client_id
const SCOPE = "read:user";
const GITHUB_TOKEN_PATH = path.join(os.homedir(), ".local", "share", "copilot-api", "github_token");

// 纯函数：把 GitHub poll 响应映射为状态。
export function interpretPoll(data) {
  if (data.access_token) return { state: "done", token: data.access_token };
  switch (data.error) {
    case "authorization_pending": return { state: "wait" };
    case "slow_down": return { state: "slow" };
    default: return { state: "fail", error: data.error || "unknown" };
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// macOS：复制 user_code 到剪贴板 + 打开验证页。失败静默降级。
function openAndCopy(userCode, verificationUri) {
  if (process.platform !== "darwin") return;
  try {
    const pb = spawn("pbcopy");
    pb.stdin.write(userCode);
    pb.stdin.end();
    console.log("[codex-copilot-dx] (user code 已复制到剪贴板)");
  } catch {}
  try {
    spawn("open", [verificationUri], { detached: true, stdio: "ignore" });
  } catch {}
}

export async function ensureAuth() {
  if (fs.existsSync(GITHUB_TOKEN_PATH)) {
    console.log("[codex-copilot-dx] GitHub token found");
    return;
  }
  console.log("[codex-copilot-dx] No GitHub token. Starting login...");

  // 1. 请求 device code
  const codeResp = await fetch("https://github.com/login/device/code", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ client_id: CLIENT_ID, scope: SCOPE }),
  });
  if (!codeResp.ok) throw new Error(`device code request failed: ${codeResp.status}`);
  const { device_code, user_code, verification_uri, interval } = await codeResp.json();

  // 2. 提示用户
  console.log(`\n  打开 ${verification_uri}\n  输入码: ${user_code}\n`);
  openAndCopy(user_code, verification_uri);

  // 3. 轮询
  let waitMs = (interval || 5) * 1000;
  while (true) {
    await sleep(waitMs);
    const pollResp = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        device_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });
    const data = await pollResp.json();
    const r = interpretPoll(data);
    if (r.state === "done") {
      writeToken(r.token);
      console.log("[codex-copilot-dx] Login successful");
      return;
    }
    if (r.state === "slow") { waitMs += 5000; continue; }
    if (r.state === "fail") throw new Error(`Login failed: ${r.error}`);
    // wait → 继续
  }
}

function writeToken(token) {
  fs.mkdirSync(path.dirname(GITHUB_TOKEN_PATH), { recursive: true });
  fs.writeFileSync(GITHUB_TOKEN_PATH, token, { mode: 0o600 });
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `npm test`
Expected: PASS — interpretPoll 的 5 个测试通过。

- [ ] **Step 5: 语法自检**

Run: `node --check src/auth.mjs`
Expected: 无输出。

- [ ] **Step 6: 提交**

```bash
git add src/auth.mjs test/auth.test.mjs
git commit -m "feat: GitHub device flow auth, removes copilot-api auth dependency"
```

---

## Task 6: 改造 adapter.mjs — 切到 copilot.mjs,新增 /v1/models

**Files:**
- Modify: `src/adapter.mjs`

> 现有 adapter.mjs 的协议翻译逻辑(responsesToChat / chatToResponses / processStream 的 SSE 事件生成 / WS 426)全部保留。本任务只把「数据来源」从 localhost:4141 切换到 copilot.mjs,并补 /v1/models。

- [ ] **Step 1: 顶部改 import,删除本地 token 函数**

在 `src/adapter.mjs` 顶部 import 区追加:

```javascript
import { chatCompletions, listModels, responses as copilotResponses, getCopilotToken } from "./copilot.mjs";
import { webStreamLines } from "./stream.mjs";
```

删除文件内这些已迁移到 copilot.mjs 的定义:`getGithubToken`、`getCopilotToken`、模块级 `copilotToken`/`copilotTokenExpiry`、`COPILOT_API`/`GITHUB_API` 常量。删除 `const COPILOT_API_PORT = ...` 这一行。

- [ ] **Step 2: 用 copilot.mjs.responses 替换 proxyCopilotResponses 的 fetch**

把 `proxyCopilotResponses` 函数体内对 `fetch(${COPILOT_API}/v1/responses, ...)` 的调用替换为 `await copilotResponses(reqBody)`,其余流转发逻辑不变。同理 `proxyCopilotResponsesWS` 内的 fetch 改为 `await copilotResponses({ ...reqBody, stream: true })`。删除这两个函数内原本的 `getCopilotToken()` 局部调用与手写 headers(已由 copilot.mjs 内部处理)。

- [ ] **Step 3: 重写 forwardToChat — 改用 fetch + webStreamLines**

把 `forwardToChat` 整个函数替换为(消费 copilot.mjs 的 fetch Response,逐行喂给原有事件生成逻辑):

```javascript
async function forwardToChat(chatReq, emitEvent, onDone, onError) {
  delete chatReq.max_tokens;
  let resp;
  try {
    resp = await chatCompletions({ ...chatReq, stream: true });
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

  emitEvent("response.created", { response: { id: respId, object: "response", status: "in_progress", model: actualModel, output: [] } });
  emitEvent("response.output_item.added", { output_index: 0, item: { type: "message", id: itemId, role: "assistant", status: "in_progress", content: [] } });
  emitEvent("response.content_part.added", { output_index: 0, content_index: 0, part: { type: "output_text", text: "" } });

  const emitCompleted = () => {
    if (!hasToolCalls) {
      emitEvent("response.output_text.done", { output_index: 0, content_index: 0, text: fullText });
      emitEvent("response.output_item.done", { output_index: 0, item: { type: "message", id: itemId, role: "assistant", status: "completed", content: [{ type: "output_text", text: fullText }] } });
    }
    const output = hasToolCalls
      ? Object.entries(toolCalls).map(([id, tc]) => ({ type: "function_call", id, call_id: id, name: tc.name, arguments: tc.arguments, status: "completed" }))
      : [{ type: "message", id: itemId, role: "assistant", status: "completed", content: [{ type: "output_text", text: fullText }] }];
    emitEvent("response.completed", { response: { id: respId, object: "response", status: "completed", model: actualModel, output, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } });
  };

  try {
    for await (const line of webStreamLines(resp)) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (data === "[DONE]") { emitCompleted(); onDone(); return; }
      let parsed;
      try { parsed = JSON.parse(data); } catch { continue; }
      if (parsed.model) actualModel = parsed.model;
      const delta = parsed.choices?.[0]?.delta;
      if (!delta) continue;
      if (delta.content) { fullText += delta.content; emitEvent("response.output_text.delta", { output_index: 0, content_index: 0, delta: delta.content }); }
      if (delta.tool_calls) {
        hasToolCalls = true;
        for (const tc of delta.tool_calls) {
          const id = tc.id || Object.keys(toolCalls)[tc.index] || `call_${tc.index}`;
          if (!toolCalls[id]) { toolCalls[id] = { name: "", arguments: "" }; emitEvent("response.output_item.added", { output_index: Object.keys(toolCalls).length - 1, item: { type: "function_call", id, call_id: id, name: tc.function?.name || "", arguments: "", status: "in_progress" } }); }
          if (tc.function?.name) toolCalls[id].name += tc.function.name;
          if (tc.function?.arguments) toolCalls[id].arguments += tc.function.arguments;
        }
      }
    }
    emitCompleted();
    onDone();
  } catch (e) {
    onError(500, e?.message || "upstream stream error");
  }
}
```

删除现已无用的旧 `processStream` 函数(其逻辑已内联进新 forwardToChat)。

- [ ] **Step 4: 非流式 chat 路径改用 chatCompletions**

在 `startAdapter` 的 POST `/v1/responses` 处理里,非流式分支原本用 `http.request` 连 4141。替换为:

```javascript
} else {
  chatReq.stream = false;
  delete chatReq.max_tokens;
  try {
    const upstream = await chatCompletions({ ...chatReq, stream: false });
    const data = await upstream.text();
    const resp = chatToResponses(JSON.parse(data), model);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(resp));
  } catch (e) {
    if (!res.headersSent) res.writeHead(502);
    res.end("Bad Gateway");
  }
}
```

- [ ] **Step 5: 新增 GET /v1/models 路由,删除 proxyPassthrough**

在 `startAdapter` 的 `http.createServer((req, res) => {...})` 内,POST `/v1/responses` 分支之后、`proxyPassthrough(req, res)` 之前,加入:

```javascript
if (req.method === "GET" && req.url?.startsWith("/v1/models")) {
  listModels()
    .then(({ status, body }) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(body); })
    .catch((e) => { if (!res.headersSent) res.writeHead(502); res.end(JSON.stringify({ error: e.message })); });
  return;
}
```

然后删除函数末尾的 `proxyPassthrough(req, res);` 调用与 `proxyPassthrough` 函数定义。把原来落到 passthrough 的兜底改为 404:

```javascript
res.writeHead(404, { "Content-Type": "application/json" });
res.end(JSON.stringify({ error: "Not found" }));
```

- [ ] **Step 6: 删除 import http 中已不需要的部分,语法自检**

确认文件顶部不再用到 `https`(若原先 import 了)。`http` 仍用于 createServer,保留。

Run: `node --check src/adapter.mjs`
Expected: 无输出。

- [ ] **Step 7: 跑单测确保未破坏纯函数**

Run: `npm test`
Expected: PASS — 之前所有测试仍绿。

- [ ] **Step 8: 提交**

```bash
git add src/adapter.mjs
git commit -m "refactor: adapter uses in-process copilot client, removes 4141 dependency"
```

---

## Task 7: 改造 launcher.mjs 与 bin/cli.mjs — 删子进程

**Files:**
- Modify: `src/launcher.mjs`
- Modify: `bin/cli.mjs`

- [ ] **Step 1: 精简 launcher.mjs**

把 `src/launcher.mjs` 整个替换为(只留 ensureAuth 转发 + openCodex):

```javascript
import { spawn } from "node:child_process";

export { ensureAuth } from "./auth.mjs";

export function openCodex() {
  if (process.platform === "darwin") {
    try {
      spawn("open", ["/Applications/Codex.app"], { detached: true, stdio: "ignore" });
      console.log("[codex-copilot-dx] Codex app launched");
    } catch {
      console.log("[codex-copilot-dx] Codex app not found at /Applications/Codex.app");
      console.log("  Download from: https://openai.com/codex");
    }
  } else {
    console.log("[codex-copilot-dx] Auto-launch not supported on this platform.");
    console.log("  Open Codex manually, it will connect to the adapter.");
  }
}
```

> 删除了 startCopilotApi / findCopilotApi / isPortAccepting / GITHUB_TOKEN_PATH / 旧 ensureAuth(shell 调 copilot-api 的版本)。

- [ ] **Step 2: 精简 bin/cli.mjs**

把 `bin/cli.mjs` 替换为:

```javascript
#!/usr/bin/env node

import { ensureAuth, openCodex } from "../src/launcher.mjs";
import { ensureCodexConfig } from "../src/config.mjs";
import { startAdapter } from "../src/adapter.mjs";
import { refreshVSCodeVersion } from "../src/copilot.mjs";

const ADAPTER_PORT = parseInt(process.env.ADAPTER_PORT || "4142");

console.log(`
  codex-copilot-dx
  Use Codex Desktop with GitHub Copilot
`);

try {
  // 1. 确保 GitHub 登录（无 token 则走 device flow）
  await ensureAuth();

  // 2. 后台异步抓取最新 VSCode 版本（不阻塞，失败用 fallback）
  refreshVSCodeVersion();

  // 3. 启动进程内 adapter
  await startAdapter(ADAPTER_PORT);

  // 4. 配置 Codex
  ensureCodexConfig(ADAPTER_PORT);

  // 5. 启动 Codex
  openCodex();

  console.log(`
  Ready! Codex is using your GitHub Copilot subscription.

  Adapter: http://localhost:${ADAPTER_PORT}

  Press Ctrl+C to stop.
`);

  process.on("SIGINT", () => {
    console.log("\nShutting down...");
    process.exit(0);
  });
} catch (e) {
  console.error(`Error: ${e.message}`);
  process.exit(1);
}
```

> 删除:COPILOT_PORT、startCopilotApi 调用、copilotProc 与 SIGINT 里的 kill、启动日志的 copilot-api 行。

- [ ] **Step 3: 语法自检**

Run: `node --check src/launcher.mjs && node --check bin/cli.mjs`
Expected: 无输出。

- [ ] **Step 4: 提交**

```bash
git add src/launcher.mjs bin/cli.mjs
git commit -m "refactor: remove copilot-api child process, single-process startup"
```

---

## Task 8: 清空依赖 + 版本号 + 端到端验证

**Files:**
- Modify: `package.json`
- Create: `test/e2e.sh`

- [ ] **Step 1: 清空 dependencies,bump 版本**

编辑 `package.json`:把 `"dependencies": { "copilot-api": "^0.7.0" }` 改为 `"dependencies": {}`;把 `"version": "0.1.5"` 改为 `"version": "0.2.0"`。

- [ ] **Step 2: 重装确认无依赖,删除旧 node_modules**

Run: `rm -rf node_modules package-lock.json && npm install`
Expected: 安装 0 个依赖(或仅 dev,无 copilot-api)。

- [ ] **Step 3: 确认源码无 copilot-api 残留引用**

Run: `grep -rn "copilot-api\|4141\|COPILOT_API_PORT\|startCopilotApi\|proxyPassthrough" src/ bin/ || echo "CLEAN"`
Expected: `CLEAN`(token 文件路径 `~/.local/share/copilot-api/` 在 auth.mjs/copilot.mjs 中是合法保留,若 grep 命中这些路径行属预期,人工确认仅剩路径字符串)。

- [ ] **Step 4: 全量单测**

Run: `npm test`
Expected: PASS — copilot/stream/auth 全部测试绿。

- [ ] **Step 5: 写端到端手测脚本**

Create `test/e2e.sh`:

```bash
#!/usr/bin/env bash
# 手动端到端验证。前提：已登录（~/.local/share/copilot-api/github_token 存在）。
set -e
PORT="${ADAPTER_PORT:-4142}"

echo "=== 启动 adapter（后台）==="
ADAPTER_PORT="$PORT" node -e "import('./src/adapter.mjs').then(m=>m.startAdapter($PORT))" &
PID=$!
sleep 1

echo "=== 1. GET /v1/models ==="
curl -s "http://localhost:$PORT/v1/models" | head -c 300; echo

echo "=== 2. 老模型 chat 路径（gpt-4o，流式）==="
curl -s -X POST "http://localhost:$PORT/v1/responses" \
  -H 'Content-Type: application/json' \
  -d '{"model":"gpt-4o","stream":true,"input":"say hi in one word"}' | head -c 300; echo

echo "=== 3. 确认无 4141 子进程 ==="
lsof -i :4141 && echo "FAIL: 4141 在监听" || echo "OK: 无 4141"

kill $PID 2>/dev/null || true
echo "=== done ==="
```

- [ ] **Step 6: 执行端到端手测**

Run: `bash test/e2e.sh`
Expected: /v1/models 返回模型 JSON;老模型路径返回 SSE 事件流;最后打印 `OK: 无 4141`。

> 若 gpt-5.x 可用,可另测 responses 直连路径:把 model 换成 `gpt-5.5` 重复第 2 步,确认返回 response.* 事件。

- [ ] **Step 7: 提交**

```bash
git add package.json package-lock.json test/e2e.sh
git commit -m "chore: zero runtime deps, bump to 0.2.0, add e2e test script"
```

---

## Task 9: auth 全流程手测(全新环境)

**Files:** 无(纯验证)

- [ ] **Step 1: 备份并移除 token,模拟全新用户**

Run: `mv ~/.local/share/copilot-api/github_token /tmp/ghtoken.bak`
Expected: token 文件移走。

- [ ] **Step 2: 运行 device flow**

Run: `node -e "import('./src/auth.mjs').then(m=>m.ensureAuth())"`
Expected:
- 打印验证 URL 与 user code
- macOS 下浏览器自动打开 `github.com/login/device`,剪贴板含 user code(`pbpaste` 可验证)
- 输码授权后,打印 `Login successful`,token 文件重新生成

- [ ] **Step 3: 确认 token 写入且权限正确**

Run: `ls -l ~/.local/share/copilot-api/github_token`
Expected: 文件存在,权限 `-rw-------`(0600)。

- [ ] **Step 4: 清理备份(若新登录成功则备份可删,否则恢复)**

成功:`rm /tmp/ghtoken.bak`
失败回滚:`mv /tmp/ghtoken.bak ~/.local/share/copilot-api/github_token`

- [ ] **Step 5: 最终全链路冒烟**

Run: `node bin/cli.mjs`(Ctrl+C 退出前观察)
Expected: 无报错启动,日志显示 Adapter listening、VSCode version、Codex launched;`lsof -i :4141` 无输出。

---

## 自检结论

- **spec 覆盖**:token 交换✓(T3)、完整 headers✓(T1)、X-Initiator✓(T1)、vision✓(T1)、动态版本+fallback✓(T2)、device flow✓(T5)、/v1/models✓(T6)、删子进程✓(T7)、清依赖✓(T8)、老用户兼容✓(T5 Step3 路径保留)、自动开浏览器+复制✓(T5)、成功标准 1-6 分别由 T8/T7/T8/T9/T1+T2/T9 覆盖。
- **占位符**:无 TBD/TODO;每个代码步骤含完整代码。
- **类型/命名一致性**:`chatCompletions`/`listModels`/`responses`/`getVSCodeVersion`/`buildHeaders`/`computeInitiator`/`computeVision`/`webStreamLines`/`ensureAuth`/`interpretPoll` 在定义与调用处命名一致。
```
