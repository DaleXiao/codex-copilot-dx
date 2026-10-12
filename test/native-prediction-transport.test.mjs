import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import vm from "node:vm";
import { once } from "node:events";
import { execFileSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import { startPredictionTransport, predictionPac } from "../src/native-prediction-transport.mjs";

let directory, key, cert;
before(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-prediction-transport-test-"));
  const config = path.join(directory, "openssl.cnf");
  fs.writeFileSync(config, "[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ext\n[dn]\nCN=CCDX transport fixture\n[ext]\nbasicConstraints=critical,CA:TRUE\nsubjectAltName=DNS:chatgpt.com,DNS:ab.chatgpt.com\n");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-config", config,
    "-keyout", path.join(directory, "key.pem"), "-out", path.join(directory, "cert.pem")], { stdio: "pipe", timeout: 15_000 });
  key = fs.readFileSync(path.join(directory, "key.pem"));
  cert = fs.readFileSync(path.join(directory, "cert.pem"));
});
after(() => { if (directory) fs.rmSync(directory, { recursive: true, force: true }); });

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t, handler, options = {}) {
  const peers = new Set(), seen = [];
  const upstream = http.createServer(handler);
  upstream.on("connection", socket => {
    peers.add(socket);socket.once("close", () => peers.delete(socket));
  });
  await new Promise((resolve, reject) => {
    upstream.once("error", reject);upstream.listen(0, "127.0.0.1", resolve);
  });
  const bridge = await startPredictionTransport({
    key, cert, overlay: () => null, ...options,
    requestImpl: (request, callback) => {
      seen.push(request);
      // No real host lookup or external traffic is permitted by this fixture.
      return http.request({ ...request, protocol: "http:", hostname: "127.0.0.1", port: upstream.address().port }, callback);
    },
  });
  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    await bridge.close();
  }
  t.after(async () => {
    await close();
    for (const peer of peers) peer.destroy();
    await new Promise(resolve => upstream.close(resolve));
  });
  async function tunnel(host = "chatgpt.com") {
    const socket = await new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port: bridge.port, method: "CONNECT", path: `${host}:443` });
      req.once("connect", (res, socket) => {
        if (res.statusCode !== 200) { socket.destroy();reject(new Error(`CONNECT ${res.statusCode}`)); }
        else resolve(socket);
      });
      req.once("error", reject);req.end();
    });
    const secure = tls.connect({ socket, servername: host, ca: cert });
    t.after(() => secure.destroy());
    await once(secure, "secureConnect");
    assert.equal(secure.authorized, true);
    return secure;
  }
  async function request(host, pathname, { body, method = body === undefined ? "GET" : "POST", headers = {}, onData, onResponse } = {}) {
    const secure = await tunnel(host);
    const agent = new https.Agent({ keepAlive: false });
    agent.createConnection = () => secure;
    t.after(() => agent.destroy());
    let req;
    const result = new Promise((resolve, reject) => {
      req = https.request({ hostname: host, path: pathname, method, agent, headers: { ...headers, connection: "close" } }, res => {
        const chunks = [];
        onResponse?.(res);
        res.on("data", chunk => { chunks.push(chunk);onData?.(chunk); });
        res.once("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        res.once("error", reject);
      });
      req.once("error", reject);
    });
    if (body !== null) req.end(body);
    return { req, result, secure };
  }
  async function send(host, pathname, options) {
    return (await request(host, pathname, options)).result;
  }
  return { bridge, upstream, seen, close, tunnel, request, send };
}

async function writeChunks(stream, total, byte) {
  const chunk = Buffer.alloc(64 * 1024, byte);
  for (let sent = 0; sent < total;) {
    const next = chunk.subarray(0, Math.min(chunk.length, total - sent));
    sent += next.length;
    if (!stream.write(next)) await once(stream, "drain");
  }
}

