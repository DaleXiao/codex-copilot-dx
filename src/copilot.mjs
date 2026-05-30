import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";

const GITHUB_TOKEN_PATH = path.join(os.homedir(), ".local", "share", "copilot-api", "github_token");
export const DEFAULT_API_BASE = "https://api.githubcopilot.com";
let apiBase = DEFAULT_API_BASE;

export function parseApiBase(data) {
  return (data && data.endpoints && typeof data.endpoints.api === "string" && data.endpoints.api)
    ? data.endpoints.api
    : DEFAULT_API_BASE;
}

export function getApiBase() {
  return apiBase;
}
const GITHUB_API = "https://api.github.com";

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

export const FALLBACK_VSCODE_VERSION = "1.122.1";

let cachedVersion = FALLBACK_VSCODE_VERSION;

export function parseVSCodeVersion(json) {
  return (json && typeof json.productVersion === "string" && json.productVersion)
    ? json.productVersion
    : FALLBACK_VSCODE_VERSION;
}

export function getVSCodeVersion() {
  return cachedVersion;
}

// 启动时调用：异步抓最新版本，成功则替换缓存；失败静默保留 fallback。
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
  if (!data.token) throw new Error("Copilot token response missing token field");
  copilotToken = data.token;
  apiBase = parseApiBase(data);
  copilotTokenExpiry = typeof data.expires_at === "number"
    ? data.expires_at * 1000
    : Date.now() + 25 * 60 * 1000; // fallback if expires_at absent: refresh in ~25min
  console.log("[codex-copilot-dx] Copilot token refreshed");
  return copilotToken;
}

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
  return fetch(`${getApiBase()}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(chatReq),
  });
}

export async function listModels() {
  const token = await getCopilotToken();
  const headers = buildHeaders({
    token, version: getVSCodeVersion(), initiator: "user", vision: false,
  });
  const resp = await fetch(`${getApiBase()}/models`, { headers });
  return { status: resp.status, body: await resp.text() };
}

// 新模型（RESPONSES_ONLY）直连官方 /responses，返回 fetch Response。
export async function responses(reqBody) {
  const token = await getCopilotToken();
  const headers = buildHeaders({
    token,
    version: getVSCodeVersion(),
    initiator: "user",
    vision: false,
  });
  return fetch(`${getApiBase()}/responses`, {
    method: "POST",
    headers,
    body: JSON.stringify(reqBody),
  });
}
