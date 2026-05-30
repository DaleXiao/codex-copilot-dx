# codex-copilot-dx All-in-One 设计

日期:2026-05-30
状态:已确认,待实现

## 背景与问题

`codex-copilot-dx` 当前是 `copilot-api` 的套壳工具,让 Codex Desktop 走 GitHub Copilot 订阅。它运行两个进程:

- **adapter（4142,dx 自己的）**:把 Codex 的 Responses API 协议翻译成 Copilot 能接受的形式。
- **copilot-api（4141,spawn 的子进程）**:提供 `/v1/chat/completions`、token 管理、device-flow auth。

实际链路:

```
Codex Desktop ──(Responses API)──► adapter:4142
   ├─ 新模型 gpt-5.x(RESPONSES_ONLY)──► 直连 api.githubcopilot.com/v1/responses（自管 token，不碰 4141）
   └─ 老模型 ──► 转 chat/completions ──► localhost:4141 ──► copilot-api ──► api.githubcopilot.com
```

**核心痛点**:新模型走 responses 直连,4141 可能长时间空闲;copilot-api 子进程被系统回收/崩溃后,dx 既不监控也不重启,切回老模型即 502（“4141 静默消失”）。

**次要痛点**:`npx codex-copilot-dx` 首次/缓存失效时触发 `copilot-api@latest` 下载,需手动按 `y` 确认。

## 目标

把双进程套壳改造成**单进程 all-in-one**:adapter 进程自己承接 chat/completions、`/v1/models`、device-flow auth，**彻底删除 `copilot-api` 依赖**。

附带收益:修复指纹老化（当前写死 `Editor-Version: vscode/1.90.0`）。

## 决策记录

经源码审计与逐项确认,已敲定:

| 决策 | 选择 | 理由 |
|---|---|---|
| 方案路线 | **A — 自己实现 chat/completions + /v1/models，删子进程** | copilot-api 无不可替代的“黑魔法”，脏活全部可确定性照搬，且根治 4141 问题 |
| Auth | **A1 — 自己实现 device flow，彻底删依赖** | 否则留 copilot-api 只为登录一次是尴尬尾巴，也没真正消除“按 y” |
| 代码风格 | 保持现有扁平 `src/*.mjs`，不引框架 | 与现状一致，零新增依赖 |
| VSCode 版本 | **启动时抓最新 + 稳妥 fallback** | 见下 |
| token 文件路径 | **保留老路径** `~/.local/share/copilot-api/github_token` | 已登录老用户无缝迁移，优先于命名洁癖 |
| auth 自动化 | **自动开浏览器 + 复制 user_code 到剪贴板** | 用 macOS 内置命令，零依赖；失败静默降级 |

## copilot-api 脏活审计（指导实现）

dx 当前未复刻、需要在 `copilot.mjs` 补齐的项：

1. **完整 headers**：`editor-plugin-version: copilot-chat/0.26.7`、`user-agent: GitHubCopilotChat/0.26.7`、`openai-intent: conversation-panel`、`x-github-api-version: 2025-04-01`、`x-request-id`（每请求 UUID）、`x-vscode-user-agent-library-version: electron-fetch`。dx 现仅发 4 个，且 `Editor-Version` 写死 `vscode/1.90.0`（老化指纹，滥用检测隐患）。
2. **`X-Initiator: agent | user`**：扫 messages，含 `assistant`/`tool` 角色 → `agent`，否则 `user`。
3. **`Copilot-Vision-Request: true`**：检测 message content 含 `image_url` 时加。
4. **动态 VSCode 版本**：见下（dx 写死 1.90.0）。
5. **`/v1/models` 端点**：Codex 启动会拉取；当前由 `proxyPassthrough` 转发 4141，需自实现（~15 行）。

无需复刻：`/v1/embeddings`、`/v1/messages`（Anthropic 格式）、usage dashboard、rate-limit、manual approve —— Codex 不使用。token 交换 dx 已自实现（惰性刷新，保留）。

## 模块结构

```
src/
  auth.mjs       【新增】device flow：请求 device code → 提示/开浏览器/复制 → 轮询 → 写 github_token
  copilot.mjs    【新增】上游客户端：token 交换/缓存、完整 headers、chat/completions 转发、listModels、动态版本
  adapter.mjs    【改】删除对 localhost:4141 的依赖，改调 copilot.mjs；新增 GET /v1/models
  launcher.mjs   【改】删除 startCopilotApi/findCopilotApi/isPortAccepting；ensureAuth 改调 auth.mjs
  config.mjs     【不变】
bin/cli.mjs      【改】删除 startCopilotApi 步骤与 copilotProc.kill()，移除 COPILOT_PORT
package.json     【改】dependencies 清空；version 0.1.5 → 0.2.0
docs/…           本设计文档
```

模块边界：`auth.mjs` 只负责“拿到并存 GitHub token”；`copilot.mjs` 只负责“用 token 跟官方 API 通信”；`adapter.mjs` 只负责“Responses ⇄ chat/completions 协议翻译”。三者经函数接口通信，可独立测试。

## copilot.mjs — 上游客户端

导出函数：

```
getCopilotToken()                    // GitHub token → Copilot token，内存缓存，惰性刷新（沿用现逻辑）
getVSCodeVersion()                   // 动态版本号，含 fallback
copilotHeaders({ vision, isAgent })  // 构造完整 headers
chatCompletions(chatReq) -> Response // POST 官方 /v1/chat/completions，返回 fetch Response
listModels() -> json                 // GET 官方 /v1/models
```

### headers 构造

