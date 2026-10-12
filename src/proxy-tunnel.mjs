import net from "node:net";
import tls from "node:tls";
import https from "node:https";
import { networkProxyFor } from "./network-route.mjs";

// A bounded read preserves bytes following the handshake for the TLS parser.
function readSocket(socket, ready, maxBytes = 16 * 1024) {
  return new Promise((resolve, reject) => {
    let chunks = [], size = 0;
    const cleanup = () => { socket.off("data", data); socket.off("error", error); socket.off("close", closed); };
    const error = (e) => { cleanup(); reject(e); };
    const closed = () => error(new Error("Proxy closed the connection"));
    const data = (chunk) => {
      chunks.push(chunk); size += chunk.length;
      if (size > maxBytes) { error(new Error("Proxy handshake exceeds its limit")); return; }
      const bytes = Buffer.concat(chunks, size), end = ready(bytes);
      if (end !== null) {
        socket.pause(); cleanup();
        if (bytes.length > end) socket.unshift(bytes.subarray(end));
        resolve(bytes.subarray(0, end));
      }
    };
    socket.on("data", data); socket.once("error", error); socket.once("close", closed); socket.resume();
  });
}

async function connectProxy(target, route, timeoutMs, pending) {
  const proxy = route.url;
  const proxyHost = proxy.hostname.replace(/^\[|\]$/g, "");
  const socket = proxy.protocol === "https:"
    ? tls.connect({ host: proxyHost, port: Number(proxy.port || 443), servername: net.isIP(proxyHost) ? undefined : proxyHost, rejectUnauthorized: true })
    : net.connect({ host: proxyHost, port: Number(proxy.port || (proxy.protocol.startsWith("socks") ? 1080 : 80)) });
  pending.add(socket);
  const timer = setTimeout(() => socket.destroy(new Error("Proxy connection timed out")), timeoutMs);
  socket.once("close", () => pending.delete(socket));
  try {
    await new Promise((resolve, reject) => {
      const event = proxy.protocol === "https:" ? "secureConnect" : "connect";
      const failed = (error) => { socket.off(event, connected); reject(error); };
      const connected = () => { socket.off("error", failed); resolve(); };
      socket.once(event, connected); socket.once("error", failed);
    });
    if (proxy.protocol.startsWith("socks5")) {
      const user = Buffer.from(decodeURIComponent(proxy.username)), password = Buffer.from(decodeURIComponent(proxy.password));
      if (user.length > 255 || password.length > 255) throw new Error("SOCKS5 proxy credentials are too long");
      const greeting = readSocket(socket, b => b.length >= 2 ? 2 : null);
      socket.write(user.length ? Buffer.from([5, 2, 0, 2]) : Buffer.from([5, 1, 0]));
      const choice = await greeting;
      if (choice[0] !== 5 || ![0, 2].includes(choice[1]) || (choice[1] === 2 && !user.length)) throw new Error("SOCKS5 proxy authentication is unsupported");
      if (choice[1] === 2) {
        const auth = readSocket(socket, b => b.length >= 2 ? 2 : null);
        socket.write(Buffer.concat([Buffer.from([1, user.length]), user, Buffer.from([password.length]), password]));
        const result = await auth; if (result[0] !== 1 || result[1] !== 0) throw new Error("SOCKS5 proxy authentication failed");
      }
      const host = Buffer.from(target.hostname);
      if (host.length > 255) throw new Error("Proxy target hostname is too long");
      const response = readSocket(socket, b => {
        if (b.length < 5) return null;
        const size = b[3] === 1 ? 10 : b[3] === 4 ? 22 : b[3] === 3 ? 7 + b[4] : 5;
        return b.length >= size ? size : null;
      });
      socket.write(Buffer.concat([Buffer.from([5, 1, 0, 3, host.length]), host, Buffer.from([1, 187])]));
      const result = await response;
      if (result[0] !== 5 || result[1] !== 0 || ![1, 3, 4].includes(result[3])) throw new Error("SOCKS5 proxy rejected the connection");
    } else {
      const response = readSocket(socket, b => { const end = b.indexOf("\r\n\r\n"); return end < 0 ? null : end + 4; });
      const credentials = proxy.username || proxy.password
        ? `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}\r\n` : "";
      socket.write(`CONNECT ${target.hostname}:443 HTTP/1.1\r\nHost: ${target.hostname}:443\r\n${credentials}\r\n`);
      const headers = (await response).toString("latin1");
      const status = /^HTTP\/1\.[01] (\d{3})/.exec(headers)?.[1];
      if (status !== "200") throw new Error(`HTTP proxy rejected CONNECT (${status || "invalid response"})`);
    }
    clearTimeout(timer); pending.delete(socket);
    return socket;
  } catch (error) { clearTimeout(timer); socket.destroy(); throw error; }
}

export function createProxyAgent(plan, { timeoutMs = 30_000 } = {}) {
  const pending = new Set();
  let closed = false;
  const agent = new https.Agent({ keepAlive: true, maxSockets: 32, maxFreeSockets: 4 });
  const direct = agent.createConnection.bind(agent);
  agent.createConnection = (options, callback) => {
    if (closed) { queueMicrotask(() => callback(new Error("Proxy agent is closed"))); return undefined; }
    const target = new URL(`https://${options.host}`), route = networkProxyFor(target, plan);
    if (!route) return direct(options, callback);
    void connectProxy(target, route, timeoutMs, pending).then(socket => {
      if (closed) { socket.destroy(); callback(new Error("Proxy agent is closed")); return; }
      const secure = tls.connect({ ...options, socket, rejectUnauthorized: true });
      pending.add(secure);
      const timer = setTimeout(() => secure.destroy(new Error("Proxy target TLS timed out")), timeoutMs);
      const fail = (error) => { clearTimeout(timer); pending.delete(secure); secure.off("secureConnect", done); callback(error); };
      const done = () => { clearTimeout(timer); pending.delete(secure); secure.off("error", fail); callback(null, secure); };
      secure.once("error", fail); secure.once("secureConnect", done); secure.resume();
    }, callback);
    return undefined;
  };
  const destroy = agent.destroy.bind(agent);
  agent.destroy = () => { closed = true; for (const socket of pending) socket.destroy(new Error("Proxy agent closed")); pending.clear(); destroy(); };
  return agent;
}
