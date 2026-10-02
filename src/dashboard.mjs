import { readFile } from "node:fs/promises";
import { isLoopbackAddress, isLoopbackHostHeader } from "./observability.mjs";

const ASSETS = new Map([
  ["/", ["./dashboard/index.html", "text/html; charset=utf-8"]],
  ["/ui.css", ["./dashboard/ui.css", "text/css; charset=utf-8"]],
  ["/theme.js", ["./dashboard/theme.js", "text/javascript; charset=utf-8"]],
  ["/language.js", ["./dashboard/language.js", "text/javascript; charset=utf-8"]],
  ["/ui.js", ["./dashboard/ui.js", "text/javascript; charset=utf-8"]],
]);

export async function serveDashboard(req, res, pathname) {
  if (!isLoopbackAddress(req.socket?.remoteAddress)
    || req.headers?.host === undefined
    || !isLoopbackHostHeader(req.headers.host)) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
    res.end("The CCDX dashboard is available only at a loopback address.");
    return;
  }

  const [file, contentType] = ASSETS.get(pathname);
  const body = await readFile(new URL(file, import.meta.url));
  res.writeHead(200, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
  });
  res.end(req.method === "HEAD" ? undefined : body);
}
