import { randomUUID } from "node:crypto";
import { localPackageVersion } from "./version.mjs";

export const ADAPTER_HEALTH_PATH = "/_ccdx/health";
export const ADAPTER_PROTOCOL_VERSION = 2;
export const ADAPTER_VERSION = localPackageVersion();
const ADAPTER_INSTANCE_ID = randomUUID();

export function adapterHealthPayload() {
  return {
    ok: true,
    name: "codex-copilot-dx",
    pid: process.pid,
    version: ADAPTER_VERSION,
    protocol_version: ADAPTER_PROTOCOL_VERSION,
    instance_id: ADAPTER_INSTANCE_ID,
  };
}

export function adapterProbeHost(host = "127.0.0.1") {
  const normalized = String(host || "127.0.0.1").toLowerCase();
  if (normalized === "0.0.0.0" || normalized === "::" || normalized === "[::]") return "127.0.0.1";
  return host || "127.0.0.1";
}

export function adapterBaseUrl(host = "127.0.0.1", port = 2026) {
  const probeHost = String(adapterProbeHost(host));
  const urlHost = probeHost.includes(":") && !probeHost.startsWith("[") ? `[${probeHost}]` : probeHost;
  return `http://${urlHost}:${port}`;
}

export async function checkRunningAdapter({
  host = "127.0.0.1",
  port = 2026,
  fetchImpl = fetch,
  timeoutMs = 500,
  expectedVersion = ADAPTER_VERSION,
  expectedProtocolVersion = ADAPTER_PROTOCOL_VERSION,
} = {}) {
  const baseUrl = adapterBaseUrl(host, port);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetchImpl(`${baseUrl}${ADAPTER_HEALTH_PATH}`, {
      headers: { Accept: "application/json" },
      signal: ctrl.signal,
    });
    if (!resp.ok) return { ok: false, baseUrl, status: resp.status };
    const data = await resp.json();
    if (data?.name !== "codex-copilot-dx" || data?.ok !== true) {
      return { ok: false, baseUrl, status: resp.status, data };
    }
    if (data.version !== expectedVersion || data.protocol_version !== expectedProtocolVersion) {
      return {
        ok: false,
        incompatible: true,
        baseUrl,
        status: resp.status,
        data,
        expectedVersion,
        expectedProtocolVersion,
      };
    }
    return { ok: true, baseUrl, data };
  } catch (e) {
    return { ok: false, baseUrl, error: e };
  } finally {
    clearTimeout(timer);
  }
}
