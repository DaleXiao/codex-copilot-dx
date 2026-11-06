import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { once } from "node:events";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { addImageHostTool, createImageHostBridge, imageHostBaseUrl, runCodexImageHost } from "../src/codex-image-host.mjs";
import { prepareImageHostLaunch } from "../src/codex-image-host-launch.mjs";
import { createAdapterHandler } from "../src/adapter.mjs";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jJ1sAAAAASUVORK5CYII=", "base64");
test("host registration preserves existing native tools and rejects namespace collisions", () => {
  const other = { type: "function", name: "keep_me", description: "", inputSchema: {} };
  const input = { dynamicTools: [other], model: "gpt-6.1-sol" };
  const output = addImageHostTool(input);
  assert.equal(output.dynamicTools[0], other);assert.equal(input.dynamicTools.length, 1);
  assert.equal(output.dynamicTools[1].name, "ccdx_images");
  assert.throws(() => addImageHostTool({ dynamicTools: [{ name: "ccdx_images" }] }), /already configured/);
  assert.equal(imageHostBaseUrl("http://127.0.0.1:2026/v1"), "http://127.0.0.1:2026/v1");
  for (const url of ["https://example.com/v1", "http://user:key@127.0.0.1/v1", "http://127.0.0.1/v1?key=x"]) assert.throws(() => imageHostBaseUrl(url));
});

async function fixture(t, imageFetch) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ccdx-image-host-test-"));t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, "project");await fs.mkdir(workspace);
  const events = new EventEmitter(), calls = [];
  const bridge = createImageHostBridge({ baseUrl: "http://127.0.0.1:2026/v1", codexHome: path.join(root, "profile"), imageEnabled: async () => true,
    sendToCodex: value => events.emit("response", value), fetchImpl: async (url, options) => {
      calls.push({ url, ...options });
      return imageFetch ? imageFetch(url, options) : Response.json({ data: [{ b64_json: png.toString("base64") }] }, { headers: { "X-CCDX-Image-Model": "gpt-image-2.5-flare" } });
    } });
  await bridge.client({ id: 1, method: "initialize", params: { capabilities: { experimentalApi: true } } });
  await bridge.client({ id: 2, method: "thread/start", params: { cwd: workspace } });
  bridge.codex({ id: 2, result: { thread: { id: "thread-a", cwd: workspace } } });
  async function run(args, id = 3) {
    const waiting = once(events, "response");
    assert.equal(bridge.codex({ id, method: "item/tool/call", params: { namespace: "ccdx_images", tool: "imagegen", threadId: "thread-a", arguments: args } }), true);
    return (await waiting)[0].result;
  }
  t.after(() => bridge.close());return { root, workspace, bridge, calls, run };
}

test("native host generates and edits saved images without rewriting authentication", async t => {
  const f = await fixture(t);const auth = path.join(f.root, "auth.json");await fs.writeFile(auth, "existing authentication sentinel");
  const generated = await f.run({ mode: "generate", prompt: "Blue robot" });
  assert.equal(generated.success, true);assert.equal(generated.contentItems[0].type, "inputImage");
  const saved = JSON.parse(generated.contentItems[1].text).savedPath;
  assert.deepEqual(await fs.readFile(saved), png);
  const edited = await f.run({ mode: "edit", prompt: "Red robot" }, 4);assert.equal(edited.success, true);
  assert.equal(JSON.parse(f.calls[1].body).images[0].image_url, generated.contentItems[0].imageUrl);
  assert.notEqual(JSON.parse(edited.contentItems[1].text).savedPath, saved);
  assert.deepEqual(await fs.readFile(saved), png);assert.equal(await fs.readFile(auth, "utf8"), "existing authentication sentinel");
  const login = { id: 5, method: "account/login/start", params: { type: "chatgpt", token: "sensitive sentinel" } };
  assert.equal(await f.bridge.client(login), login);assert.equal(f.bridge.codex({ id: 9, method: "item/tool/call", params: { namespace: "codex_app", tool: "keep" } }), false);
});

test("reference inputs fail before backend dispatch and user attachments remain usable", async t => {
  const f = await fixture(t);const outside = path.join(f.root, "outside.png");await fs.writeFile(outside, png);
  assert.equal((await f.run({ mode: "edit", prompt: "Edit", referenced_image_paths: [outside] })).success, false);assert.equal(f.calls.length, 0);
  await f.bridge.client({ method: "turn/start", params: { threadId: "thread-a", input: [{ type: "localImage", path: outside }] } });
  assert.equal((await f.run({ mode: "edit", prompt: "Edit" }, 4)).success, true);
  assert.equal(f.calls.length, 1);
});

test("turn interruption cancels only the active host operation", async t => {
  const f = await fixture(t, async (_url, options) => { await new Promise((_, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true })); });
  const waiting = f.run({ mode: "generate", prompt: "Robot" });
  await f.bridge.client({ method: "turn/interrupt", params: { threadId: "thread-a" } });
  assert.equal((await waiting).success, false);
});

