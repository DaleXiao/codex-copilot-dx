import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createPredictionCertificate } from "../src/native-prediction-profile.mjs";
import { resolveNetworkRoute } from "../src/network-route.mjs";
import { createProxyAgent } from "../src/proxy-tunnel.mjs";

let directory, certificate;
before(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-proxy-tunnel-test-")); certificate = createPredictionCertificate(directory); });
after(() => fs.rmSync(directory, { recursive: true, force: true }));
async function listening(t, server) {
  const sockets = new Set();server.on("connection", socket => { sockets.add(socket);socket.on("close", () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => { server.once("error", reject);server.listen(0, "127.0.0.1", resolve); });
  t.after(async () => { for (const socket of sockets) socket.destroy();await new Promise(resolve => server.close(resolve)); });
  return server.address().port;
}
function request(agent, { ca = certificate.ca } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get({ host: "chatgpt.com", path: "/fixture", agent, ca, headers: { authorization: "Bearer fixture-client" } }, res => {
      let body = "";res.on("data", x => body += x);res.on("end", () => resolve({ status: res.statusCode, body }));res.on("error", reject);
    });req.on("error", reject);
  });
}
async function target(t) {
  return listening(t, https.createServer(certificate, (req, res) => {
    assert.equal(req.headers["proxy-authorization"], undefined);
    assert.equal(req.headers.authorization, "Bearer fixture-client");
    res.end("through-existing-proxy");
  }));
}

test("HTTP CONNECT preserves target TLS and sends proxy credentials only to the proxy", { timeout: 5000 }, async t => {
  const targetPort = await target(t);let connects = 0;
  const proxy = http.createServer();proxy.on("connect", (req, socket, head) => {
    connects++;assert.equal(req.url, "chatgpt.com:443");assert.equal(req.headers["proxy-authorization"], "Basic "+Buffer.from("alice:secret").toString("base64"));
    const peer = net.connect(targetPort, "127.0.0.1", () => { socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");if (head.length) peer.write(head);socket.pipe(peer);peer.pipe(socket); });
    socket.on("close", () => peer.destroy());peer.on("error", () => socket.destroy());
  });
  const port = await listening(t, proxy);
  const agent = createProxyAgent(resolveNetworkRoute({ env: { HTTPS_PROXY: `http://alice:secret@127.0.0.1:${port}` } }));t.after(() => agent.destroy());
  assert.deepEqual(await request(agent), { status: 200, body: "through-existing-proxy" });
  assert.equal(connects, 1);
  assert.equal((await request(agent)).status, 200); assert.equal(connects, 1);
});

test("proxy rejection is reported instead of silently falling back to direct", { timeout: 5000 }, async t => {
  const proxy = http.createServer();proxy.on("connect", (_req, socket) => socket.end("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n"));
  const port = await listening(t, proxy);
  const agent = createProxyAgent(resolveNetworkRoute({ env: { HTTPS_PROXY: `http://127.0.0.1:${port}` } }));t.after(() => agent.destroy());
  await assert.rejects(request(agent), /407/);
});

test("SOCKS5 authentication and fragmented handshake preserve a verified TLS target", { timeout: 5000 }, async t => {
  const targetPort = await target(t);let authenticated = false;
  const proxy = net.createServer(socket => {
    let state = "greeting", buffer = Buffer.alloc(0);
    socket.on("data", function data(chunk) {
      buffer = Buffer.concat([buffer, chunk]);
      if (state === "greeting" && buffer.length >= 2 + buffer[1]) { buffer = Buffer.alloc(0);state = "auth";socket.write(Buffer.from([5]));setImmediate(() => socket.write(Buffer.from([2]))); }
      else if (state === "auth" && buffer.length >= 3 + buffer[1] + (buffer[2 + buffer[1]] || 0)) {
        assert.equal(buffer.subarray(2, 2 + buffer[1]).toString(), "alice");
        authenticated = true;buffer = Buffer.alloc(0);state = "connect";socket.write(Buffer.from([1, 0]));
      } else if (state === "connect" && buffer.length >= 7 + buffer[4]) {
        assert.equal(buffer.subarray(5, 5 + buffer[4]).toString(), "chatgpt.com");
        assert.equal(buffer.readUInt16BE(5 + buffer[4]), 443);
        socket.off("data", data);
        const peer = net.connect(targetPort, "127.0.0.1", () => { socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 1, 187]));socket.pipe(peer);peer.pipe(socket); });
        socket.on("close", () => peer.destroy());peer.on("error", () => socket.destroy());
      }
    });
  });
  const port = await listening(t, proxy);
  const agent = createProxyAgent(resolveNetworkRoute({ env: { HTTPS_PROXY: `socks5://alice:secret@127.0.0.1:${port}` } }));t.after(() => agent.destroy());
  assert.equal((await request(agent)).status, 200);assert.equal(authenticated, true);
});

