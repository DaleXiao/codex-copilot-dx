import { readFile } from "node:fs/promises";
import { isLoopbackAddress, isLoopbackHostHeader } from "./security.mjs";
import { createHash } from "node:crypto";
import { ADAPTER_VERSION } from "./running-adapter.mjs";

const ASSETS = new Map([
  ["/", ["./dashboard/index.html", "text/html; charset=utf-8"]],
  ["/ui.css", ["./dashboard/ui.css", "text/css; charset=utf-8"]],
  ["/theme.js", ["./dashboard/theme.js", "text/javascript; charset=utf-8"]],
  ["/language.js", ["./dashboard/language.js", "text/javascript; charset=utf-8"]],
  ["/animation.js", ["./dashboard/animation.js", "text/javascript; charset=utf-8"]],
  ["/ui.js", ["./dashboard/ui.js", "text/javascript; charset=utf-8"]],
  ["/console.js", ["./dashboard/console.js", "text/javascript; charset=utf-8"]],
  ["/updates.js", ["./dashboard/updates.js", "text/javascript; charset=utf-8"]],
  ["/time.js", ["./dashboard/time.js", "text/javascript; charset=utf-8"]],
  ["/view-boundary.js", ["./dashboard/view-boundary.js", "text/javascript; charset=utf-8"]],
  ["/status.js", ["./dashboard/status.js", "text/javascript; charset=utf-8"]],
  ["/activity.js", ["./dashboard/activity.js", "text/javascript; charset=utf-8"]],
  ["/flow.js", ["./dashboard/flow.js", "text/javascript; charset=utf-8"]],
  ["/usage.js", ["./dashboard/usage.js", "text/javascript; charset=utf-8"]],
  ["/refresh.js", ["./dashboard/refresh.js", "text/javascript; charset=utf-8"]],
  ["/icons.js", ["./dashboard/icons.js", "text/javascript; charset=utf-8"]],
  ["/tools.js", ["./dashboard/tools.js", "text/javascript; charset=utf-8"]],
  ["/connections.js", ["./dashboard/connections.js", "text/javascript; charset=utf-8"]],
]);
let bundle;
function assets() {
  bundle ||= Promise.all([...ASSETS].map(async ([name, [file, type]]) => {
    let body = await readFile(new URL(file, import.meta.url));
    if (name === "/") body = Buffer.from(body.toString().replace(/(src|href)="(\/[a-z-]+\.(?:js|css))"/g, `$1="$2?v=${ADAPTER_VERSION}"`));
    return [name, { body, type, etag: `"${createHash("sha256").update(body).digest("hex")}"` }];
  })).then(async entries => {
    const installed = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    if (installed.version !== ADAPTER_VERSION) throw new Error("Dashboard files changed; restart CCDX before loading the new dashboard");
    return new Map(entries);
  }).catch(error => { bundle = null;throw error; });
  return bundle;
}

export async function serveDashboard(req, res, pathname) {
  if (!isLoopbackAddress(req.socket?.remoteAddress)
    || req.headers?.host === undefined
    || !isLoopbackHostHeader(req.headers.host)) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
    res.end("The CCDX dashboard is available only at a loopback address.");
    return;
  }

  const version = new URL(req.url || pathname, "http://localhost").searchParams.get("v");
  if (version && version !== ADAPTER_VERSION) {
    res.writeHead(409, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });res.end("Dashboard version changed. Reload this page.");return;
  }
  const { body, type: contentType, etag } = (await assets()).get(pathname);
  const unchanged = pathname !== "/" && String(req.headers?.["if-none-match"] || "").split(/\s*,\s*/).includes(etag);
  res.writeHead(unchanged ? 304 : 200, {
    "Content-Type": contentType,
    "Cache-Control": pathname === "/" ? "no-store" : "no-cache",
    ...(pathname === "/" ? {} : { ETag: etag }),
    "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
  });
  res.end(unchanged || req.method === "HEAD" ? undefined : body);
}
