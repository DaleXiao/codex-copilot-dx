import { readFile } from "node:fs/promises";
import { isLoopbackAddress, isLoopbackHostHeader } from "./security.mjs";
import { createHash } from "node:crypto";
import { ADAPTER_VERSION } from "./running-adapter.mjs";
import { DASHBOARD_ASSETS, DASHBOARD_BUNDLE_ASSETS } from "./dashboard-assets.mjs";

const loaded = new Map();
let versionCheck;
function checkVersion() {
  versionCheck ||= readFile(new URL("../package.json", import.meta.url), "utf8").then(text => {
    if (JSON.parse(text).version !== ADAPTER_VERSION) throw new Error("Dashboard files changed; restart CCDX before loading the new dashboard");
  }).finally(() => { versionCheck = null; });
  return versionCheck;
}

function asset(name) {
  if (!loaded.has(name)) loaded.set(name, (async () => {
    await checkVersion();
    let body, type;
    if (name === "/dashboard.js") {
      const files = await Promise.all(DASHBOARD_BUNDLE_ASSETS.map(asset));
      body = Buffer.concat(files.flatMap(({ body }, i) => [Buffer.from("// " + DASHBOARD_BUNDLE_ASSETS[i] + "\n"), body, Buffer.from("\n;\n")]));
      type = "text/javascript; charset=utf-8";
    } else if (name === "/language-en.js") {
      const source = (await asset("/language.js")).body.toString();
      body = Buffer.from(source.replace(/(:\s*\["(?:\\.|[^"\\])*",) "(?:\\.|[^"\\])*"\],/g, "$1 null],"));
      type = DASHBOARD_ASSETS.get(name)[1];
    } else {
      const [file, contentType] = DASHBOARD_ASSETS.get(name);
      body = await readFile(new URL(file, import.meta.url));
      type = contentType;
      if (name === "/") body = Buffer.from(body.toString().replace(/(src|href)="(\/[a-z-]+\.(?:js|css))"/g, `$1="$2?v=${ADAPTER_VERSION}"`));
    }
    // A cold asset may be requested after the on-disk package was replaced.
    await checkVersion();
    return { body, type, etag: `"${createHash("sha256").update(body).digest("hex")}"` };
  })().catch(error => { loaded.delete(name); throw error; }));
  return loaded.get(name);
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
  const { body, type: contentType, etag } = await asset(pathname);
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
