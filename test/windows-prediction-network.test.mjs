import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { runInNewContext } from "node:vm";
import { readFileSync } from "node:fs";
import http from "node:http";
import { companyPredictionPac, startWindowsPredictionNetwork } from "../src/windows-prediction-network.mjs";

const pac = "function FindProxyForURL(url,host){if(host==='intranet')return 'DIRECT';return 'PROXY company.test:8080; PROXY backup.test:8080';}";
function fixture(t, { ready = pac, respond = true } = {}) {
  const child = new EventEmitter(), received = [], uploads = new Map();let call;
  child.stdout = new PassThrough();child.stderr = new PassThrough();child.killed = false;
  child.kill = () => { child.killed = true; };
  const emit = event => child.stdout.write(JSON.stringify(event) + "\n");
  child.stdin = new Writable({ write(bytes, _encoding, next) {
    const event = JSON.parse(bytes.toString());received.push(event);
    if (!event.op) queueMicrotask(() => emit({ type: "ready", pac: ready === null ? null : Buffer.from(ready).toString("base64") }));
    else if (event.op === "request") uploads.set(event.id, []);
    else if (event.op === "upload") { uploads.get(event.id).push(Buffer.from(event.body, "base64"));queueMicrotask(() => emit({ id: event.id, type: "upload_ack" })); }
    else if (event.op === "upload_end" && respond) queueMicrotask(() => {
      emit({ id: event.id, type: "headers", headers: "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nSet-Cookie: a=b\r\nSet-Cookie: c=d\r\n\r\n" });
      emit({ id: event.id, type: "data", body: Buffer.from("fixture reply").toString("base64") });
    });
    else if (event.op === "ack") queueMicrotask(() => emit({ id: event.id, type: "end" }));
    next();
  } });
  const spawnImpl = (command, args, options) => { call = { command, args, options };return child; };
  t.after(() => { child.stdin.destroy();child.stdout.destroy();child.stderr.destroy(); });
  return { child, emit, received, uploads, spawnImpl, get call() { return call; } };
}

test("company PAC preserves direct/proxy/backup decisions and routes only the two HTTPS hosts", () => {
  const route = runInNewContext(companyPredictionPac(pac, 12345) + "\nFindProxyForURL;", { Date: { now: () => 0 } });
  assert.equal(route("https://chatgpt.com/x", "chatgpt.com"), "PROXY 127.0.0.1:12345; PROXY ccdx-0.localhost:12345; PROXY company.test:8080; PROXY backup.test:8080");
  assert.equal(route("https://ab.chatgpt.com/x", "ab.chatgpt.com").startsWith("PROXY 127.0.0.1:12345; PROXY ccdx-0.localhost:12345;"), true);
  for (const [url, host] of [["https://copilot.test/x", "copilot.test"], ["http://chatgpt.com/x", "chatgpt.com"], ["wss://chatgpt.com/x", "chatgpt.com"]]) {
    assert.equal(route(url, host), "PROXY company.test:8080; PROXY backup.test:8080");
  }
  assert.equal(route("https://intranet/x", "intranet"), "DIRECT");
  assert.throws(() => companyPredictionPac("{broken", 1), /proxy_pac_invalid/);
  assert.throws(() => companyPredictionPac(pac, 0), /proxy_pac_invalid/);
  // Syntax validation must not execute downloaded code in Node.
  assert.doesNotThrow(() => companyPredictionPac("throw new Error('do not run');function FindProxyForURL(){return 'DIRECT';}", 1));
});

