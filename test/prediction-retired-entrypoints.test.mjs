import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const hook = fileURLToPath(new URL("../src/suggestion-auto.mjs", import.meta.url));
const mcp = fileURLToPath(new URL("../src/suggestion-mcp.mjs", import.meta.url));

function start(t, args) {
  const child = spawn(process.execPath, args, {
    env: { ...process.env, CCDX_SUGGESTION_CONFIG: "/nonexistent/retired-prediction-test.json", CODEX_HOME: "/nonexistent/retired-prediction-test-home" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", data => { stdout += data; });
  child.stderr.on("data", data => { stderr += data; });
  // A retired hook may exit while an old caller is still writing its event.
  child.stdin.on("error", error => { if (error.code !== "EPIPE" && error.code !== "ERR_STREAM_DESTROYED") throw error; });
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error("Retired entrypoint did not exit")); }, 3000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
  });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  return { child, done };
}

function request(id, method, params) { return JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }) + "\n"; }
function replies(result) {
  assert.equal(result.code, 0); assert.equal(result.signal, null); assert.equal(result.stderr, "");
  return result.stdout.trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
}

test("retired Hook exits with an empty result without waiting for stdin", async t => {
  const { done } = start(t, [hook]);
  const result = await done;
  assert.equal(result.code, 0); assert.equal(result.stdout, "{}\n"); assert.equal(result.stderr, "");
});

test("retired entrypoints have no import side effects or stdin listeners", async t => {
  const code = `const before = process.stdin.listenerCount('data'); await import(${JSON.stringify(new URL("../src/suggestion-auto.mjs", import.meta.url).href)}); await import(${JSON.stringify(new URL("../src/suggestion-mcp.mjs", import.meta.url).href)}); if (process.stdin.listenerCount('data') !== before) process.exitCode = 1;`;
  const { done } = start(t, ["--input-type=module", "--eval", code]);
  const result = await done;
  assert.equal(result.code, 0); assert.equal(result.stdout, ""); assert.equal(result.stderr, "");
});

test("retired MCP negotiates its protocol and exposes no tools or panel resources", async t => {
  const { child, done } = start(t, [mcp]);
  child.stdin.end(request(1, "initialize", { protocolVersion: "2024-11-05" })
    + request(undefined, "notifications/initialized") + request(2, "ping") + request(3, "tools/list")
    + request(4, "resources/list") + request(5, "resources/templates/list"));
  const messages = replies(await done);
  assert.equal(messages.length, 5);
  assert.equal(messages[0].result.protocolVersion, "2024-11-05");
  assert.match(messages[0].result.instructions, /retired/);
  assert.deepEqual(messages.slice(1).map(message => message.result), [{}, { tools: [] }, { resources: [] }, { resourceTemplates: [] }]);
});

test("cached prediction tools and panel reads fail explicitly without generation", async t => {
  const { child, done } = start(t, [mcp]);
  child.stdin.end(["suggest_next_message", "latest_suggestion", "prepare_suggestion_draft"].map((name, id) => request(id, "tools/call", { name, arguments: {} })).join("")
    + request(3, "resources/read", { uri: "ui://ccdx/next-message.html" }));
  const messages = replies(await done);
  for (const message of messages.slice(0, 3)) {
    assert.equal(message.result.isError, true); assert.match(message.result.content[0].text, /retired/);
    assert.equal(message.result.content.length, 1);
  }
  assert.equal(messages[3].error.code, -32601); assert.match(messages[3].error.message, /retired/);
});

test("retired MCP preserves UTF-8 across input chunks and recovers after malformed JSON", async t => {
  const { child, done } = start(t, [mcp]);
  child.stdin.write("not-json\n");
  const data = Buffer.from(request("预测", "ping"));
  const split = data.indexOf(Buffer.from("预")) + 1;
  child.stdin.write(data.subarray(0, split));
  await new Promise(resolve => setTimeout(resolve, 20));
  child.stdin.end(data.subarray(split));
  const messages = replies(await done);
  assert.equal(messages[0].error.code, -32700);
  assert.deepEqual(messages[1], { jsonrpc: "2.0", id: "预测", result: {} });
});

test("retired MCP limits each JSONL request to 64 KiB, not the whole stream", async t => {
  const { child, done } = start(t, [mcp]);
  const base = request(1, "ping", { padding: "" }).trimEnd();
  const line = base.replace('"padding":""', '"padding":"' + "x".repeat(64 * 1024 - Buffer.byteLength(base)) + '"');
  assert.equal(Buffer.byteLength(line), 64 * 1024);
  child.stdin.end(line + "\n" + line + "\n");
  assert.equal(replies(await done).length, 2);
});

test("retired MCP terminates over-limit requests before they can be parsed", async t => {
  const { child, done } = start(t, [mcp]);
  child.stdin.write("x".repeat(64 * 1024 + 1));
  const messages = replies(await done);
  assert.equal(messages.length, 1); assert.equal(messages[0].error.code, -32600);
  assert.match(messages[0].error.message, /65536/);
});
