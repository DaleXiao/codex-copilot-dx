import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
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
  const prefix = "reverse-proxy-installation", standard = "a".repeat(22);
  assert.deepEqual(parseBarkUrl(`https://bark.example/${prefix}/${standard}/title/body`),
    { endpoint: `https://bark.example/${prefix}/push`, deviceKey: standard });
  assert.deepEqual(parseBarkUrl(`https://bark.example/${prefix}/push?device_key=${key}`),
    { endpoint: `https://bark.example/${prefix}/push`, deviceKey: key });
  assert.throws(() => parseBarkUrl(`https://bark.example/${prefix}/${key}`), /ccdx_bark_invalid/);
  for (const invalid of ["https://bark.example", "file:///tmp/" + key, "https://user@bark.example/" + key, "https://bark.example/push"]) {
    assert.throws(() => parseBarkUrl(invalid), { message: "ccdx_bark_invalid" });
  }
});

test("the same Bark settings use Claude or Antigravity text and icon only after their own completion evidence", async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ccdx-bark-clients-"));
  const env = { CODEX_HOME: path.join(home, "codex"), XDG_CONFIG_HOME: path.join(home, "settings") };
  const claude = path.join(home, "Library", "Application Support", "Claude-3p", "claude-code-sessions", "workspace");
  const antigravity = path.join(home, ".gemini", "antigravity");
  await fs.mkdir(claude, { recursive: true });
  await fs.mkdir(antigravity, { recursive: true });
  const database = new DatabaseSync(path.join(antigravity, "conversation_summaries.db"));
  database.exec(`CREATE TABLE conversation_summaries (
    conversation_id TEXT PRIMARY KEY, status TEXT, not_fully_idle INTEGER, killed INTEGER, nesting_depth INTEGER,
    parent_conversation_id TEXT, last_user_input_step_index INTEGER, last_user_input_time TEXT, last_modified_time TEXT, step_count INTEGER
  )`);
  const update = database.prepare("INSERT OR REPLACE INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  let clock = Date.now();
  const old = clock - 3600000;
  const sessionId = "local_11111111-1111-1111-1111-111111111111";
  const claudeFile = path.join(claude, sessionId + ".json");
  const claudeTurn = (completedTurns, options = {}) => fs.writeFile(claudeFile, JSON.stringify({
    sessionId, createdAt: old, completedTurns, latestUserFrameAt: clock - 120000,
    lastTurnEdgeAt: clock, title: "local private preview", ...options,
  }));
  await claudeTurn(3, { lastTurnEdgeAt: old, latestUserFrameAt: old - 120000 });
  const keys = new Map(), pushes = [];
  const bark = createBarkNotifications({ env, home, platform: "darwin", now: () => clock, scanIntervalMs: 30,
    secretStore: { async get(ref) { return keys.get(ref); }, async set(ref, value) { keys.set(ref, value); } },
    async fetchImpl(_address, init) { pushes.push(JSON.parse(init.body));return Response.json({ code: 200 }); },
  });
  t.after(async () => { bark.close();database.close();await fs.rm(home, { recursive: true, force: true, maxRetries: 8 }); });
  await bark.save({ enabled: true, minutes: 1, title: "", body: "", url, language: "zh" });
  for (let attempt = 0; !bark.snapshot().watching && attempt < 60; attempt++) await delay(20);
  assert.deepEqual(bark.snapshot().sources, ["codex", "claude_app", "antigravity"]);

  const active = "22222222-2222-2222-2222-222222222222", failed = "33333333-3333-3333-3333-333333333333";
  const cancelled = "44444444-4444-4444-4444-444444444444", child = "55555555-5555-5555-5555-555555555555";
  clock += 1000;
  const finish = new Date(clock).toISOString(), start = new Date(clock - 120000).toISOString();
  const voice = (conversationId, { type = "PLANNER_RESPONSE", tools, status = "DONE" } = {}) => {
    const folder = path.join(antigravity, "brain", conversationId, ".system_generated", "logs");
    return fs.mkdir(folder, { recursive: true }).then(() => fs.writeFile(path.join(folder, "transcript.jsonl"),
      line({ type: "USER_INPUT", step_index: 0, created_at: start, content: "private user input" })
      + line({ type, status, source: "MODEL", step_index: 1, created_at: finish, content: "private reply", ...(tools ? { tool_calls: tools } : {}) })));
  };
  await Promise.all([voice(active), voice(failed, { type: "ERROR_MESSAGE" }), voice(cancelled), voice(child)]);
  const row = (id, { busy = 0, killed = 0, depth = 0, count = 2, parent = "" } = {}) =>
    update.run(id, "CASCADE_RUN_STATUS_IDLE", busy, killed, depth, parent, 0, start, finish, count);
  row(active, { busy: 1 });
  row(failed);
  row(cancelled, { killed: 1 });
  row(child, { parent: active });
  await claudeTurn(3); // A new user frame can move the turn timestamp before a successful result.
  await delay(200);
  assert.equal(pushes.length, 0);

  row(active, { count: 3 }); // The summary is ahead of the transcript.
  await claudeTurn(4, { lastTurnCutShort: true });
  await delay(200);
  assert.equal(pushes.length, 0);

  const longTranscript = path.join(antigravity, "brain", active, ".system_generated", "logs", "transcript.jsonl");
  await fs.writeFile(longTranscript, line({ type: "USER_INPUT", step_index: 0, created_at: start })
    + line({ type: "GENERIC", status: "DONE", step_index: 1, content: "x".repeat(1024 * 1024 + 64) })
    + line({ type: "PLANNER_RESPONSE", source: "MODEL", status: "DONE", step_index: 2, created_at: finish, content: "private reply" }));
  // Only the transcript changed after the earlier database update.
  clock += 1000;
  await claudeTurn(5);
  for (let attempt = 0; pushes.length < 2 && attempt < 60; attempt++) await delay(30);
  await delay(200);
  assert.equal(pushes.length, 2);
  const actual = Object.fromEntries(pushes.map(item => [item.title, item]));
  for (const [name, icon] of [["Claude", "claude-color.png"], ["Antigravity", "antigravity-color.png"]]) {
    const payload = actual[name + " 任务完成"];
    assert.ok(payload);
    assert.equal(payload.icon, "https://cdn.jsdelivr.net/npm/@lobehub/icons-static-png/light/" + icon);
    assert.equal(payload.body, "一个 " + name + " 任务已完成。");
  }
  assert.doesNotMatch(JSON.stringify(pushes), /private (user input|reply|preview)/);
});

