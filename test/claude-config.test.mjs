import { test } from "node:test";
import assert from "node:assert/strict";
import { computeUpdatedSettings } from "../src/claude-config.mjs";

test("computeUpdatedSettings: 已有 env，只改 ANTHROPIC_BASE_URL", () => {
  const before = { env: { ANTHROPIC_BASE_URL: "http://localhost:4141", ANTHROPIC_AUTH_TOKEN: "dummy" }, model: "claude-opus-4.8" };
  const { json, changed } = computeUpdatedSettings(before, 8148);
  assert.equal(json.env.ANTHROPIC_BASE_URL, "http://localhost:8148");
  assert.equal(json.env.ANTHROPIC_AUTH_TOKEN, "dummy");
  assert.equal(json.model, "claude-opus-4.8");
  assert.equal(changed, true);
});

test("computeUpdatedSettings: 无 env 字段则创建", () => {
  const { json, changed } = computeUpdatedSettings({ model: "x" }, 8148);
  assert.equal(json.env.ANTHROPIC_BASE_URL, "http://localhost:8148");
  assert.equal(json.model, "x");
  assert.equal(changed, true);
});

test("computeUpdatedSettings: 已是目标端口则 changed=false", () => {
  const before = { env: { ANTHROPIC_BASE_URL: "http://localhost:8148" } };
  const { changed } = computeUpdatedSettings(before, 8148);
  assert.equal(changed, false);
});

test("computeUpdatedSettings: 不改动其它任意键", () => {
  const before = { env: { ANTHROPIC_BASE_URL: "http://localhost:4141", FOO: "bar" }, hooks: { a: 1 }, permissions: { deny: ["WebSearch"] } };
  const { json } = computeUpdatedSettings(before, 8148);
  assert.equal(json.env.FOO, "bar");
  assert.deepEqual(json.hooks, { a: 1 });
  assert.deepEqual(json.permissions, { deny: ["WebSearch"] });
});

test("computeUpdatedSettings: 不修改入参对象（纯函数）", () => {
  const before = { env: { ANTHROPIC_BASE_URL: "http://localhost:4141" } };
  computeUpdatedSettings(before, 8148);
  assert.equal(before.env.ANTHROPIC_BASE_URL, "http://localhost:4141");
});
