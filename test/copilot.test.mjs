import { test } from "node:test";
import assert from "node:assert/strict";
import { computeInitiator, computeVision, buildHeaders, parseVSCodeVersion, FALLBACK_VSCODE_VERSION } from "../src/copilot.mjs";

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

test("parseVSCodeVersion: 空字符串 → fallback", () => {
  assert.equal(parseVSCodeVersion({ productVersion: "" }), FALLBACK_VSCODE_VERSION);
});

import { parseApiBase, DEFAULT_API_BASE } from "../src/copilot.mjs";

test("parseApiBase: 读取 endpoints.api", () => {
  assert.equal(parseApiBase({ endpoints: { api: "https://api.enterprise.githubcopilot.com" } }),
    "https://api.enterprise.githubcopilot.com");
});

test("parseApiBase: 缺 endpoints → 默认", () => {
  assert.equal(parseApiBase({}), DEFAULT_API_BASE);
});

test("parseApiBase: endpoints 无 api 字段 → 默认", () => {
  assert.equal(parseApiBase({ endpoints: {} }), DEFAULT_API_BASE);
});

test("DEFAULT_API_BASE 为个人版 host", () => {
  assert.equal(DEFAULT_API_BASE, "https://api.githubcopilot.com");
});