test("persistent worker streams uploads and replies, preserves cookies, and closes owned process", async t => {
  const f = fixture(t);
  const env = Object.freeze({ SystemRoot: "C:\\Windows", CODEX_HOME: "unchanged" });
  const network = await startWindowsPredictionNetwork({ settings: { autoDetect: true }, spawnImpl: f.spawnImpl, env });
  assert.equal(network.healthy(), true);
  t.after(() => network.close());
  assert.equal(f.call.options.shell, false);assert.equal(f.call.options.windowsHide, true);
  assert.equal(f.call.args.includes("-ExecutionPolicy"), false);
  assert.equal(env.CODEX_HOME, "unchanged");
  const body = Buffer.alloc(2*1024*1024, 42);let response;
  const result = new Promise((resolve, reject) => {
    const req = network.requestImpl({ hostname: "chatgpt.com", path: "/backend-api/fixture", method: "POST", headers: { "content-length": body.length, authorization: "test-only" } }, res => {
      response = res;const chunks = [];res.on("data", chunk => chunks.push(chunk));res.on("error", reject);res.on("end", () => resolve(Buffer.concat(chunks).toString()));
    });req.on("error", reject);req.end(body);
  });
  assert.equal(await result, "fixture reply");
  assert.deepEqual(response.headers["set-cookie"], ["a=b", "c=d"]);
  assert.deepEqual(Buffer.concat(f.uploads.get(1)), body);
  assert.ok(f.received.filter(event => event.op === "upload").every(event => Buffer.from(event.body, "base64").length <= 65536));
  network.close();assert.equal(f.child.killed, true);
  assert.equal(network.healthy(), false);
});

test("worker failures, invalid targets and detection timeouts are bounded and redacted", async t => {
  const f = fixture(t, { respond: false });
  const network = await startWindowsPredictionNetwork({ settings: { pac: "https://company.test/proxy.pac" }, spawnImpl: f.spawnImpl, timeoutMs: 100 });
  t.after(() => network.close());
  const invalid = network.requestImpl({ hostname: "outside.test", path: "/" }, () => assert.fail("must not connect"));
  const rejected = once(invalid, "error");invalid.end();assert.match((await rejected)[0].message, /proxy_target_invalid/);
  const req = network.requestImpl({ hostname: "chatgpt.com", path: "/", headers: {} }, () => {});
  const timedOut = once(req, "error");req.end();assert.match((await timedOut)[0].message, /proxy_request_timeout/);
  assert.ok(f.received.some(event => event.op === "cancel"));
  const missing = fixture(t);missing.child.stdin = new Writable({ write(_bytes, _encoding, next) { next(); } });
  await assert.rejects(startWindowsPredictionNetwork({ settings: {}, spawnImpl: missing.spawnImpl, timeoutMs: 10 }), /proxy_wpad_timeout/);
  assert.equal(missing.child.killed, true);
});

test("native source uses Windows automatic routing and keeps credentials, TLS and cookie boundaries", () => {
  const source = readFileSync(new URL("../src/windows-prediction-network.cs", import.meta.url), "utf8");
  assert.match(source, /WinHttpOpen\("CCDX native prediction",4,null,null,0\)/);
  assert.match(source, /WinHttpDetectAutoProxyConfigUrl\(3/);
  assert.match(source, /uint disable=3/);
  assert.match(source, /uint protocols=0x800/);
  assert.match(source, /active.Count>=32/);
  assert.doesNotMatch(source, /WinHttpSetCredentials|WinHttpSetDefaultProxyConfiguration|File\.Write|Console\.Error|SECURITY_FLAG_IGNORE/);
});

test("Windows real worker compiles and opens a native session without changing routes", { skip: process.platform !== "win32" }, async t => {
  const network = await startWindowsPredictionNetwork({ settings: { autoDetect: false, pac: "" } });
  t.after(() => network.close());assert.equal(network.script, null);
});

test("Windows native PAC fetch reads the original script and rejects missing files", { skip: process.platform !== "win32" }, async t => {
  const server = http.createServer((req, res) => {
    if (req.url !== "/company.pac") { res.writeHead(404);res.end();return; }
    res.writeHead(200, { "Content-Type": "application/x-ns-proxy-autoconfig" });res.end(pac);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const address = `http://127.0.0.1:${server.address().port}`;
  const network = await startWindowsPredictionNetwork({ settings: { pac: `${address}/company.pac`, autoDetect: false } });
  t.after(() => network.close());assert.equal(network.script, pac);
  await assert.rejects(startWindowsPredictionNetwork({ settings: { pac: `${address}/missing.pac`, autoDetect: false } }), /winhttp_pac_http_error/);
});