test("prediction PAC routes only two HTTPS origins and falls back to direct", () => {
  const scope = {};
  vm.runInNewContext(predictionPac(12345), scope);
  for (const host of ["chatgpt.com", "ab.chatgpt.com"]) {
    assert.equal(scope.FindProxyForURL(`https://${host}/anything`, host), "PROXY 127.0.0.1:12345; DIRECT");
    assert.equal(scope.FindProxyForURL(`http://${host}/anything`, host), "DIRECT");
  }
  for (const host of ["api.openai.com", "example.test", "chatgpt.com.example.test", "other.chatgpt.com"]) {
    assert.equal(scope.FindProxyForURL(`https://${host}/`, host), "DIRECT");
  }
  for (const port of [0, -1, 65536, 1.5, "2026"]) assert.throws(() => predictionPac(port), /Invalid/);
});

test("CONNECT allowlist and PAC endpoint reject other authorities and browser origins", { timeout: 10_000 }, async t => {
  const f = await fixture(t, (_req, res) => res.end("fixture"));
  for (const authority of ["example.test:443", "chatgpt.com:80", "chatgpt.com:444", "chatgpt.com.example.test:443", "CHATGPT.COM:443"]) {
    const status = await new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port: f.bridge.port, method: "CONNECT", path: authority });
      req.once("connect", (res, socket) => { socket.destroy();resolve(res.statusCode); });
      req.once("error", reject);req.end();
    });
    assert.equal(status, 403);
  }
  const originStatus = await new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: f.bridge.port, method: "CONNECT", path: "chatgpt.com:443", headers: { origin: "https://example.test" } });
    req.once("connect", (res, socket) => { socket.destroy();resolve(res.statusCode); });req.once("error", reject);req.end();
  });
  assert.equal(originStatus, 403);
  for (const [headers, expected] of [[{}, 200], [{ origin: "https://example.test" }, 403], [{ host: "example.test" }, 403]]) {
    const result = await new Promise((resolve, reject) => {
      http.get({ host: "127.0.0.1", port: f.bridge.port, path: "/proxy.pac", headers }, res => {
        const parts = [];res.on("data", part => parts.push(part));res.on("end", () => resolve({ status: res.statusCode, text: Buffer.concat(parts).toString() }));
      }).once("error", reject);
    });
    assert.equal(result.status, expected);
    if (expected === 200) assert.equal(result.text, predictionPac(f.bridge.port));
  }
  assert.equal(f.seen.length, 0);
});

test("ordinary requests preserve raw paths, POST bytes, status, credentials and cookies", { timeout: 10_000 }, async t => {
  const original = Buffer.from([0, 255, 1, 13, 10]), received = deferred();
  const f = await fixture(t, (req, res) => {
    const parts = [];req.on("data", part => parts.push(part));req.on("end", () => {
      received.resolve({ url: req.url, headers: req.headers, body: Buffer.concat(parts) });
      res.writeHead(418, { "content-type": "application/octet-stream", "set-cookie": ["a=1; HttpOnly", "b=2; Secure"], "x-retain": "yes" });res.end(original);
    });
  }, { overlay: () => { assert.fail("ordinary response must not enter overlay"); } });
  const pathname = "/alpha/../beta/%2f?key=a%2Bb&key=x";
  const result = await f.send("chatgpt.com", pathname, { body: original, headers: { authorization: "Bearer synthetic-fixture-only", cookie: "fixture=one", "content-type": "application/octet-stream", "accept-encoding": "gzip", "proxy-authorization": "must-not-forward" } });
  assert.equal(result.status, 418);assert.deepEqual(result.body, original);
  assert.deepEqual(result.headers["set-cookie"], ["a=1; HttpOnly", "b=2; Secure"]);assert.equal(result.headers["x-retain"], "yes");
  const incoming = await received.promise;
  assert.equal(incoming.url, pathname);assert.deepEqual(incoming.body, original);
  assert.equal(incoming.headers.authorization, "Bearer synthetic-fixture-only");assert.equal(incoming.headers.cookie, "fixture=one");
  assert.equal(incoming.headers["accept-encoding"], "gzip");assert.equal(incoming.headers["proxy-authorization"], undefined);
  assert.equal(f.seen[0].rejectUnauthorized, true);assert.equal(f.seen[0].servername, "chatgpt.com");
});

