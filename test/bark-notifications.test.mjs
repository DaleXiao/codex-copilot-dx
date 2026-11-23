import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createBarkNotifications, parseBarkUrl } from "../src/bark-notifications.mjs";

const key = "fixture-bark-device-key";
const url = "https://bark.example/" + key;
const title = "Long task done", body = "A local Codex task finished.";
const line = value => JSON.stringify(value) + "\n";

test("Bark key URLs accept copied examples and keep the key out of the outgoing URL", () => {
  const expected = { endpoint: "https://bark.example/push", deviceKey: key };
  assert.deepEqual(parseBarkUrl(url), expected);
  assert.deepEqual(parseBarkUrl(url + "/title/body?group=example&ttl=600"), expected);
  assert.deepEqual(parseBarkUrl("http://bark.local:8080/bark/" + key), { endpoint: "http://bark.local:8080/bark/push", deviceKey: key });
  for (const invalid of ["https://bark.example", "file:///tmp/" + key, "https://user@bark.example/" + key, "https://bark.example/push"]) {
    assert.throws(() => parseBarkUrl(invalid), { message: "ccdx_bark_invalid" });
  }
});

test("Bark is opt-in, applies the minimum whole-turn duration and shares durable deduplication", async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ccdx-bark-"));
  const directory = path.join(home, "codex", "sessions", "2026", "11", "23");
  await fs.mkdir(directory, { recursive: true });
  const env = { CODEX_HOME: path.join(home, "codex"), XDG_CONFIG_HOME: path.join(home, "settings") };
  const collected = [], keys = new Map();
  const secretStore = { async get(ref) { return keys.get(ref); }, async set(ref, value) { keys.set(ref, value); }, async remove(ref) { keys.delete(ref); } };
  let clock = Date.now();
  const options = { env, home, secretStore, now: () => clock, scanIntervalMs: 30, async fetchImpl(address, init) {
    collected.push({ address, redirect: init.redirect, payload: JSON.parse(init.body) });
    return Response.json({ code: 200 });
  } };
  const a = createBarkNotifications(options);
  let b;
  t.after(async () => { a.close();b?.close();await fs.rm(home, { recursive: true, force: true, maxRetries: 3 }); });
  assert.equal(a.snapshot().minutes, 30);
  assert.equal(a.snapshot().watching, false);
  await assert.rejects(a.save({ enabled: true, minutes: 30, title, body }), /ccdx_bark_invalid/);
  await a.save({ enabled: true, minutes: 30, title, body, url });
  for (let attempt = 0; !a.snapshot().watching && attempt < 20; attempt++) await delay(20);
  assert.equal(a.snapshot().watching, true);
  assert.equal(a.snapshot().configured, true);
  assert.doesNotMatch(JSON.stringify(a.snapshot()), /bark\.example|fixture-bark-device-key|ref/);
  assert.doesNotMatch(await fs.readFile(path.join(env.XDG_CONFIG_HOME, "codex-copilot-dx", "bark.json"), "utf8"), /bark\.example|fixture-bark-device-key/);
  b = createBarkNotifications(options);
  const file = path.join(directory, "rollout-main.jsonl");
  const meta = line({ type: "session_meta", payload: { id: "session-1", source: "vscode" } });
  const event = (id, duration_ms, extra = {}, at = clock) => line({ type: "event_msg", timestamp: new Date(at).toISOString(),
    payload: { type: "task_complete", turn_id: id, root_turn_id: id, duration_ms, last_agent_message: "private synthetic answer", ...extra } });
  await fs.writeFile(file, meta + event("historical", 3600000, {}, clock - 10000));
  clock += 1000;
  await fs.appendFile(file, event("short", 1799999) + event("retried-model-request", 3600000, { type: "response.completed" })
    + event("failed", 1800000, { status: "failed" }) + event("aborted", 1800000, { last_agent_message: null })
    + event("subagent-turn", 1800000, { root_turn_id: "parent" }) + event("long-task", 1800000) + event("long-task", 1800000));
  const subagent = path.join(directory, "rollout-child.jsonl");
  await fs.writeFile(subagent, line({ type: "session_meta", payload: { id: "child", source: { subagent: "other" } } }) + event("child", 3600000));
  for (let attempt = 0; !collected.length && attempt < 60; attempt++) await delay(100);
  await delay(400);
  assert.equal(collected.length, 1);
  assert.deepEqual(collected[0], { address: "https://bark.example/push", redirect: "error",
    payload: { device_key: key, title, body, icon: "https://cdn.jsdelivr.net/npm/@lobehub/icons-static-png/light/codex-color.png", group: "CCDX" } });
  assert.ok([a.snapshot().delivery, b.snapshot().delivery].includes("sent"));
  b.close();
  await a.save({ enabled: false, minutes: 5, title, body });
  await fs.appendFile(file, event("disabled", 3500000));
  await delay(300);
  assert.equal(collected.length, 1);
  assert.equal(a.snapshot().minutes, 5);
  assert.equal(a.snapshot().watching, false);
});
