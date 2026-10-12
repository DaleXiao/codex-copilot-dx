import http from "node:http";
import https from "node:https";
import { promisify } from "node:util";
import { gunzip, inflate, brotliDecompress } from "node:zlib";
import { networkPredictionPac } from "./network-route.mjs";
import { operationErrorDetails } from "./operation-error.mjs";

export const PREDICTION_HOSTS = Object.freeze(["chatgpt.com", "ab.chatgpt.com"]);
const CONFIG_LIMIT = 16 * 1024 * 1024;
const REQUEST_LIMIT = 512 * 1024;
const decoders = { gzip: promisify(gunzip), deflate: promisify(inflate), br: promisify(brotliDecompress) };

export function predictionRoute(host, pathname) {
  if (host === "chatgpt.com" && pathname === "/backend-api/wham/statsig/bootstrap") return "bootstrap";
  if (host === "chatgpt.com" && pathname === "/backend-api/wham/predictions/config") return "prediction";
  if (host === "ab.chatgpt.com" && pathname === "/v1/initialize") return "refresh";
  return null;
}

export function predictionPac(port, networkRoute) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid prediction proxy port");
  if (networkRoute) return networkPredictionPac(port, networkRoute);
  return `function FindProxyForURL(url, host) { if (url.indexOf('https:') === 0 && (host === 'chatgpt.com' || host === 'ab.chatgpt.com')) return 'PROXY 127.0.0.1:${port}; DIRECT'; return 'DIRECT'; }\n`;
}

function cleanHeaders(headers) {
  const result = { ...headers };
  for (const name of String(headers.connection || "").split(",")) delete result[name.trim().toLowerCase()];
  for (const name of ["connection", "proxy-authorization", "proxy-authenticate", "keep-alive", "te", "trailer", "transfer-encoding", "upgrade"]) delete result[name];
  return result;
}

function changedHeaders(headers, length) {
  const result = cleanHeaders(headers);
  for (const name of ["content-encoding", "etag", "content-md5", "digest", "content-digest"]) delete result[name];
  result["content-length"] = String(length);
  result["cache-control"] = "no-store";
  return result;
}

async function decode(bytes, encoding, limit) {
  if (!encoding || encoding === "identity") return bytes;
  if (!decoders[encoding]) throw new Error("Unsupported configuration encoding");
  return decoders[encoding](bytes, { maxOutputLength: limit });
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve(server.address().port);
    });
  });
}

