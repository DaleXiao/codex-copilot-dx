import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import assert from "node:assert/strict";
import { PRIVACY_MODEL_FILES, PRIVACY_MODEL_REVISION } from "../src/privacy-model.mjs";

const directory = process.argv[2];if (!directory || !path.isAbsolute(directory)) throw Error("Supply the component directory");
const name = `ccdx-privacy-guard-1-${process.platform}-${process.arch}${process.platform === "win32" ? ".exe" : ""}`;
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "ccdx-privacy-native-"));
const model = process.argv[3] || temporary, results = [];
let child;
try {
  if (!process.argv[3]) for (const file of PRIVACY_MODEL_FILES) {
    const response = await fetch(`https://huggingface.co/QuantumNous/astrlink-guard/resolve/${PRIVACY_MODEL_REVISION}/int8/${file.name}`, { signal: AbortSignal.timeout(90000) });
    assert.equal(response.status, 200);const bytes = Buffer.from(await response.arrayBuffer());assert.equal(bytes.length, file.bytes);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), file.sha256);await fs.writeFile(path.join(model, file.name), bytes);
  }
  const start = performance.now();child = spawn(path.join(directory, name), [model], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const read = async () => { const result = await Promise.race([lines.next(), new Promise((_, reject) => { const timer = setTimeout(() => reject(Error("Native component timed out")), 60000);timer.unref(); })]);assert.equal(result.done, false);return JSON.parse(result.value); };
  const ready = await read();assert.equal(ready.ready, true);results.push({ stage: "load", ms: Math.round(performance.now() - start), backend: ready.backend || "CPU", device: ready.device });
  const texts = ["The password is my-private-passphrase. Please keep it private.", "const options = { timeout: 5000, retries: 2 };\n".repeat(128)];
  for (let i = 0; i < texts.length; i++) {
    const time = performance.now();child.stdin.write(JSON.stringify({ id: i + 1, texts: [texts[i]] }) + "\n");const value = await read();
    assert.equal(value.id, i + 1);assert.equal(value.found.length, 1);assert.ok(Array.isArray(value.found[0]) || value.found[0] === null);
    if (i === 0) assert.ok(value.found[0]?.some(span => span.label === "common_secret"));
    results.push({ stage: "check", bytes: Buffer.byteLength(texts[i]), ms: Math.round(performance.now() - time), spans: value.found[0]?.length || 0 });
  }
  child.stdin.end();console.log(JSON.stringify({ platform: process.platform, arch: process.arch, results }));
  await fs.writeFile(path.join(directory, `privacy-native-${process.platform}-${process.arch}.json`), JSON.stringify({ results }, null, 2) + "\n");
} finally { child?.kill();await fs.rm(temporary, { recursive: true, force: true }); }
