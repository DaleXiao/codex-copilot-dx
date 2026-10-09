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

const fetchRelease = async () => Response.json({ tag_name: "v0.9.19", draft: false, prerelease: false });

test("package update: builds fixed npm and GitHub global install commands", () => {
  assert.equal(normalizeUpdateSource("gh"), "github");
  assert.deepEqual(globalUpdateCommand("npm"), {
    command: "npm",
    args: ["install", "--global", "codex-copilot-dx@latest"],
    source: "npm",
  });
  assert.deepEqual(globalUpdateCommand("github", { platform: "win32", releaseTag: "v0.9.19" }), {
    command: "npm.cmd",
    args: ["install", "--global", "--allow-git=all", "github:DaleXiao/codex-copilot-dx#v0.9.19"],
    source: "github",
  });
  assert.throws(() => globalUpdateCommand("other"), /must be npm or github/);
  for (const releaseTag of [undefined, "main", "v1.2.3-beta", "v1.2.3#main", "v1.2.3\n"]) {
    assert.throws(() => globalUpdateCommand("github", { releaseTag }), /valid stable GitHub release tag/);
  }
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
    fetchImpl: () => assert.fail("npm updates must not query GitHub"),
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
    fetchImpl: fetchRelease,
  });

  assert.equal(result.source, "github");
  assert.equal(calls[0].command, "npm.cmd");
  assert.deepEqual(calls[0].args, [
    "install",
    "--global",
    "--allow-git=all",
    "github:DaleXiao/codex-copilot-dx#v0.9.19",
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
    await assert.rejects(runPackageUpdateCommand({ output: output.stream, source: "github", spawnImpl, fetchImpl: fetchRelease }), /status 17/);
  });
});

test("GitHub update resolves once and pins the tag without trusting returned download URLs", async () => {
  const calls = [];
  const output = outputBuffer(false);
  let lookups = 0;
  const env = { PATH: "/test/bin", npm_config_registry: "https://approved-mirror.example" };
  await runPackageUpdateCommand({
    source: "gh", env, output: output.stream, spawnImpl: successfulSpawn(calls),
    fetchImpl: async () => { lookups++; return Response.json({ tag_name: "v1.2.3", draft: false, prerelease: false, tarball_url: "https://unsafe.example/archive" }); },
  });
  assert.equal(lookups, 1);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ["install", "--global", "--allow-git=all", "github:DaleXiao/codex-copilot-dx#v1.2.3"]);
  assert.equal(calls[0].options.env, env);
  assert.equal(calls[0].options.shell, false);
  assert.match(output.text(), /GitHub release v1.2.3/);
});

test("unavailable or invalid GitHub release fails before installation with no fallback", async () => {
  for (const fetchImpl of [async () => { throw new Error("offline"); }, async () => new Response("limited", { status: 429 }), async () => Response.json({ tag_name: "main", draft: false, prerelease: false })]) {
    await assert.rejects(runPackageUpdateCommand({ source: "github", output: outputBuffer(false).stream,
      fetchImpl, spawnImpl: () => assert.fail("No installer may run after release lookup failure"),
    }), /No update was installed/);
  }
});

test("cancelling interactive update does not query or install anything", async () => {
  const result = await runPackageUpdateCommand({ output: outputBuffer().stream, prompt: async () => "q",
    fetchImpl: () => assert.fail("No lookup on cancellation"), spawnImpl: () => assert.fail("No install on cancellation"),
  });
  assert.equal(result.cancelled, true);
});
