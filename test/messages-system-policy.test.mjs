import test from "node:test";
import assert from "node:assert/strict";
import { applyMessagesSystemPolicy } from "../src/messages-system-policy.mjs";

test("native Messages preserve growing inline instructions, cache boundaries and signed history", () => {
  const mark = { type: "ephemeral", ttl: "1h" };
  const first = { system: [{ type: "text", text: "fixed", cache_control: mark }], tools: [{ name: "read" }], messages: [
    { role: "system", content: "opening" }, { role: "user", content: [{ type: "text", text: "request", cache_control: mark }] },
    { role: "system", content: "first reminder" }, { role: "assistant", content: [{ type: "thinking", thinking: "kept", signature: "sealed" }, { type: "text", text: "reply" }] },
  ] };
  const second = { ...first, messages: [...first.messages, { role: "user", content: "next" }, { role: "system", content: "new reminder" }] };
  const before = structuredClone(first), a = applyMessagesSystemPolicy(first, "native"), b = applyMessagesSystemPolicy(second, "native");
  assert.deepEqual(a.system, b.system);assert.deepEqual(a.tools, b.tools);
  assert.deepEqual(a.messages, b.messages.slice(0, a.messages.length));assert.deepEqual(first, before);
  assert.equal(a.messages[1], first.messages[2]);assert.equal(a.messages[2], first.messages[3]);
  assert.equal(a.messages[0].content[0].cache_control, mark);
});

test("explicit legacy policy retains existing custom API compatibility independently from aliases", () => {
  const body = { messages: [{ role: "user", content: "question" }, { role: "system", content: "legacy" }] };
  const result = applyMessagesSystemPolicy(body, "legacy");
  assert.deepEqual(result.system, [{ type: "text", text: "legacy" }]);assert.deepEqual(result.messages, [body.messages[0]]);
  assert.equal(applyMessagesSystemPolicy(body), body);
  assert.throws(() => applyMessagesSystemPolicy({ messages: [{ role: "system", content: [{ type: "image" }] }] }, "legacy"), { code: "ccdx_messages_system_invalid" });
});
