import { generateKeyPair, randomBytes, sign, timingSafeEqual } from "node:crypto";
import { createServer } from "node:https";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { isLoopbackAddress, isLoopbackHostHeader } from "./security.mjs";

export const ANTIGRAVITY_GATEWAY_PREFIX = "/antigravity/gateway";
const keyPair = promisify(generateKeyPair);
const modelCall = /^\/(?:v1beta\/models|v1beta1\/projects\/[A-Za-z0-9_-]+\/locations\/[a-z0-9-]+\/publishers\/google\/models)\/(ccdx-(?:copilot|gemini)-[A-Za-z0-9._-]{1,160}):(generateContent|streamGenerateContent|countTokens)$/;
export function antigravityGatewayRoute(pathname) {
  const route = pathname.slice(ANTIGRAVITY_GATEWAY_PREFIX.length);
  if (route === "/v1beta/models") return { method: "catalog" };
  if (/^\/v1beta:(?:recordMetrics|reportMetrics|recordCodeAssistMetrics)$/.test(route)) return { method: "metrics" };
  const result = modelCall.exec(route);
  return result && { model: result[1], method: result[2] };
}

// The launch-specific self-signed certificate is trusted only by the App that
// receives this public PEM. Its SAN is the IP of this listener.
const hex = value => Buffer.from(value, "hex");
function der(tag, ...items) {
  const body = Buffer.concat(items);
  const size = body.length;
  const length = size < 128 ? [size] : size < 256 ? [0x81, size] : [0x82, size >> 8, size & 255];
  return Buffer.concat([Buffer.from([tag, ...length]), body]);
}
const sequence = (...items) => der(0x30, ...items);
function utcTime(ms) {
  return der(0x17, Buffer.from(new Date(ms).toISOString().slice(2, 19).replace(/[^0-9]/g, "") + "Z"));
}
async function loopbackCertificate() {
  const { privateKey, publicKey } = await keyPair("ec", { namedCurve: "prime256v1" });
  const algorithm = sequence(hex("06082a8648ce3d040302")); // ecdsa-with-SHA256
  const subject = sequence(der(0x31, sequence(hex("0603550403"), der(0x0c, Buffer.from("CCDX Antigravity loopback")))));
  const now = Date.now();
  const serial = randomBytes(16);
  serial[0] = (serial[0] & 0x7f) | 1;
  const extensions = sequence(
    sequence(hex("0603551d11"), der(0x04, sequence(der(0x87, Buffer.from([127, 0, 0, 1]))))),
    sequence(hex("0603551d25"), der(0x04, sequence(hex("06082b06010505070301")))),
  );
  const body = sequence(der(0xa0, hex("020102")), der(0x02, serial), algorithm, subject,
    sequence(utcTime(now - 300_000), utcTime(now + 30 * 86400_000)), subject,
    publicKey.export({ type: "spki", format: "der" }), der(0xa3, extensions));
  const cert = sequence(body, algorithm, der(0x03, Buffer.from([0]), sign("sha256", body, privateKey)));
  return {
    cert: "-----BEGIN CERTIFICATE-----\n" + cert.toString("base64").match(/.{1,64}/g).join("\n") + "\n-----END CERTIFICATE-----\n",
    key: privateKey.export({ type: "pkcs8", format: "pem" }),
  };
}

export async function startAntigravityGateway({ handle, models }) {
  const credentials = await loopbackCertificate();
  const environment = { AGY_LLM_GATEWAY_API_KEY: randomBytes(32).toString("hex") };
  const expected = Buffer.from("Bearer " + environment.AGY_LLM_GATEWAY_API_KEY);
  const requests = new WeakSet();
  let seen;
  const server = createServer({ ...credentials, minVersion: "TLSv1.2", headersTimeout: 10_000, requestTimeout: 120_000 }, (req, res) => {
    const auth = Buffer.from(typeof req.headers.authorization === "string" ? req.headers.authorization : "");
    if (auth.length !== expected.length || !timingSafeEqual(auth, expected) || !isLoopbackAddress(req.socket.remoteAddress)
      || !req.headers.host || !isLoopbackHostHeader(req.headers.host) || Object.hasOwn(req.headers, "origin")) {
      res.writeHead(403, { "Content-Type": "application/json", Connection: "close" });
      res.end('{"error":{"code":403,"message":"Antigravity gateway authentication is required"}}');
      return;
    }
    // Strip the private gateway credential before entering the shared
    // request pipeline. Route identity travels via the actual listener.
    delete req.headers.authorization;
    if (!req.url?.startsWith("/") || req.url.startsWith("//")) { res.writeHead(400);res.end();return; }
    req.url = ANTIGRAVITY_GATEWAY_PREFIX + req.url;
    requests.add(req);
    const fail = () => {
      if (res.headersSent) { res.destroy();return; }
      res.writeHead(500, { "Content-Type": "application/json", Connection: "close" });
      res.end('{"error":{"code":500,"message":"Antigravity gateway could not process the request"}}');
    };
    try { Promise.resolve(handle(req, res)).catch(fail); } catch { fail(); }
  });
  let directory;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    expected.fill(0);
    delete environment.AGY_LLM_GATEWAY_API_KEY;
    server.close();
    server.closeAllConnections();
    if (directory) try { rmSync(directory, { recursive: true, force: true }); } catch { /* The certificate is public and expires. */ }
    process.removeListener("exit", close);
  };
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject);resolve(); });
    });
    directory = mkdtempSync(path.join(tmpdir(), "ccdx-antigravity-gateway-"));
    const ca = path.join(directory, "loopback.pem");
    writeFileSync(ca, credentials.cert, { mode: 0o600, flag: "wx" });
    process.once("exit", close);
    server.unref();
    return {
      owns: req => !closed && requests.has(req),
      active: () => !closed,
      observation: () => closed ? null : seen,
      observe(scope) {
        if (!closed && (!seen || scope === "inference" && seen.scope !== "inference")) seen = { scope, at: new Date().toISOString() };
      },
      environment: Object.assign(environment, {
        AGY_LLM_GATEWAY_URL: "https://127.0.0.1:" + server.address().port,
        AGY_LLM_GATEWAY_CA_CERT: ca,
        AGY_LLM_GATEWAY_WIRE_PROTOCOL: "genai",
        ...(models?.length ? { AGY_LLM_GATEWAY_MODELS: models.join(",") } : {}),
      }),
      close,
    };
  } catch (error) {
    close();
    throw error;
  }
}