test("upstream TLS verification remains enforced through CONNECT", { timeout: 5000 }, async t => {
  const targetPort = await target(t);
  const proxy = http.createServer();proxy.on("connect", (_req, socket) => {
    const peer = net.connect(targetPort, "127.0.0.1", () => { socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");socket.pipe(peer);peer.pipe(socket); });
    socket.on("close", () => peer.destroy());peer.on("error", () => socket.destroy());
  });
  const port = await listening(t, proxy), agent = createProxyAgent(resolveNetworkRoute({ env: { HTTPS_PROXY: `http://127.0.0.1:${port}` } }));t.after(() => agent.destroy());
  await assert.rejects(request(agent, { ca: [] }), /certificate|issuer|self.signed/i);
});

test("HTTPS proxies verify both TLS layers and preserve CONNECT routing", { timeout: 10000 }, async t => {
  const caPath = path.join(directory, "proxy-ca.pem"), keyPath = path.join(directory, "proxy-key.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPath,
    "-out", caPath, "-days", "1", "-subj", "/CN=CCDX proxy fixture", "-addext", "subjectAltName=IP:127.0.0.1"], { stdio: "ignore" });
  const targetPort = await target(t);let connects = 0;
  const proxy = https.createServer({ key: fs.readFileSync(keyPath), cert: fs.readFileSync(caPath) });
  proxy.on("tlsClientError", () => {});
  proxy.on("connect", (req, socket) => {
    connects++;assert.equal(req.url, "chatgpt.com:443");
    const peer = net.connect(targetPort, "127.0.0.1", () => { socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");socket.pipe(peer);peer.pipe(socket); });
    socket.on("close", () => peer.destroy());peer.on("error", () => socket.destroy());
  });
  const port = await listening(t, proxy), address = `https://127.0.0.1:${port}`;
  const rejected = createProxyAgent(resolveNetworkRoute({ env: { HTTPS_PROXY: address } }));t.after(() => rejected.destroy());
  await assert.rejects(request(rejected), /certificate|issuer|self.signed/i);
  assert.equal(connects, 0);
  const code = `import https from 'node:https';
    import {createProxyAgent} from ${JSON.stringify(fileURLToPath(new URL("../src/proxy-tunnel.mjs", import.meta.url)))};
    import {resolveNetworkRoute} from ${JSON.stringify(fileURLToPath(new URL("../src/network-route.mjs", import.meta.url)))};
    const agent=createProxyAgent(resolveNetworkRoute({env:{HTTPS_PROXY:${JSON.stringify(address)}}}));
    await new Promise((resolve,reject)=>{https.get({host:'chatgpt.com',path:'/fixture',agent,ca:${JSON.stringify(certificate.ca)},
      headers:{authorization:'Bearer fixture-client'}},res=>{let text='';res.on('data',x=>text+=x);res.on('end',()=>{process.stdout.write(text);resolve();});res.on('error',reject);}).on('error',reject);}).finally(()=>agent.destroy());`;
  const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", code],
    { env: { ...process.env, NODE_EXTRA_CA_CERTS: caPath }, timeout: 5000 });
  assert.equal(stdout, "through-existing-proxy");assert.equal(connects, 1);
});

test("a stalled proxy handshake is bounded and agent closure aborts pending connections", { timeout: 5000 }, async t => {
  const port = await listening(t, net.createServer(() => {}));
  const plan = resolveNetworkRoute({ env: { HTTPS_PROXY: `http://127.0.0.1:${port}` } });
  const timeoutAgent = createProxyAgent(plan, { timeoutMs: 30 });t.after(() => timeoutAgent.destroy());
  await assert.rejects(request(timeoutAgent), /timed out/);
  const agent = createProxyAgent(plan, { timeoutMs: 3000 });
  const result = request(agent);const rejection = assert.rejects(result, /closed|reset/i);
  setTimeout(() => agent.destroy(), 20);await rejection;
});
