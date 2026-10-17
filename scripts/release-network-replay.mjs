// Real npm downloader through a loopback CONNECT proxy and private CA. No
// registry token, real provider or global npm configuration is used or changed.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createNpmReleaseFetch } from "../src/release-install.mjs";
const npmCli = process.argv.includes("--npm") ? process.argv[process.argv.indexOf("--npm") + 1] : process.env.npm_execpath;
if (!path.isAbsolute(npmCli || "")) throw Error("Supply --npm /absolute/npm-cli.js");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-release-network-")), sockets = new Set();
const key = path.join(root, "key.pem"), cert = path.join(root, "cert.pem"), config = path.join(root, "openssl.cnf");
fs.writeFileSync(config, "[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=github.com\n[ext]\nsubjectAltName=DNS:github.com\nbasicConstraints=critical,CA:TRUE\n");
execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-keyout", key, "-out", cert, "-config", config], { stdio: "ignore", timeout: 15000 });
let connects = 0, requests = 0;
const upstream = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (req, res) => {
  assert.equal(req.headers.authorization, undefined);assert.equal(req.headers["proxy-authorization"], undefined);
  requests++;res.end("approved fixture");
});
const proxy = http.createServer();
proxy.on("connect", (req, client, head) => {
  assert.equal(req.url, "github.com:443");connects++;
  const remote = net.connect(upstream.address().port, "127.0.0.1", () => {
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");if (head.length) remote.write(head);
    client.pipe(remote);remote.pipe(client);
  });
  for (const socket of [client, remote]) { sockets.add(socket);socket.on("close", () => sockets.delete(socket));socket.on("error", () => { client.destroy();remote.destroy(); }); }
});
const listen = server => new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
try {
  await listen(upstream);await listen(proxy);
  const env = { ...process.env, NO_PROXY: "", no_proxy: "" };
  const create = caFile => createNpmReleaseFetch(npmCli, { env, exec(command, args, options) {
    assert.ok(args.includes("https-proxy") && args.includes("cafile"));assert.equal(options.env, env);
    return `https-proxy=http://127.0.0.1:${proxy.address().port}\nproxy=null\nnoproxy=\ncafile=${caFile}\nstrict-ssl=true\noffline=false\n`;
  } });
  await assert.rejects(create("null")("https://github.com/release-network-fixture", { signal: AbortSignal.timeout(10000) }), /Release download failed/);
  const response = await create(cert)("https://github.com/release-network-fixture", { signal: AbortSignal.timeout(10000) });
  assert.equal(await response.text(), "approved fixture");assert.equal(connects, 2);assert.equal(requests, 1);
  assert.throws(() => createNpmReleaseFetch(npmCli, { exec: () => "offline=true\n" }), /offline mode/);
  console.log("Release networking: configured CONNECT proxy used; configured CA required; TLS stayed strict; no retries or registry credentials; offline mode preserved.");
} finally {
  for (const socket of sockets) socket.destroy();upstream.closeAllConnections();proxy.closeAllConnections();
  await Promise.all([new Promise(resolve => upstream.close(resolve)), new Promise(resolve => proxy.close(resolve))]);fs.rmSync(root, { recursive: true, force: true });
}
