import { setTimeout as sleep } from "node:timers/promises";

export async function waitForPublicPackage({ name, version, integrity, readJson, now = Date.now, wait = sleep,
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
