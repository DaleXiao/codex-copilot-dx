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