test("TLS requests cannot change the CONNECT authority through Host or absolute targets", { timeout: 10_000 }, async t => {
  const f = await fixture(t, (_req, res) => res.end("unexpected"));
  for (const [pathname, headers] of [
    ["/", { host: "ab.chatgpt.com" }], ["/", { host: "example.test" }],
    ["//ab.chatgpt.com/path", {}], ["https://chatgpt.com/path", {}],
  ]) {
    const result = await f.send("chatgpt.com", pathname, { headers });
    assert.equal(result.status, 403);
  }
  assert.equal(f.seen.length, 0);
});

test("disabled configuration is byte-identical without request normalization", { timeout: 10_000 }, async t => {
  const response = gzipSync(Buffer.from(' {"feature_gates":{}}\n'));
  const body = ' {"deltasResponseRequested":true,"user":{"userID":"fixture"}}\n';
  const received = deferred();
  const f = await fixture(t, (req, res) => {
    const parts = [];req.on("data", part => parts.push(part));req.on("end", () => {
      received.resolve({ body: Buffer.concat(parts), headers: req.headers });
      res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip", etag: "original" });res.end(response);
    });
  }, { enabled: () => false, overlay: () => assert.fail("disabled overlay"), normalizeRequest: () => assert.fail("disabled normalization") });
  const result = await f.send("ab.chatgpt.com", "/v1/initialize", { body, headers: { "accept-encoding": "gzip" } });
  assert.deepEqual(result.body, response);assert.equal(result.headers["content-encoding"], "gzip");assert.equal(result.headers.etag, "original");
  const incoming = await received.promise;
  assert.equal(incoming.body.toString(), body);assert.equal(incoming.headers["accept-encoding"], "gzip");
});

test("gzip configuration decoding preserves unknown payloads and rewrites only changed JSON", { timeout: 10_000 }, async t => {
  const original = gzipSync(Buffer.from('{"fixture":true}'));
  let change = false, calls = 0;
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip", etag: "original", digest: "original", "set-cookie": ["fixture=1"], "x-retain": "yes" });res.end(original);
  }, { overlay: value => {
    calls++;assert.equal(value.body, '{"fixture":true}');assert.equal(value.route, "prediction");
    return change ? { status: 200, body: '{"fixture":true,"enabled":true}' } : null;
  } });
  const unchanged = await f.send("chatgpt.com", "/backend-api/wham/predictions/config");
  assert.deepEqual(unchanged.body, original);assert.equal(unchanged.headers.etag, "original");assert.equal(unchanged.headers["content-encoding"], "gzip");
  change = true;
  const changed = await f.send("chatgpt.com", "/backend-api/wham/predictions/config");
  assert.equal(changed.body.toString(), '{"fixture":true,"enabled":true}');assert.equal(changed.headers["content-encoding"], undefined);
  assert.equal(changed.headers.etag, undefined);assert.equal(changed.headers.digest, undefined);assert.equal(changed.headers["cache-control"], "no-store");
  assert.equal(Number(changed.headers["content-length"]), changed.body.length);assert.deepEqual(changed.headers["set-cookie"], ["fixture=1"]);
  assert.equal(changed.headers["x-retain"], "yes");assert.equal(calls, 2);
});

test("unknown or invalid response encodings are returned without decoding or header changes", { timeout: 10_000 }, async t => {
  let encoding = "future", original = Buffer.from([0, 255, 42]);
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200, { "content-type": "application/json", "content-encoding": encoding, etag: "keep" });res.end(original);
  }, { overlay: () => assert.fail("undecodable payload must not be overlaid") });
  for (const value of ["future", "gzip"]) {
    encoding = value;
    const result = await f.send("chatgpt.com", "/backend-api/wham/predictions/config");
    assert.deepEqual(result.body, original);assert.equal(result.headers["content-encoding"], value);assert.equal(result.headers.etag, "keep");
  }
});