test("launch files contain only executable paths and keep custom Codex routes", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ccdx-image-launch-test-"));t.after(() => fs.rm(root, { recursive: true, force: true }));
  const app = path.join(root, "ChatGPT.app"), codex = path.join(app, "Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex");
  await fs.mkdir(path.dirname(codex), { recursive: true });await fs.writeFile(codex, "fixture");
  const options = { env: {}, home: root, platform: "darwin", discoverApp: async () => ({ app }), exec: async () => ({ stdout: "codex-cli 0.166.0-alpha.6" }), node: "/node path/node", entry: "/project path/host.mjs" };
  const launch = await prepareImageHostLaunch(options);const source = await fs.readFile(launch.env.CODEX_CLI_PATH, "utf8");
  assert.match(source, /'\/node path\/node'/);assert.match(source, /http:\/\/127\.0\.0\.1:2026\/v1/);assert.doesNotMatch(source, /auth\.json|token|ephemeral/);
  await assert.rejects(() => prepareImageHostLaunch({ ...options, env: { CODEX_CLI_PATH: "/user/custom-codex" } }), /custom Codex/);
  assert.equal(await prepareImageHostLaunch({ ...options, env: { CCDX_AUTO_LAUNCH: "0" } }), null);
});

test("stdio pass-through preserves credential frames and stops reading when Codex exits", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ccdx-image-stdio-test-"));t.after(() => fs.rm(root, { recursive: true, force: true }));
  const script = path.join(root, "echo.mjs");await fs.writeFile(script, 'process.stdin.pipe(process.stdout);process.stdin.on("end",()=>process.exit(0));');
  const input = new PassThrough(), output = new PassThrough(), error = new PassThrough();let text = "";
  output.on("data", value => { text += value; });
  const running = runCodexImageHost({ codex: process.execPath, argv: [script, "app-server", "--stdio"], baseUrl: "http://127.0.0.1:2026/v1", env: { ...process.env, CODEX_HOME: root }, input, output, error });
  const frame = ' {"id":1,"method":"account/login/start","params":{"token":"sensitive sentinel"}}\n';input.end(frame);
  assert.equal(await running, 0);assert.equal(text, frame);assert.equal(input.listenerCount("data"), 0);
});

test("the real host entry reads the protected image setting and fails closed", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ccdx-image-setting-test-"));t.after(() => fs.rm(root, { recursive: true, force: true }));
  const script = path.join(root, "echo.mjs");await fs.writeFile(script, 'process.stdin.pipe(process.stdout);process.stdin.on("end",()=>process.exit(0));');
  let state = true, reads = 0;
  const handler = createAdapterHandler({ env: {}, dashboardOptions: { home: root, env: {}, serviceControl: { snapshot() {
    reads++;if (state === "error") throw new Error("settings unavailable");return { features: { image: { enabled: state } } };
  } } } });
  const server = http.createServer(handler);await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections();await new Promise(resolve => server.close(resolve));handler.cleanup(); });
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  const existing = { type: "function", name: "existing_tool", description: "", inputSchema: {} };
  for (const [setting, experimental, registered] of [[true, true, true], [false, true, false], ["error", true, false], [true, false, false]]) {
    state = setting;const before = reads, input = new PassThrough(), output = new PassThrough(), error = new PassThrough();let text = "";
    output.on("data", chunk => { text += chunk; });
    const running = runCodexImageHost({ codex: process.execPath, argv: [script, "app-server", "--stdio"], baseUrl, env: { ...process.env, CODEX_HOME: root }, input, output, error });
    input.end([JSON.stringify({ id: 1, method: "initialize", params: { capabilities: { experimentalApi: experimental } } }),
      JSON.stringify({ id: 2, method: "thread/start", params: { cwd: root, dynamicTools: [existing] } })].join("\n") + "\n");
    assert.equal(await running, 0);
    const forwarded = text.trim().split("\n").map(line => JSON.parse(line)).find(frame => frame.id === 2);
    assert.deepEqual(forwarded.params.dynamicTools.map(tool => tool.name), registered ? ["existing_tool", "ccdx_images"] : ["existing_tool"]);
    assert.equal(reads - before, experimental ? 1 : 0);
  }
});

test("host evidence follows accepted initialization and thread registration, not a prepared request", async () => {
  const events = [];
  const bridge = createImageHostBridge({ baseUrl: "http://127.0.0.1:2026/v1", codexHome: "/unused", imageEnabled: async () => true, onEvent: event => events.push(event) });
  await bridge.client({ id: 1, method: "initialize", params: { capabilities: { experimentalApi: true } } });
  assert.equal(events.length, 0);bridge.codex({ id: 1, result: { userAgent: "fixture" } });assert.equal(events[0].event, "connected");
  await bridge.client({ id: 2, method: "thread/start", params: { cwd: "/tmp" } });assert.equal(events.length, 1);
  bridge.codex({ id: 2, error: { code: -1 } });assert.equal(events.length, 1);
  await bridge.client({ id: 3, method: "thread/start", params: { cwd: "/tmp" } });
  bridge.codex({ id: 3, result: { thread: { id: "private-chat-id", cwd: "/tmp" } } });
  assert.equal(events[1].event, "registered");assert.match(events[1].thread, /^[a-f0-9]{32}$/);assert.doesNotMatch(JSON.stringify(events), /private-chat-id/);
  bridge.close();assert.equal(events.at(-1).event, "closed");
});
