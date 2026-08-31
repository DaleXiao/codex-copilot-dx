import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { countTokens } from "../src/anthropic.mjs";
import {
  createTokenCounterService,
  tokenCounterWorkerDiagnostic,
} from "../src/token-counter-service.mjs";

class FakeWorker extends EventEmitter {
  messages = [];
  terminated = false;
  unref() {}
  postMessage(message) { this.messages.push(message); }
  terminate() { this.terminated = true; return Promise.resolve(0); }
  reply(index = 0, result = { input_tokens: 1 }) {
    this.emit("message", { id: this.messages[index].id, result });
  }
}

test("token counter worker diagnostics are bounded and exclude raw messages", () => {
  const diagnostic = tokenCounterWorkerDiagnostic("worker", {
    name: "Error",
    code: "ERR_MODULE_NOT_FOUND",
    message: "Authorization: Bearer secret-token /private/user/path",
  });
  assert.equal(diagnostic, "Token counter worker failure: phase=worker name=Error code=ERR_MODULE_NOT_FOUND");
  assert.doesNotMatch(diagnostic, /secret-token|private\/user|Authorization/);

  const hostile = tokenCounterWorkerDiagnostic("secret phase", {
    name: "BearerSecret",
    code: "github_pat_FAKE_SECRET_VALUE",
  });
  assert.equal(hostile, "Token counter worker failure: phase=unknown name=Error code=unknown");

  const hostileGetters = tokenCounterWorkerDiagnostic("worker", {
    get name() { throw new Error("secret name getter"); },
    get code() { throw new Error("secret code getter"); },
  });
  assert.equal(hostileGetters, "Token counter worker failure: phase=worker name=Error code=unknown");
});

test("token counter worker preserves the established count and keeps the event loop responsive", async (t) => {
  const service = createTokenCounterService();
  t.after(() => service.close());
  const mixed = {
    model: "m",
    system: [{ type: "text", text: "system rule" }],
    messages: [{ role: "user", content: [
      { type: "text", text: "hello 世界" },
      { type: "tool_use", name: "lookup", input: { q: "value" } },
      { type: "tool_result", content: "done" },
    ] }],
    tools: [{ name: "lookup", description: "find value", input_schema: {
      type: "object", properties: { q: { type: "string" } },
    } }],
  };
  assert.deepEqual(await service.count(mixed), await countTokens(mixed));
  assert.equal((await service.count(mixed)).input_tokens, 31);

  let heartbeats = 0;
  const interval = setInterval(() => { heartbeats += 1; }, 5);
  await service.count({ messages: [{ role: "user", content: "a".repeat(16 * 1024) }] });
  clearInterval(interval);
  assert.ok(heartbeats >= 2, `expected worker isolation, observed ${heartbeats} heartbeats`);
});

test("token counter worker starts when the parent uses --input-type=module", () => {
  const moduleUrl = new URL("../src/token-counter-service.mjs", import.meta.url).href;
  const script = `
    import { createTokenCounterService } from ${JSON.stringify(moduleUrl)};
    const service = createTokenCounterService();
    try { console.log(JSON.stringify(await service.count({ messages: [{ role: "user", content: "hello" }] }))); }
    finally { service.close(); }
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(JSON.parse(result.stdout).input_tokens > 0);
});

test("token counter classifies invalid request structure before worker execution", async () => {
  const service = createTokenCounterService({ workerFactory: () => assert.fail("invalid input must not start a worker") });
  await assert.rejects(service.count(null), (error) => error.statusCode === 400
    && error.message === "Invalid count_tokens request");
  service.close();
});

test("token counter projects only counted text before crossing the worker boundary", async () => {
  const worker = new FakeWorker();
  const service = createTokenCounterService({ workerFactory: () => worker });
  const secretImage = "ignored-image-payload".repeat(1024);
  const pending = service.count({
    ignored: secretImage,
    messages: [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", data: secretImage } },
        { type: "text", text: "count me" },
      ],
    }],
  });
  assert.deepEqual(worker.messages[0], { id: 1, text: "count me" });
  assert.equal(JSON.stringify(worker.messages[0]).includes(secretImage), false);
  worker.reply(0, { input_tokens: 2 });
  assert.deepEqual(await pending, { input_tokens: 2 });
  service.close();
});

test("token counter timeout terminates the active worker and the next job uses a fresh worker", async () => {
  const workers = [];
  const service = createTokenCounterService({
    timeoutMs: 10,
    workerFactory: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
  });
  await assert.rejects(service.count({}), (error) => error.statusCode === 504);
  assert.equal(workers[0].terminated, true);

  const next = service.count({}, { deadlineMs: 100 });
  workers[1].reply(0, { input_tokens: 7 });
  assert.deepEqual(await next, { input_tokens: 7 });
  service.close();
});

test("token counter removes queued aborts and rejects work beyond its bounded FIFO", async () => {
  const worker = new FakeWorker();
  const service = createTokenCounterService({ maxQueued: 2, workerFactory: () => worker });
  const active = service.count({}, { deadlineMs: 1000 });
  const controller = new AbortController();
  const queuedAbort = service.count({}, { signal: controller.signal, deadlineMs: 1000 });
  const queued = service.count({}, { deadlineMs: 1000 });
  await assert.rejects(service.count({}), (error) => error.statusCode === 503);
  controller.abort();
  await assert.rejects(queuedAbort, (error) => error.name === "AbortError");
  assert.equal(service.stats().queued, 1);
  worker.reply(0, { input_tokens: 1 });
  assert.deepEqual(await active, { input_tokens: 1 });
  worker.reply(1, { input_tokens: 2 });
  assert.deepEqual(await queued, { input_tokens: 2 });
  service.close();
  assert.deepEqual(service.stats(), { active: 0, queued: 0, worker: 0 });
});

test("token counter abort terminates active work and recovers", async () => {
  const workers = [];
  const service = createTokenCounterService({ workerFactory: () => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker;
  } });
  const controller = new AbortController();
  const aborted = service.count({}, { signal: controller.signal });
  controller.abort();
  await assert.rejects(aborted, (error) => error.name === "AbortError");
  assert.equal(workers[0].terminated, true);
  const recovered = service.count({});
  workers[1].reply(0, { input_tokens: 4 });
  assert.deepEqual(await recovered, { input_tokens: 4 });
  service.close();
});

test("token counter contains a worker crash and recovers on the next job", async () => {
  const workers = [];
  const service = createTokenCounterService({ workerFactory: () => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker;
  } });
  const failed = service.count({});
  workers[0].emit("error", new Error("secret worker failure"));
  await assert.rejects(failed, (error) => error.statusCode === 500
    && error.message === "Token counter worker failed"
    && !error.message.includes("secret"));

  const recovered = service.count({});
  workers[1].reply(0, { input_tokens: 9 });
  assert.deepEqual(await recovered, { input_tokens: 9 });
  service.close();
});

test("token counter retires a worker-returned failure and normalizes invalid limits", async () => {
  const workers = [];
  const service = createTokenCounterService({ timeoutMs: 0, maxQueued: Number.NaN, workerFactory: () => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker;
  } });
  const failed = service.count({}, { deadlineMs: 0 });
  workers[0].emit("message", { id: workers[0].messages[0].id, error: true });
  await assert.rejects(failed, (error) => error.statusCode === 500);
  assert.equal(workers[0].terminated, true);
  const recovered = service.count({});
  workers[1].reply(0, { input_tokens: 3 });
  assert.deepEqual(await recovered, { input_tokens: 3 });
  service.close();
});
