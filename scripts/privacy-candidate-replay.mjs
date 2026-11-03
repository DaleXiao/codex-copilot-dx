import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createPrivacyModel, PRIVACY_COMPONENT_RELEASE, PRIVACY_COMPONENT_ABI, PRIVACY_MODEL_REVISION, PRIVACY_MODEL_FILES } from "../src/privacy-model.mjs";
import { createLocalPrivacy } from "../src/local-privacy.mjs";
import { userSettingsPath } from "../src/user-settings.mjs";
import { testEnvironment } from "../test/helpers/environment.mjs";

const [component, weights, output] = process.argv.slice(2);
assert.ok([component, weights, output].every(value => value && path.isAbsolute(value)));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-candidate-native-"));
const repository = fileURLToPath(new URL("../", import.meta.url));
const baselineCommit = "cac4722b87d96d870f154edb46a300a5cf458d3a";
let detector;
try {
  const env = testEnvironment(root, { XDG_CONFIG_HOME: path.join(root, "config"), XDG_CACHE_HOME: path.join(root, "cache") });
  detector = createPrivacyModel({ home: root, env, fetchImpl: async () => { throw Error("Candidate replay forbids model downloads"); } });
  fs.mkdirSync(detector.paths.model, { recursive: true });fs.mkdirSync(path.dirname(detector.paths.runner), { recursive: true });
  for (const file of PRIVACY_MODEL_FILES) fs.copyFileSync(path.join(weights, file.name), path.join(detector.paths.model, file.name));
  const binary = fs.readFileSync(path.join(component, detector.paths.name));
  fs.writeFileSync(detector.paths.runner, binary, { mode: 0o700 });
  fs.writeFileSync(detector.paths.receipt, JSON.stringify({ release: PRIVACY_COMPONENT_RELEASE, abi: PRIVACY_COMPONENT_ABI, model_revision: PRIVACY_MODEL_REVISION,
    sha256: createHash("sha256").update(binary).digest("hex") }));
  const loading = performance.now();await detector.load();const loadMs = Math.round(performance.now() - loading);
  const baselineSource = execFileSync("git", ["show", baselineCommit + ":src/local-privacy.mjs"], { cwd: repository, encoding: "utf8" })
    .replace(/from "\.\/([^"]+)"/g, (_, name) => "from " + JSON.stringify(pathToFileURL(path.join(repository, "src", name)).href));
  const { createLocalPrivacy: baseline } = await import("data:text/javascript;base64," + Buffer.from(baselineSource).toString("base64"));
  const makeText = (count, chinese) => Array.from({ length: count }, (_, index) => chinese
    ? "第" + index + "行包含普通说明文字和测试数据，不包含真实账户信息。\n"
    : "line " + index + " contains ordinary sample text for an isolated history.\n").join("");
  const workloads = [
    { name: "short-fields", values: Array.from({ length: 80 }, (_, index) => "ordinary field " + index), append: "one additional field" },
    { name: "long-english", values: [makeText(480, false)], append: makeText(20, false) },
    { name: "long-chinese", values: [makeText(200, true)], append: makeText(10, true) },
  ];
  const samples = [];
  for (const workload of workloads) {
    for (const [label, factory] of [["baseline-1.3.11-detection", baseline], ["candidate-1.3.12", createLocalPrivacy]]) {
      const home = path.join(root, workload.name, label), localEnv = testEnvironment(home, { XDG_CONFIG_HOME: path.join(home, "config") });
      const settings = userSettingsPath({ home, env: localEnv });fs.mkdirSync(path.dirname(settings), { recursive: true });
      fs.writeFileSync(settings, JSON.stringify({ privacy_enabled: true }));
      let calls = 0, bytes = 0;
      const model = { ...detector, close() {}, stop() {}, find: async (texts, options = {}) => detector.find(texts, { ...options, onSubmitted() {
        calls++;bytes += texts.reduce((sum, text) => sum + Buffer.byteLength(text), 0);options.onSubmitted?.();
      } }) };
      // A fixed test wait measures processing rather than differing wait policies.
      const privacy = factory({ home, env: localEnv, model, checkTimeoutMs: 180000 });
      const first = { messages: workload.values.map(content => ({ role: "user", content })) };
      const next = workload.name === "short-fields" ? { messages: [...first.messages, { role: "user", content: workload.append }] }
        : { messages: [{ role: "user", content: workload.values[0] + workload.append }] };
      const timings = [];
      try {
        for (const [phase, body] of [["cold", first], ["append", next], ["hot", next]]) {
          const beforeCalls = calls, beforeBytes = bytes, start = performance.now();
          await privacy.prepare(body, { protocol: "messages", client: "isolated_candidate" });
          const sample = { phase, ms: Math.round(performance.now() - start), submitted_batches: calls - beforeCalls, submitted_bytes: bytes - beforeBytes };
          timings.push(sample);
          if (phase === "hot") assert.equal(sample.submitted_batches, 0, "Exact hot history repeated native work");
        }
      } finally { privacy.close(); }
      samples.push({ workload: workload.name, variant: label, input_bytes: workload.values.reduce((sum, value) => sum + Buffer.byteLength(value), 0), timings });
    }
  }
  for (const workload of workloads.filter(value => value.name !== "short-fields")) {
    const before = samples.find(value => value.workload === workload.name && value.variant.startsWith("baseline"));
    const after = samples.find(value => value.workload === workload.name && value.variant.startsWith("candidate"));
    assert.ok(after.timings[1].submitted_bytes < before.timings[1].submitted_bytes / 2, "Append must reuse unchanged native pieces");
  }
  const result = { version: JSON.parse(fs.readFileSync(path.join(repository, "package.json"))).version,
    platform: process.platform, arch: process.arch, baseline_commit: baselineCommit,
    comparison_scope: "Same native component and current text projection; detection orchestration only, no cloud inference or signed App execution.",
    backend: detector.snapshot().backend, device: detector.snapshot().device, component_release: detector.snapshot().component_release, load_ms: loadMs, samples };
  fs.mkdirSync(output, { recursive: true });const file = path.join(output, "privacy-candidate-" + process.platform + "-" + process.arch + ".json");
  fs.writeFileSync(file, JSON.stringify(result, null, 2) + "\n");console.log(JSON.stringify(result));
} finally { detector?.close();fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }); }