test("refresh normalization supports compressed and encoded JSON but leaves unknown bodies untouched", { timeout: 10_000 }, async t => {
  const received = [];
  let calls = 0;
  const f = await fixture(t, (req, res) => {
    const parts = [];req.on("data", part => parts.push(part));req.on("end", () => {
      received.push({ body: Buffer.concat(parts), headers: req.headers });res.end("ok");
    });
  }, { normalizeRequest: value => { calls++;return { ...value, deltas: false }; } });
  const original = { user: { userID: "synthetic-fixture" }, deltas: true };
  const normalized = JSON.stringify({ ...original, deltas: false });
  for (const encoded of [false, true]) {
    const json = JSON.stringify(original);
    const wire = encoded ? Buffer.from(json).toString("base64").split("").reverse().join("") : json;
    const body = gzipSync(Buffer.from(wire));
    await f.send("ab.chatgpt.com", encoded ? "/v1/initialize?se=1" : "/v1/initialize", { body, headers: { "content-encoding": "gzip", "content-length": String(body.length) } });
    const forwarded = received.at(-1);
    const expected = encoded ? Buffer.from(normalized).toString("base64").split("").reverse().join("") : normalized;
    assert.equal(forwarded.body.toString(), expected);assert.equal(forwarded.headers["content-encoding"], undefined);
    assert.equal(Number(forwarded.headers["content-length"]), Buffer.byteLength(expected));
  }
  assert.equal(calls, 2);
  for (const [body, encoding] of [[Buffer.from("not JSON"), undefined], [Buffer.from([0, 255, 1]), "future"], [Buffer.from("invalid gzip"), "gzip"]]) {
    await f.send("ab.chatgpt.com", "/v1/initialize", { body, headers: encoding ? { "content-encoding": encoding } : {} });
    assert.deepEqual(received.at(-1).body, body);assert.equal(received.at(-1).headers["content-encoding"], encoding);
  }
  assert.equal(calls, 2);
});

test("SSE bytes reach the client before the upstream response finishes", { timeout: 10_000 }, async t => {
  const delivered = deferred();
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });res.write("data: first\n\n");
    void delivered.promise.then(() => res.end("data: final\n\n"));
  }, { overlay: () => assert.fail("SSE must not be buffered") });
  const result = await f.send("chatgpt.com", "/backend-api/wham/predictions/config", { onData: () => delivered.resolve() });
  assert.equal(result.body.toString(), "data: first\n\ndata: final\n\n");
});

test("responses above the configuration limit stream byte-for-byte before upstream end", { timeout: 15_000 }, async t => {
  const prefixLength = 16 * 1024 * 1024 + 64 * 1024, delivered = deferred(), completed = deferred();
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200, { "content-type": "application/json", etag: "large-unchanged" });
    void (async () => {
      await writeChunks(res, prefixLength, 120);
      await delivered.promise;
      res.end("tail");completed.resolve();
    })().catch(error => { res.destroy(error);completed.resolve(error); });
  }, { overlay: () => assert.fail("oversized payload must bypass overlay") });
  const result = await f.send("chatgpt.com", "/backend-api/wham/predictions/config", { onData: () => delivered.resolve() });
  assert.equal(await completed.promise, undefined);assert.equal(result.status, 200);assert.equal(result.headers.etag, "large-unchanged");
  assert.equal(result.body.length, prefixLength + 4);assert.deepEqual(result.body.subarray(0, prefixLength), Buffer.alloc(prefixLength, 120));
  assert.equal(result.body.subarray(prefixLength).toString(), "tail");
});

test("refresh requests above the body limit stream upstream before client end", { timeout: 10_000 }, async t => {
  const prefixLength = 512 * 1024 + 64 * 1024, observed = deferred(), received = deferred();
  const f = await fixture(t, (req, res) => {
    const parts = [];let length = 0;
    req.on("data", part => { parts.push(part);length += part.length;if (length >= prefixLength) observed.resolve(); });
    req.on("end", () => { received.resolve(Buffer.concat(parts));res.end("ok"); });
  }, { normalizeRequest: () => assert.fail("oversized request must not normalize") });
  const { req, result } = await f.request("ab.chatgpt.com", "/v1/initialize", { method: "POST", body: null });
  await writeChunks(req, prefixLength, 121);
  await observed.promise;
  req.end("tail");
  assert.equal((await result).body.toString(), "ok");
  const bytes = await received.promise;
  assert.equal(bytes.length, prefixLength + 4);assert.deepEqual(bytes.subarray(0, prefixLength), Buffer.alloc(prefixLength, 121));
  assert.equal(bytes.subarray(prefixLength).toString(), "tail");
});

