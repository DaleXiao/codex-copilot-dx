import https from "node:https";
import { Readable } from "node:stream";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveNetworkRoute, networkProxyFor, bypassNetworkProxy } from "../network-route.mjs";
import { createProxyAgent } from "../proxy-tunnel.mjs";
import { apiUrl, accessError } from "../access-settings.mjs";
import { privateHelperEnvironment } from "../private-helper-environment.mjs";
import { transportErrorDetails } from "../operation-error.mjs";

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
  const agent = worker ? undefined : createProxyAgent(plan);let closed = false, broken = false, retiring = false, active = 0, finishRetiring;
  const close = () => { if (closed) return;closed = true;agent?.destroy();worker?.close();finishRetiring?.(); };
  return {
    healthy: () => !closed && !broken && !retiring && (!worker || worker.healthy()),
    fetch(raw, init = {}) {
      return new Promise((resolve, reject) => {
        let url;try { url = new URL(raw); } catch { reject(accessError("ccdx_api_url_invalid"));return; }
        if (closed || retiring || !urls.has(url.href) || !["GET", "POST"].includes(init.method || "GET")) { reject(accessError("ccdx_api_url_invalid"));return; }
        if (init.signal?.aborted) { reject(init.signal.reason);return; }
        active++;
        let req, incoming, socket, phase = "request", handedOff = false, released = false;
        const release = () => { if (released) return;released = true;active--;if (retiring && !active) close(); };
        const lookup = error => { phase = error ? "dns" : "connect"; };
        const connected = () => { phase = "tls"; };
        const secure = () => { phase = "request"; };
        const cleanup = () => {
          init.signal?.removeEventListener("abort", abort);
          socket?.off("lookup", lookup);socket?.off("connect", connected);socket?.off("secureConnect", secure);
        };
        const failed = error => {
          if (!handedOff && !init.signal?.aborted) broken = true;
          cleanup();
          const failure = new Error("API transport failed", { cause: error });
          failure.transport = { ...transportErrorDetails(error), phase, reused_socket: typeof req?.reusedSocket === "boolean" ? req.reusedSocket : null };
          release();
          reject(failure);
        };
        const abort = () => { req?.destroy(init.signal.reason || accessError("ccdx_api_cancelled"));incoming?.destroy(); };
        try {
          req = requestImpl({ hostname: worker ? url.hostname : url.hostname.replace(/^\[|\]$/g, ""), port: Number(url.port || 443), protocol: "https:", path: url.pathname,
            method: init.method || "GET", headers: { ...Object.fromEntries(new Headers(init.headers)), "accept-encoding": "identity" }, agent, rejectUnauthorized: true }, res => {
            phase = "response";incoming = res;
            const finished = () => { cleanup();release(); };
            res.once("end", finished);res.once("close", finished);res.on("error", failed);
            const headers = new Headers();for (const [key, value] of Object.entries(res.headers)) for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) headers.append(key, String(item));
            try {
              const empty = [204, 205, 304].includes(res.statusCode);if (empty) res.resume();
              // Pull only when the consumer reads; eager Node 22 delivery can enqueue after cancellation.
              const response = new Response(empty ? null : Readable.toWeb(res, { strategy: { highWaterMark: 0 } }), { status: res.statusCode, headers });
              handedOff = true;resolve(response);
            }
            catch (error) { failed(error);res.destroy(); }
          });
          req.once("socket", value => {
            socket = value;
            if (!value.connecting || req.reusedSocket) return;
            phase = "connect";value.once("lookup", lookup);value.once("connect", connected);value.once("secureConnect", secure);
          });
          req.on("error", failed);init.signal?.addEventListener("abort", abort, { once: true });
          if (init.signal?.aborted) { abort();return; }req.end(init.body);
        } catch (error) { failed(error);req?.destroy(); }
      });
    },
    retire() {
      retiring = true;
      if (closed) return Promise.resolve();
      if (!active) { close();return Promise.resolve(); }
      return new Promise(resolve => { finishRetiring = resolve; });
    },
    close,
  };
}
