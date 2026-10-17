import test from "node:test";
import assert from "node:assert/strict";
import { createProviderRegistry, providerRegistry } from "../src/provider-registry.mjs";
import { createClaudeClientLifecycle } from "../src/claude-client-lifecycle.mjs";

test("source metadata supports a third internal source without changing protocol or client ownership", () => {
  const registry = createProviderRegistry([...providerRegistry.list(), { id: "fixture", name: "Fixture", codex: true, modelSelection: false }]);
  assert.equal(registry.get("fixture").name, "Fixture");assert.equal(providerRegistry.get("fixture"), undefined);
  registry.list().pop();assert.equal(registry.list().length, 3);
  assert.throws(() => { registry.get("fixture").id = "github"; }, TypeError);
  for (const definitions of [[{ id: "constructor", name: "Invalid" }], [{ id: "same", name: "A" }, { id: "same", name: "B" }], Array(17).fill({ id: "many", name: "Many" })]) assert.throws(() => createProviderRegistry(definitions));
});

test("Claude client lifecycle reports restore facts and preserves user-owned settings", async () => {
  let calls = 0;
  const lifecycle = createClaudeClientLifecycle({ options: {}, configureClients() { calls++;return { code: "configured", app: "preserved" }; }, restoreClients: () => ({ preserved: 1, remaining: 1 }) });
  const source = { models: () => [] };
  await lifecycle.sync({ source, apiKey: () => "fixture", current: () => false });assert.equal(calls, 0);
  await lifecycle.sync({ source, apiKey: () => "fixture" });assert.equal(calls, 1);
  assert.equal(lifecycle.snapshot().clients.app, "preserved");await lifecycle.restore();assert.equal(lifecycle.snapshot().clients.code, "preserved");
  const restored = createClaudeClientLifecycle({ options: {}, restoreClients: () => ({ preserved: 0 }) });
  await restored.restore();assert.equal(restored.snapshot().clients.app, "restored");
});
