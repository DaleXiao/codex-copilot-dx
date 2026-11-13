import { isIP } from "node:net";

export function isLoopbackAddress(address) {
  const normalized = String(address || "").trim().toLowerCase();
  if (normalized === "::1" || normalized === "[::1]") return true;
  const ipv4 = normalized.startsWith("::ffff:") ? normalized.slice(7) : normalized;
  return isIP(ipv4) === 4 && ipv4.startsWith("127.");
}

function normalizedHostName(value) {
  const hostname = String(value || "").trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/%25/g, "%");
  const mapped = hostname.match(/^::ffff:(?:(\d{1,3}(?:\.\d{1,3}){3})|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/);
  if (!mapped) return hostname;
  if (mapped[1] && isIP(mapped[1]) === 4) return mapped[1];
  if (mapped[2]) {
    const high = Number.parseInt(mapped[2], 16), low = Number.parseInt(mapped[3], 16);
    return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
  }
  return hostname;
}

function parseHostHeader(host) {
  if (typeof host !== "string" || !host || host !== host.trim() || host.includes(",")) return null;
  try {
    const url = new URL(`http://${host}`);
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    return normalizedHostName(url.hostname);
  } catch {
    return null;
  }
}

function isLoopbackHostName(hostname) {
  return hostname === "localhost" || isLoopbackAddress(hostname);
}

function isWildcardHostName(hostname) {
  return hostname === "0.0.0.0" || hostname === "::";
}

export function isLoopbackHostHeader(host) {
  if (host === undefined) return true; // HTTP/1.0 and in-process callers may omit Host.
  const hostname = parseHostHeader(host);
  return hostname !== null && isLoopbackHostName(hostname);
}

export function isAllowedAdapterHostHeader(host, {
  remoteAddress,
  localAddress,
  configuredHost,
  allowLan = isLanAllowed(),
} = {}) {
  const loopbackPeer = isLoopbackAddress(remoteAddress);
  if (host === undefined) return !remoteAddress || loopbackPeer;

  const hostname = parseHostHeader(host);
  if (hostname === null) return false;
  if (!remoteAddress) return isLoopbackHostName(hostname);

  const configured = normalizedHostName(configuredHost);
  if (allowLan && configured && !isWildcardHostName(configured) && hostname === configured) return true;
  if (loopbackPeer) return isLoopbackHostName(hostname);
  if (!allowLan || isLoopbackHostName(hostname)) return false;

  const local = normalizedHostName(localAddress);
  return Boolean(local && !isWildcardHostName(local) && hostname === local);
}

export function isLoopbackHost(host) {
  const normalized = String(host || "").toLowerCase().replace(/^\[(.*)\]$/, "$1");
  return ["127.0.0.1", "localhost", "::1"].includes(normalized);
}

export function isLanAllowed(env = process.env) {
  return ["1", "true", "yes"].includes(String(env.CCDX_ALLOW_LAN || "").toLowerCase());
}

export function assertSafeAdapterHost(host = "127.0.0.1", env = process.env) {
  if (isLoopbackHost(host) || isLanAllowed(env)) return;
  throw new Error(`Refusing to bind ADAPTER_HOST=${host} beyond loopback without CCDX_ALLOW_LAN=1. This adapter carries your GitHub Copilot access.`);
}