test("WebSocket upgrade preserves handshake headers and both directions of binary bytes", { timeout: 10_000 }, async t => {
  const f = await fixture(t, (_req, res) => res.end());
  const clientFrame = Buffer.from([0x82, 0x82, 1, 2, 3, 4, 0x40, 0x40]);
  const serverFrame = Buffer.from([0x82, 2, 0x41, 0x42]);
  const received = deferred();
  f.upstream.on("upgrade", (req, peer, head) => {
    assert.equal(req.headers.authorization, "Bearer synthetic-fixture-only");
    assert.equal(req.url, "/ws/%2f?keep=1");assert.equal(head.length, 0);
    peer.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: fixture\r\n\r\n");
    peer.once("data", data => { received.resolve(data);peer.write(serverFrame); });
  });
  const secure = await f.tunnel();
  const agent = new https.Agent({ keepAlive: false });agent.createConnection = () => secure;t.after(() => agent.destroy());
  const { socket, head } = await new Promise((resolve, reject) => {
    const req = https.request({ hostname: "chatgpt.com", path: "/ws/%2f?keep=1", agent, headers: { connection: "Upgrade", upgrade: "websocket", authorization: "Bearer synthetic-fixture-only" } });
    req.once("upgrade", (res, socket, head) => {
      assert.equal(res.statusCode, 101);assert.equal(res.headers["sec-websocket-accept"], "fixture");resolve({ socket, head });
    });req.once("error", reject);req.end();
  });
  assert.equal(head.length, 0);
  const reply = once(socket, "data");socket.write(clientFrame);
  assert.deepEqual(await received.promise, clientFrame);assert.deepEqual((await reply)[0], serverFrame);
  socket.destroy();
});

test("rejected WebSocket upgrades preserve upstream status and response body", { timeout: 10_000 }, async t => {
  const f = await fixture(t, (_req, res) => res.end());
  f.upstream.on("upgrade", (_req, socket) => {
    socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nRetry-After: 9\r\nContent-Length: 18\r\nConnection: close\r\n\r\n{"error":"denied"}');
  });
  const secure = await f.tunnel();
  const agent = new https.Agent({ keepAlive: false });agent.createConnection = () => secure;t.after(() => agent.destroy());
  const result = await new Promise((resolve, reject) => {
    const req = https.request({ hostname: "chatgpt.com", path: "/ws", agent, headers: { connection: "Upgrade", upgrade: "websocket" } }, res => {
      const parts = [];res.on("data", chunk => parts.push(chunk));res.on("error", reject);
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts).toString() }));
    });req.on("error", reject);req.end();
  });
  assert.equal(result.status, 401);assert.equal(result.headers["retry-after"], "9");
  assert.equal(result.body, '{"error":"denied"}');
});

test("client abort and bridge close terminate active upstream responses", { timeout: 10_000 }, async t => {
  const closed = [];
  const f = await fixture(t, (_req, res) => {
    const done = deferred();closed.push(done);
    res.on("close", () => done.resolve());
    res.writeHead(200, { "content-type": "text/event-stream" });res.write("data: waiting\n\n");
  });
  for (const action of ["abort", "close"]) {
    const first = deferred();
    const { result, secure } = await f.request("chatgpt.com", "/stream", { onData: () => first.resolve() });
    // Attach the expected error handler before destroying either transport end.
    const failed = assert.rejects(result, /aborted|reset|closed/i);
    await first.promise;
    if (action === "abort") secure.destroy();else await f.close();
    await failed;await closed.at(-1).promise;
  }
  await assert.rejects(new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port: f.bridge.port, path: "/proxy.pac" }, resolve);
    req.once("error", reject);
  }), /ECONNREFUSED/);
});
