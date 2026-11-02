import { setTimeout as sleep } from "node:timers/promises";

export const verificationTag = version => `ccdx-verification-${version.replaceAll(".", "-")}`;

export async function readPublicNpmJson(url, timeoutMs) {
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) { await response.body?.cancel();throw Object.assign(Error(`Public npm HTTP ${response.status}`), { statusCode: response.status }); }
  const chunks = [];let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;if (size > 2 * 1024 * 1024) { await response.body.cancel();throw Error("Oversized public npm metadata"); }chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function waitForPublicPackage({ name, version, integrity, readJson = readPublicNpmJson, now = Date.now, wait = sleep, requireLatest = true,
  timeoutMs = 600000, pollMs = 10000, onWait = () => {} }) {
  const deadline = now() + timeoutMs;
  const transient = error => error?.statusCode === 404 || error?.statusCode === 429 || error?.statusCode >= 500
    || ["TypeError", "TimeoutError", "AbortError"].includes(error?.name);
  const read = suffix => readJson(`https://registry.npmjs.org/${name}/${suffix}`, Math.max(1, Math.min(20000, deadline - now())));
  while (now() < deadline) {
    let record, latest;
    try { record = await read(version); }
    catch (error) { if (!transient(error)) throw error; }
    if (record) {
      if (record.version !== version || record.dist?.integrity !== integrity) throw Error("Public npm metadata differs from the original release artifact");
      if (!requireLatest) return record;
      try { latest = await read("latest"); }
      catch (error) { if (!transient(error)) throw error; }
      if (latest?.version === version) return record;
    }
    const remaining = deadline - now();
    if (remaining <= 0) break;
    onWait();await wait(Math.min(pollMs, remaining));
  }
  throw Error("Public npm processing did not finish within the verification deadline. Resume verification with the original release artifact; do not publish again.");
}