```
Authorization: Bearer <copilotToken>
Content-Type: application/json
Copilot-Integration-Id: vscode-chat
Editor-Version: vscode/<动态版本>              // 不再写死 1.90.0
Editor-Plugin-Version: copilot-chat/0.26.7
User-Agent: GitHubCopilotChat/0.26.7
Openai-Intent: conversation-panel
X-Github-Api-Version: 2025-04-01
X-Request-Id: <每请求 randomUUID>
X-Vscode-User-Agent-Library-Version: electron-fetch
X-Initiator: agent | user                      // messages 含 assistant/tool → agent
Copilot-Vision-Request: true                   // 仅当检测到 image_url
```

`isAgent` 判定：`messages.some(m => ["assistant","tool"].includes(m.role))`
`vision` 判定：`messages.some(m => typeof m.content !== "string" && m.content?.some(p => p.type === "image_url"))`

### 动态 VSCode 版本

```
getVSCodeVersion():
  - 源：https://update.code.visualstudio.com/api/update/darwin-arm64/stable/latest
        （微软官方端点，字段 productVersion；比 AUR PKGBUILD 更稳妥）
  - 超时 5s，启动时异步抓一次，缓存内存
  - 成功 → json.productVersion（当前为 "1.122.1"）
  - 失败/超时 → fallback "1.122.1"（当前已知最新）
  - 不阻塞启动：先用 fallback 立即起服务，后台抓到后原子替换；抓不到一直用 fallback
  - 平台：headers 仅取版本号字符串，与下载平台无关，统一用 darwin-arm64 端点
```

## auth.mjs — GitHub Device Flow

替代 `copilot-api auth`。标准 OAuth device flow，仅用 node 内置 fetch 与 child_process。

```
CLIENT_ID = "Iv1.b507a08c87ecfe98"   // GitHub Copilot 官方公开 client_id（VSCode/copilot-api 同款）
SCOPE     = "read:user"
```

> client_id 是公开标识、非密钥，必须照搬——它决定换出的 GitHub token 具备 Copilot 权限。

流程：

```
ensureAuth():
  1. 若 ~/.local/share/copilot-api/github_token 存在 → 直接返回（兼容老用户）
  2. POST https://github.com/login/device/code
     body { client_id, scope } → { device_code, user_code, verification_uri, interval, expires_in }
  3. 提示用户：
     - 永远打印： "打开 https://github.com/login/device，输入码: XXXX-XXXX"
     - macOS：pbcopy 复制 user_code（打印“已复制到剪贴板”）+ open 打开 verification_uri
     - 非 macOS：仅文字提示
     - 自动化（open/pbcopy）全部 try/catch 静默兜底，失败绝不阻断登录
  4. 轮询 POST https://github.com/login/oauth/access_token
     body { client_id, device_code, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }
     每 interval 秒一次；处理 authorization_pending / slow_down（加长间隔）/ expired_token（报错退出）
     → access_token
  5. 写入 ~/.local/share/copilot-api/github_token（mkdir -p，权限 0600）
```

剪贴板/开浏览器实现（零依赖，macOS 内置命令，经 child_process）：

```
复制：  echo -n "XXXX-XXXX" | pbcopy
开浏览器：open <verification_uri>
```

## adapter.mjs 改动

```
删：forwardToChat 中写死的 localhost:COPILOT_API_PORT
删：proxyPassthrough（转发 4141 的兜底）
迁出：getGithubToken / getCopilotToken / proxyCopilotResponses → copilot.mjs
改：老模型路径 → 调 copilot.mjs.chatCompletions()，拿回 fetch Response 后做 SSE→Responses 转换
增：GET /v1/models → copilot.mjs.listModels()
留：responsesToChat / chatToResponses / processStream / WS 426 拒绝等协议翻译逻辑
```

> WS 426 拒绝逻辑保留：Codex Desktop 0.130+ 会尝试 responses_websockets 协议，拒绝 upgrade 让其回退到 HTTP SSE。

## bin/cli.mjs 改动

```
删：const copilotProc = await startCopilotApi(COPILOT_PORT)
删：SIGINT 中的 copilotProc?.kill()
删：启动日志中 "copilot-api: http://localhost:4141" 行
删：COPILOT_PORT 变量
留：ensureAuth → startAdapter → ensureCodexConfig → openCodex 顺序
```

## launcher.mjs 改动

```
删：startCopilotApi() / findCopilotApi() / isPortAccepting()（均为子进程服务）
改：ensureAuth() 改 import 自 auth.mjs
留：openCodex()
```

## package.json

```
dependencies: {}        // copilot-api 删除，无新增依赖
version: 0.1.5 → 0.2.0  // 架构变更，minor bump
```

## 测试策略

- **纯函数单测**：`responsesToChat`、`chatToResponses`、`copilotHeaders`（断言 X-Initiator / vision）、版本 fallback 逻辑。
- **端到端手测**：起 adapter → curl `/v1/models`；打老模型 `/v1/responses`（chat 路径）；打 gpt-5.x（responses 直连路径）；确认三条链路通。
- **auth 手测**：删 token 文件 → 跑一次 → 确认 device flow + 自动开浏览器 + 复制走通。
- 不写需真 GitHub token 的网络层自动化集成测试（CI 跑不了，性价比低）。

## 成功标准

1. `package.json` 的 dependencies 为空，源码无任何 `copilot-api` 引用。
2. 启动后无 4141 子进程；`lsof -i :4141` 无输出。
3. 三条链路（/v1/models、老模型、gpt-5.x）全部正常。
4. 全新环境（无 token 文件）首次运行能完成 device-flow 登录，自动开浏览器并复制 user_code。
5. headers 中 Editor-Version 为动态版本（或 fallback 1.122.1），且含 X-Initiator。
6. 老用户（已有 token 文件）升级后无需重新登录。
```