// Only selected configuration bodies are buffered. Other traffic is streamed,
// without retries, redirects, credential storage or request/response logging.
export async function startPredictionTransport({
  key, cert, overlay, normalizeRequest = (value) => value,
  enabled = () => true, requestImpl = https.request,
  agent, networkRoute, onEvent = () => {},
  timeoutMs = 30_000, maxConnections = 128,
}) {
  const sockets = new Set();
  const upstreams = new Set();
  let closing = false;
  const gateway = https.createServer({ key, cert, minVersion: "TLSv1.2" }, (req, res) => {
    let target;
    try {
      target = new URL(req.url, `https://${req.headers.host}`);
      if (!PREDICTION_HOSTS.includes(target.hostname) || target.port || target.protocol !== "https:"
        || target.username || target.password || !req.url.startsWith("/") || req.url.startsWith("//")
        || req.headers.host !== target.hostname || req.socket.servername !== target.hostname) throw new Error("Invalid target");
    } catch {
      res.writeHead(403); res.end(); return;
    }
    const route = predictionRoute(target.hostname, target.pathname);
    const headers = cleanHeaders(req.headers);
    // No decoding/re-encoding on pass-through paths.
    if (route && enabled()) headers["accept-encoding"] = "identity";
    let upstream;
    const fail = (error) => {
      onEvent({ type: "upstream_error", error: operationErrorDetails(error) });
      if (!res.headersSent) { res.writeHead(502); res.end(); } else res.destroy();
    };
    const send = (body, streamRemainder = false) => {
      if (res.destroyed || closing) return;
      upstream = requestImpl({
        protocol: "https:", hostname: target.hostname, port: 443,
        servername: target.hostname, method: req.method,
        path: req.url, headers,
        rejectUnauthorized: true,
        ...(agent ? { agent } : {}),
      }, (reply) => {
        const pass = () => {
          res.writeHead(reply.statusCode, cleanHeaders(reply.headers));
          reply.pipe(res);
        };
        reply.on("error", fail);
        // Error and non-JSON responses are forwarded as received. The overlay
        // decides whether the narrowly allowed missing-config response applies.
        const mediaType = String(reply.headers["content-type"] || "").split(";", 1)[0].trim();
        if (!route || !enabled() || mediaType !== "application/json") {
          if (route) onEvent({ type: "configuration", route, status: reply.statusCode, changed: false });
          pass(); return;
        }
        let size = 0;
        const parts = [];
        let streaming = false;
        reply.on("data", (chunk) => {
          if (streaming) return;
          parts.push(chunk); size += chunk.length;
          if (size > CONFIG_LIMIT) {
            streaming = true;
            res.writeHead(reply.statusCode, cleanHeaders(reply.headers));
            reply.pause();
            const buffered = Buffer.concat(parts); parts.length = 0;
            if (res.write(buffered)) reply.pipe(res);
            else res.once("drain", () => reply.pipe(res));
          }
        });
        reply.on("end", () => void (async () => {
          if (streaming || res.destroyed) return;
          const original = Buffer.concat(parts);
          let next = null;
          try {
            const decoded = await decode(original, reply.headers["content-encoding"], CONFIG_LIMIT);
            if (decoded.length <= CONFIG_LIMIT) next = overlay({
              route, host: target.hostname, pathname: target.pathname,
              status: reply.statusCode, body: decoded.toString("utf8"),
              enabled: enabled(),
            });
          } catch { /* Preserve unexpected upstream payloads byte-for-byte. */ }
          if (next?.body !== undefined && (next.body !== original.toString("utf8") || next.status !== reply.statusCode)) {
            onEvent({ type: "configuration", route, status: next.status ?? reply.statusCode, changed: true });
            const bytes = Buffer.from(next.body);
            res.writeHead(next.status ?? reply.statusCode, changedHeaders(reply.headers, bytes.length));
            res.end(bytes);
          } else {
            onEvent({ type: "configuration", route, status: reply.statusCode, changed: false, official: next?.official });
            res.writeHead(reply.statusCode, cleanHeaders(reply.headers)); res.end(original);
          }
        })().catch(fail));
      });
      upstreams.add(upstream);
      upstream.once("close", () => upstreams.delete(upstream));
      if (route && enabled()) upstream.setTimeout(timeoutMs, () => upstream.destroy(new Error("Upstream timeout")));
      upstream.on("error", fail);
      if (streamRemainder) {
        if (upstream.write(body)) req.pipe(upstream);
        else upstream.once("drain", () => req.pipe(upstream));
      } else if (body !== undefined) upstream.end(body); else req.pipe(upstream);
    };
    req.on("aborted", () => upstream?.destroy());
    req.on("error", () => upstream?.destroy());
    res.on("close", () => { if (!res.writableFinished) upstream?.destroy(); });
    if (route !== "refresh" || req.method !== "POST" || !enabled()) { send(); return; }
    // Statsig deltas use a checksum of prior values. Ask for a complete response
    // so the client never merges an upstream delta with locally changed values.
    void (async () => {
      const parts = []; let size = 0;
      for await (const part of req.iterator({ destroyOnReturn: false })) {
        size += part.length;
        parts.push(part);
        if (size > REQUEST_LIMIT) { send(Buffer.concat(parts), true); return; }
      }
      let body = Buffer.concat(parts);
      try {
        const decoded = await decode(body, headers["content-encoding"], REQUEST_LIMIT);
        const encoded = target.searchParams.get("se") === "1";
        const text = encoded ? Buffer.from(decoded.toString().split("").reverse().join(""), "base64").toString() : decoded.toString();
        const parsed = JSON.parse(text);
        const normalized = normalizeRequest(parsed);
        if (normalized !== parsed) {
          const json = JSON.stringify(normalized);
          body = Buffer.from(encoded ? Buffer.from(json).toString("base64").split("").reverse().join("") : json);
          delete headers["content-encoding"];
          headers["content-length"] = String(body.length);
        }
      } catch { /* Unknown request encoding stays untouched. */ }
      send(body);
    })().catch(fail);
  });
  gateway.on("secureConnection", (socket) => socket.setTimeout(0));
  gateway.on("upgrade", (req, socket, head) => {
    const host = req.headers.host;
    if (!PREDICTION_HOSTS.includes(host) || req.socket.servername !== host
      || !req.url.startsWith("/") || req.url.startsWith("//")) { socket.destroy(); return; }
    const upstream = requestImpl({
      protocol: "https:", hostname: host, port: 443, servername: host,
      method: req.method, path: req.url, rejectUnauthorized: true,
      ...(agent ? { agent } : {}),
      headers: { ...cleanHeaders(req.headers), connection: "Upgrade", upgrade: req.headers.upgrade },
    });
    upstreams.add(upstream);
    upstream.on("error", () => socket.destroy());
    upstream.on("response", (reply) => {
      const headers = Object.entries(cleanHeaders(reply.headers)).flatMap(([name, values]) =>
        (Array.isArray(values) ? values : [values]).map((value) => `${name}: ${value}`));
      socket.write(`HTTP/1.1 ${reply.statusCode} ${reply.statusMessage}\r\n${headers.join("\r\n")}\r\nConnection: close\r\n\r\n`);
      reply.on("error", () => socket.destroy()); reply.pipe(socket);
    });
    upstream.on("upgrade", (reply, peer, peerHead) => {
      upstreams.delete(upstream);
      sockets.add(peer); peer.once("close", () => sockets.delete(peer));
      const headers = Object.entries(reply.headers).flatMap(([name, values]) =>
        (Array.isArray(values) ? values : [values]).map((value) => `${name}: ${value}`));
      socket.write(`HTTP/1.1 ${reply.statusCode} ${reply.statusMessage}\r\n${headers.join("\r\n")}\r\n\r\n`);
      if (peerHead.length) socket.write(peerHead);
      if (head.length) peer.write(head);
      socket.on("error", () => peer.destroy()); peer.on("error", () => socket.destroy());
      socket.once("close", () => peer.destroy()); peer.once("close", () => socket.destroy());
      socket.pipe(peer); peer.pipe(socket);
    });
    socket.once("close", () => { upstreams.delete(upstream); upstream.destroy(); });
    upstream.end();
  });
  gateway.on("tlsClientError", (error, socket) => { onEvent({ type: "tls_error", error: operationErrorDetails(error) }); socket.destroy(); });
  gateway.on("clientError", (_error, socket) => socket.destroy());
  const proxy = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/proxy.pac" && !req.headers.origin
      && ["127.0.0.1", "localhost"].includes(String(req.headers.host || "").split(":")[0])) {
      res.writeHead(200, { "Content-Type": "application/x-ns-proxy-autoconfig", "Cache-Control": "no-store" });
      res.end(predictionPac(proxy.address().port, networkRoute)); return;
    }
    res.writeHead(403); res.end();
  });
  proxy.on("connection", (socket) => {
    if (closing || sockets.size >= maxConnections) { socket.destroy(); return; }
    sockets.add(socket); socket.once("close", () => sockets.delete(socket));
  });
  proxy.on("connect", (req, socket, head) => {
    if (closing || !PREDICTION_HOSTS.some((host) => req.url === `${host}:443`) || req.headers.origin) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); return;
    }
    socket.setTimeout(timeoutMs, () => socket.destroy());
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) socket.unshift(head);
    gateway.emit("connection", socket);
  });
  proxy.on("clientError", (_error, socket) => socket.destroy());
  const port = await listen(proxy);
  return {
    port, pacUrl: `http://127.0.0.1:${port}/proxy.pac`,
    async close() {
      closing = true;
      for (const upstream of upstreams) upstream.destroy();
      agent?.destroy();
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => proxy.close(resolve));
      gateway.close();
    },
  };
}
