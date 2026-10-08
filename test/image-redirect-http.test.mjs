import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { generateImage } from "../src/image-provider.mjs";

test("real Node Fetch forwards safe image redirects but sends nothing to an unsafe target", async (t) => {
  const received = [];
  const sink = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    received.push({ authorization: req.headers.authorization, body });
    res.end("fixture sink");
  });
  sink.listen(0, "127.0.0.1");
  await once(sink, "listening");
  const png = Buffer.alloc(32);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
  png.writeUInt32BE(1024, 16);
  png.writeUInt32BE(1024, 20);
  const requests = [];
  const provider = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({ url: req.url, method: req.method, body, authorization: req.headers.authorization });
    if (req.url === "/final") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ b64_json: png.toString("base64") }] }));
    } else {
      res.writeHead(307, { location: req.url === "/same" ? "/final" : `http://127.0.0.1:${sink.address().port}/sink` });
      res.end("fixture redirect");
    }
  });
  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  t.after(async () => {
    for (const server of [provider, sink]) server.closeAllConnections();
    await Promise.all([provider, sink].map((server) => new Promise((resolve) => server.close(resolve))));
  });
  const base = `http://127.0.0.1:${provider.address().port}`;
  // Transport is local HTTP only; production's HTTPS URL policy remains intact.
  const configuredBase = base.replace("http:", "https:");
  const localFetch = (url, init) => {
    assert.equal(init.redirect, "manual");
    return fetch(String(url).replace("https:", "http:"), init);
  };
  const config = { endpoint: `${configuredBase}/same`, api_key: "synthetic-review-key", model: "gpt-image-1", protocol: "openai-images" };
  const image = await generateImage(config, { prompt: "synthetic prompt" }, { fetchImpl: localFetch });
  assert.equal(image.data, png.toString("base64"));
  assert.deepEqual(requests.map(({ url }) => url), ["/same", "/final"]);
  assert.equal(requests[1].body, requests[0].body);
  assert.equal(requests[1].authorization, "Bearer synthetic-review-key");
  await assert.rejects(generateImage({ ...config, endpoint: `${configuredBase}/cross` }, { prompt: "synthetic prompt" }, { fetchImpl: localFetch }), { code: "ccdx_image_redirect_unsafe" });
  assert.equal(received.length, 0);
  assert.equal(requests.length, 3);
  // Baseline Fetch behavior strips Authorization, but still forwards POST data.
  const baseline = await fetch(`${base}/cross`, { method: "POST", headers: { Authorization: "Bearer synthetic-review-key" }, body: "synthetic prompt" });
  await baseline.text();
  assert.deepEqual(received, [{ authorization: undefined, body: "synthetic prompt" }]);
});
