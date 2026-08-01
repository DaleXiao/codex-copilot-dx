import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  globalUpdateCommand,
  normalizeUpdateSource,
  runPackageUpdateCommand,
} from "../src/package-update.mjs";

function outputBuffer(isTTY = true) {
  let value = "";
  return {
    stream: { isTTY, write(chunk) { value += chunk; } },
    text: () => value,
  };
}

function successfulSpawn(calls) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    queueMicrotask(() => child.emit("exit", 0, null));
    return child;
  };
}

test("package update: builds fixed npm and GitHub global install commands", () => {
  assert.equal(normalizeUpdateSource("gh"), "github");
  assert.deepEqual(globalUpdateCommand("npm"), {
    command: "npm",
    args: ["install", "--global", "codex-copilot-dx@latest"],
    source: "npm",
  });
  assert.deepEqual(globalUpdateCommand("github", { platform: "win32" }), {
    command: "npm.cmd",
    args: ["install", "--global", "--allow-git=all", "github:DaleXiao/codex-copilot-dx#main"],
    source: "github",
  });
  assert.throws(() => globalUpdateCommand("other"), /must be npm or github/);
});

test("package update: direct source works without a terminal and never uses a shell", async () => {
  const calls = [];
  const output = outputBuffer(false);
  const env = { PATH: "/test/bin" };
  const result = await runPackageUpdateCommand({
    env,
    input: { isTTY: false },
    output: output.stream,
    source: "npm",
    spawnImpl: successfulSpawn(calls),
  });

  assert.deepEqual(result, { cancelled: false, source: "npm" });
  assert.deepEqual(calls[0], {
    command: "npm",
    args: ["install", "--global", "codex-copilot-dx@latest"],
    options: { env, shell: false, stdio: "inherit" },
  });
  assert.match(output.text(), /Restart the running adapter/);
});

test("package update: interactive selection retries and can choose GitHub", async () => {
  const calls = [];
  const output = outputBuffer();
  const answers = ["invalid", "2"];
  const result = await runPackageUpdateCommand({
    output: output.stream,
    platform: "win32",
    prompt: async () => answers.shift(),
    spawnImpl: successfulSpawn(calls),
  });

  assert.equal(result.source, "github");
  assert.equal(calls[0].command, "npm.cmd");
  assert.deepEqual(calls[0].args, [
    "install",
    "--global",
    "--allow-git=all",
    "github:DaleXiao/codex-copilot-dx#main",
  ]);
  assert.match(output.text(), /Enter 1 for npm, 2 for GitHub/);
});

test("package update: requires an explicit source without a terminal", async () => {
  await assert.rejects(
    runPackageUpdateCommand({ input: { isTTY: false }, output: { isTTY: false } }),
    /ccdx update npm or ccdx update github/,
  );
});

test("package update: propagates spawn and nonzero exit failures", async (t) => {
  await t.test("spawn error", async () => {
    const output = outputBuffer(false);
    const spawnImpl = () => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("error", new Error("npm missing")));
      return child;
    };
    await assert.rejects(runPackageUpdateCommand({ output: output.stream, source: "npm", spawnImpl }), /npm missing/);
  });

  await t.test("nonzero exit", async () => {
    const output = outputBuffer(false);
    const spawnImpl = () => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("exit", 17, null));
      return child;
    };
    await assert.rejects(runPackageUpdateCommand({ output: output.stream, source: "github", spawnImpl }), /status 17/);
  });
});
