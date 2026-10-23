import https from "node:https";
import { Readable } from "node:stream";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveNetworkRoute, networkProxyFor, bypassNetworkProxy } from "../network-route.mjs";
import { createProxyAgent } from "../proxy-tunnel.mjs";
import { apiUrl, accessError } from "../access-settings.mjs";
import { privateHelperEnvironment } from "../private-helper-environment.mjs";

export async function createApiNetwork({ targets, env = process.env, platform = process.platform, signal,
  requestImpl = https.request, exec = promisify(execFile), startWindowsNetwork } = {}) {
  const urls = new Set(targets.map(raw => new URL(apiUrl(raw)).href));if (!urls.size || urls.size > 8) throw accessError("ccdx_api_url_invalid");
  const first = new URL([...urls][0]);
  let plan = resolveNetworkRoute({ env, checkApi: false }), worker;
  if (!networkProxyFor(first, plan) && !bypassNetworkProxy(first.hostname, first.port || 443, plan)) {
    if (platform === "darwin") {
      const { stdout } = await exec("/usr/sbin/scutil", ["--proxy"], { encoding: "utf8", timeout: 2500, maxBuffer: 65536, signal });
      plan = resolveNetworkRoute({ env, systemProxy: stdout, checkApi: false });
    } else if (platform === "win32") {
      const start = startWindowsNetwork || (await import("../windows-http-network.mjs")).startWindowsHttpNetwork;
      worker = await start({ target: "api", apiTargets: [...urls], env: privateHelperEnvironment(env), signal, timeoutMs: 120000 });
      requestImpl = worker.requestImpl;
    }
  }
  const agent = worker ? undefined : createProxyAgent(plan);let closed = false;
  return {
    healthy: () => !closed && (!worker || worker.healthy()),
    fetch(raw, init = {}) {
      return new Promise((resolve, reject) => {
        let url;try { url = new URL(raw); } catch { reject(accessError("ccdx_api_url_invalid"));return; }
        if (closed || !urls.has(url.href) || !["GET", "POST"].includes(init.method || "GET")) { reject(accessError("ccdx_api_url_invalid"));return; }
        if (init.signal?.aborted) { reject(init.signal.reason);return; }
        let req, incoming;
        const cleanup = () => init.signal?.removeEventListener("abort", abort);
        const abort = () => { req?.destroy(init.signal.reason || accessError("ccdx_api_cancelled"));incoming?.destroy(); };
        try {
          req = requestImpl({ hostname: worker ? url.hostname : url.hostname.replace(/^\[|\]$/g, ""), port: Number(url.port || 443), protocol: "https:", path: url.pathname,
            method: init.method || "GET", headers: { ...Object.fromEntries(new Headers(init.headers)), "accept-encoding": "identity" }, agent, rejectUnauthorized: true }, res => {
            incoming = res;res.once("end", cleanup);res.once("close", cleanup);res.on("error", reject);
            const headers = new Headers();for (const [key, value] of Object.entries(res.headers)) for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) headers.append(key, String(item));
            try { const empty = [204, 205, 304].includes(res.statusCode);if (empty) res.resume();resolve(new Response(empty ? null : Readable.toWeb(res), { status: res.statusCode, headers })); }
            catch (error) { cleanup();res.destroy();reject(error); }
          });
          req.on("error", error => { cleanup();reject(error); });init.signal?.addEventListener("abort", abort, { once: true });
          if (init.signal?.aborted) { abort();return; }req.end(init.body);
        } catch (error) { cleanup();req?.destroy();reject(error); }
      });
    },
    close() { closed = true;agent?.destroy();worker?.close(); },
  };
}