test("Bark is opt-in, applies the minimum whole-turn duration and shares durable deduplication", async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ccdx-bark-"));
  const directory = path.join(home, "codex", "sessions", "2022", "11", "23");
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
  await assert.rejects(a.save({ enabled: true, minutes: 30, title, body, url: url.replace("https:", "http:") }), /ccdx_bark_https_required/);
  await a.save({ enabled: true, minutes: 30, title, body, url });
  for (let attempt = 0; !a.snapshot().watching && attempt < 20; attempt++) await delay(20);
  assert.equal(a.snapshot().watching, true);
  assert.equal(a.snapshot().configured, true);
  assert.doesNotMatch(JSON.stringify(a.snapshot()), /bark\.example|fixture-bark-device-key|ref/);
  assert.doesNotMatch(await fs.readFile(path.join(env.XDG_CONFIG_HOME, "codex-copilot-dx", "bark.json"), "utf8"), /bark\.example|fixture-bark-device-key/);
  b = createBarkNotifications(options);
  const ledger = path.join(env.XDG_CONFIG_HOME, "codex-copilot-dx", "bark-delivered.json");
  await fs.writeFile(ledger, "{corrupt");
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
  const [delivered] = JSON.parse(await fs.readFile(ledger, "utf8"));
  await fs.writeFile(ledger, JSON.stringify([null, delivered]));
  await fs.appendFile(file, event("long-task", 1800000) + event("another-task", 1800000));
  for (let attempt = 0; collected.length < 2 && attempt < 30; attempt++) await delay(50);
  assert.equal(collected.length, 2);
  const recovered = JSON.parse(await fs.readFile(ledger, "utf8"));
  assert.equal(recovered.length, 2);
  assert.ok(recovered.some(entry => entry.id === delivered.id));
  b.close();
  await fs.unlink(ledger);
  await fs.mkdir(ledger);
  await fs.appendFile(file, event("unwritable-ledger", 1800000));
  for (let attempt = 0; a.snapshot().delivery !== "ledger_failed" && attempt < 30; attempt++) await delay(50);
  assert.equal(a.snapshot().delivery, "ledger_failed");
  assert.equal(collected.length, 2);
  await a.save({ enabled: false, minutes: 5, title, body });
  await fs.appendFile(file, event("disabled", 3500000));
  await delay(300);
  assert.equal(collected.length, 2);
  assert.equal(a.snapshot().minutes, 5);
  assert.equal(a.snapshot().watching, false);
});

test("existing HTTP destinations still work and the newest Claude session survives the scan limit", async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ccdx-bark-old-address-"));
  const env = { XDG_CONFIG_HOME: path.join(home, "settings") };
  const folder = path.join(env.XDG_CONFIG_HOME, "codex-copilot-dx");
  const claude = path.join(home, "Library", "Application Support", "Claude-3p", "claude-code-sessions");
  await fs.mkdir(claude, { recursive: true });await fs.mkdir(folder, { recursive: true });
  const ref = "a".repeat(32);
  await fs.writeFile(path.join(folder, "bark.json"), JSON.stringify({ enabled: true, minutes: 0, title, body, ref }));
  const expires = new Date(Date.now() - 172800000);
  for (let offset = 0; offset < 4096; offset += 64) {
    await Promise.all(Array.from({ length: 64 }, async (_, at) => {
      const id = (at + offset + 1).toString(16).padStart(12, "0");
      const file = path.join(claude, "local_ffffffff-ffff-ffff-ffff-" + id + ".json");
      await fs.writeFile(file, "{}");await fs.utimes(file, expires, expires);
    }));
  }
  const started = Date.now(), pushes = [];
  const bark = createBarkNotifications({ env, home, platform: "darwin", now: () => started, scanIntervalMs: 100,
    secretStore: { async get() { return url.replace("https:", "http:"); } },
    async fetchImpl(destination) { pushes.push(destination);return Response.json({ code: 200 }); },
  });
  t.after(async () => { bark.close();await fs.rm(home, { recursive: true, force: true, maxRetries: 8 }); });
  const sessionId = "local_00000000-0000-0000-0000-000000000001";
  await fs.writeFile(path.join(claude, sessionId + ".json"), JSON.stringify({ sessionId, createdAt: started,
    completedTurns: 1, latestUserFrameAt: started, lastTurnEdgeAt: started + 1000 }));
  for (let attempt = 0; !pushes.length && attempt < 60; attempt++) await delay(80);
  assert.equal(bark.snapshot().insecure, true);
  assert.deepEqual(pushes, ["http://bark.example/push"]);
});
