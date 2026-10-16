import https from "node:https";
import { Readable } from "node:stream";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveNetworkRoute, networkProxyFor, bypassNetworkProxy, networkRouteSnapshot } from "../network-route.mjs";
import { createProxyAgent } from "../proxy-tunnel.mjs";
import { loadRuntimeConfig } from "../runtime-config.mjs";
import { m365HelperEnvironment } from "./m365-auth.mjs";

const HOST = "df.loki.delve.office.com";
const targetUrl = new URL(`https://${HOST}/api/v1/llmapi/models`);
const fail = code => Object.assign(new Error(`Microsoft 365 network is unavailable (${code})`), { code: `m365_${code}`, statusCode: 503 });

export function requestFetch(requestImpl, agent) {
  return (raw, init = {}) => new Promise((resolve, reject) => {
    let url;try { url = new URL(raw); } catch { reject(fail("target_invalid"));return; }
    if (url.protocol !== "https:" || url.hostname !== HOST || url.port || url.username || url.password || url.hash
      || !url.pathname.startsWith("/api/v1/llmapi/") || !["GET", "POST", "HEAD"].includes(init.method || "GET")) { reject(fail("target_invalid"));return; }
    if (init.signal?.aborted) { reject(init.signal.reason);return; }
    const headers = Object.fromEntries(new Headers(init.headers));
    headers["accept-encoding"] = "identity";
    let request, incoming;
    const abort = () => { request?.destroy(init.signal.reason || fail("request_cancelled"));incoming?.destroy(); };
    const cleanup = () => init.signal?.removeEventListener("abort", abort);
    try {
      request = requestImpl({ hostname: HOST, protocol: "https:", port: 443, path: url.pathname + url.search,
        method: init.method || "GET", headers, agent, rejectUnauthorized: true }, response => {
        incoming = response;response.once("end", cleanup);response.once("close", cleanup);response.on("error", reject);
        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(response.headers)) {
          if (value === undefined) continue;
          for (const item of Array.isArray(value) ? value : [value]) responseHeaders.append(key, String(item));
        }
        try {
          const noBody = [204, 205, 304].includes(response.statusCode) || init.method === "HEAD";
          if (noBody) response.resume();
          resolve(new Response(noBody ? null : Readable.toWeb(response), { status: response.statusCode, headers: responseHeaders }));
        } catch (error) { response.destroy();cleanup();reject(error); }
      });
      request.on("error", error => { cleanup();reject(error); });
      init.signal?.addEventListener("abort", abort, { once: true });
      if (init.signal?.aborted) { abort();return; }
      request.end(init.body);
    } catch (error) { cleanup();request?.destroy();reject(error); }
  });
}

export async function createM365Network({ env = process.env, platform = process.platform, signal,
  execFileImpl = promisify(execFile), startWindowsNetwork, requestImpl = https.request } = {}) {
  const explicit = resolveNetworkRoute({ env, checkApi: false });
  const environmentRoute = networkProxyFor(targetUrl, explicit), bypass = bypassNetworkProxy(HOST, 443, explicit);
  const runtime = loadRuntimeConfig(env);
  if (platform === "win32" && !environmentRoute && !bypass) {
    const start = startWindowsNetwork || (await import("../windows-http-network.mjs")).startWindowsHttpNetwork;
    const worker = await start({ target: "m365", settings: { autoDetect: false, pac: "" }, env: m365HelperEnvironment(env), signal,
      timeoutMs: Math.max(runtime.upstreamTimeoutMs, runtime.streamIdleTimeoutMs) });
    return { fetch: requestFetch(worker.requestImpl), snapshot: () => ({ source: "system", type: "winhttp", healthy: worker.healthy() }),
      healthy: worker.healthy, close: worker.close };
  }
  let plan = explicit;
  if (platform === "darwin" && !environmentRoute && !bypass) {
    let systemProxy;
    try { ({ stdout: systemProxy } = await execFileImpl("/usr/sbin/scutil", ["--proxy"], { encoding: "utf8", timeout: 2500, maxBuffer: 65536, signal })); }
    catch { throw fail("proxy_discovery_failed"); }
    try { plan = resolveNetworkRoute({ env, systemProxy, checkApi: false }); }
    catch { throw fail("proxy_settings_unsupported"); }
  }
  const agent = createProxyAgent(plan, { timeoutMs: 30000 });
  agent.maxSockets = 8;agent.maxFreeSockets = 2;
  let closed = false;
  return { fetch: requestFetch(requestImpl, agent), snapshot: () => ({ ...networkRouteSnapshot(plan), healthy: !closed }),
    healthy: () => !closed, close() { closed = true;agent.destroy(); } };
}
