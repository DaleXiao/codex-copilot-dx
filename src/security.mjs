import { isIP } from "node:net";

export function isLoopbackAddress(address) {
  const normalized = String(address || "").trim().toLowerCase();
  if (normalized === "::1" || normalized === "[::1]") return true;
  const ipv4 = normalized.startsWith("::ffff:") ? normalized.slice(7) : normalized;
  return isIP(ipv4) === 4 && ipv4.startsWith("127.");
}

export function isLoopbackHostHeader(host) {
  if (host === undefined) return true; // HTTP/1.0 and in-process callers may omit Host.
  if (typeof host !== "string" || !host || host.includes(",")) return false;
  try {
    const url = new URL(`http://${host}`);
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    return !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash
      && (hostname === "localhost" || isLoopbackAddress(hostname));
  } catch {
    return false;
  }
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
