import { test } from "node:test";
import assert from "node:assert/strict";
import { computeUpdatedSettings } from "../src/claude-config.mjs";

test("computeUpdatedSettings: updates only ANTHROPIC_BASE_URL when env exists", () => {
  const before = { env: { ANTHROPIC_BASE_URL: "http://localhost:4141", ANTHROPIC_AUTH_TOKEN: "dummy" }, model: "claude-opus-4.8" };
  const { json, changed } = computeUpdatedSettings(before, 2026);
  assert.equal(json.env.ANTHROPIC_BASE_URL, "http://localhost:2026");
  assert.equal(json.env.ANTHROPIC_AUTH_TOKEN, "dummy");
  assert.equal(json.model, "claude-opus-4.8");
  assert.equal(changed, true);
});

test("computeUpdatedSettings: creates env when missing", () => {
  const { json, changed } = computeUpdatedSettings({ model: "x" }, 2026);
  assert.equal(json.env.ANTHROPIC_BASE_URL, "http://localhost:2026");
  assert.equal(json.env.ANTHROPIC_AUTH_TOKEN, "dummy");
  assert.equal(json.model, "x");
  assert.equal(changed, true);
});

test("computeUpdatedSettings: reports unchanged when already current", () => {
  const before = { env: { ANTHROPIC_BASE_URL: "http://localhost:2026", ANTHROPIC_AUTH_TOKEN: "dummy" } };
  const { changed } = computeUpdatedSettings(before, 2026);
  assert.equal(changed, false);
});

test("computeUpdatedSettings: preserves unrelated keys", () => {
  const before = { env: { ANTHROPIC_BASE_URL: "http://localhost:4141", FOO: "bar" }, hooks: { a: 1 }, permissions: { deny: ["WebSearch"] } };
  const { json } = computeUpdatedSettings(before, 2026);
  assert.equal(json.env.ANTHROPIC_AUTH_TOKEN, "dummy");
  assert.equal(json.env.FOO, "bar");
  assert.deepEqual(json.hooks, { a: 1 });
  assert.deepEqual(json.permissions, { deny: ["WebSearch"] });
});

test("computeUpdatedSettings: does not mutate input", () => {
  const before = { env: { ANTHROPIC_BASE_URL: "http://localhost:4141" } };
  computeUpdatedSettings(before, 2026);
  assert.equal(before.env.ANTHROPIC_BASE_URL, "http://localhost:4141");
});
