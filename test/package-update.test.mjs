import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  globalUpdateCommand,
  normalizeUpdateSource,
  runPackageUpdateCommand as runActualUpdate,
  inspectPackageUpdateEnvironment,
  verifyInstalledPackage,
  inspectNpmDownloadPolicy,
} from "../src/package-update.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const runPackageUpdateCommand = options => runActualUpdate({ downloadReleaseFn: async tag => ({ name: `codex-copilot-dx-${tag.slice(1)}.tgz` }), verifyRuntimeFn() {}, inspectEnvironmentFn: () => ({ target: "/fixture/package" }), inspectPolicyFn: () => ({ supported: false }), verifyInstalledFn: () => "0.9.35", ...options });

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

const fetchRelease = async () => new Response(null, { status: 302, headers: { location: "/DaleXiao/codex-copilot-dx/releases/tag/v0.9.19" } });

test("package update: builds fixed npm and GitHub global install commands", () => {
  assert.equal(normalizeUpdateSource("gh"), "github");
  assert.deepEqual(globalUpdateCommand("npm", { platform: "darwin" }), {
    command: "npm",
    args: ["install", "--global", "codex-copilot-dx@latest"],
    source: "npm",
  });
  assert.deepEqual(globalUpdateCommand("github", { platform: "win32", releaseTag: "v0.9.19" }), {
    command: "npm.cmd",
    args: ["install", "--global", "https://github.com/DaleXiao/codex-copilot-dx/releases/download/v0.9.19/codex-copilot-dx-0.9.19.tgz"],
    source: "github",
  });
  assert.throws(() => globalUpdateCommand("other"), /Choose npm or github/);
  for (const releaseTag of [undefined, "main", "v1.2.3-beta", "v1.2.3#main", "v1.2.3\n", 'v1.2.3"',
    "v1.2.3&echo injected", "v1.2.3|whoami", "v1.2.3%PATH%", "v1.2.3!injected!", "v1.2.3^&echo", "v1.2.3\r\n"]) {
    assert.throws(() => globalUpdateCommand("github", { releaseTag }), /valid stable GitHub release tag/);
  }
});

test("package update: POSIX direct source works without a terminal and never uses a shell", async () => {
  const calls = [];
  const output = outputBuffer(false);
  const env = { PATH: "/test/bin" };
  const result = await runPackageUpdateCommand({
    env,
    platform: "darwin",
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
    options: { env, shell: false, stdio: ["inherit", "inherit", "pipe"] },
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
    env: { SystemRoot: "D:\\Windows", ComSpec: "C:\\unrelated\\shell.exe" },
    prompt: async () => answers.shift(),
    spawnImpl: successfulSpawn(calls),
    fetchImpl: fetchRelease,
  });

  assert.equal(result.source, "github");
  assert.equal(calls[0].command, "D:\\Windows\\System32\\cmd.exe");
  assert.deepEqual(calls[0].args, ["/d", "/s", "/v:off", "/c", '"npm.cmd install --global ./codex-copilot-dx-0.9.19.tgz"']);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.windowsVerbatimArguments, true);
  assert.equal(calls[0].options.windowsHide, true);
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
    source: "gh", env, platform: "darwin", output: output.stream, spawnImpl: successfulSpawn(calls),
    fetchImpl: async () => { lookups++; return new Response(null, { status: 302, headers: { location: "/DaleXiao/codex-copilot-dx/releases/tag/v1.2.3" } }); },
  });
  assert.equal(lookups, 1);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ["install", "--global", "./codex-copilot-dx-1.2.3.tgz"]);
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

test("Windows npm update preserves environment and uses only a fixed command through system cmd.exe", async () => {
  const env = Object.freeze({ WINDIR: "C:\\Windows", PATH: "C:\\Program Files\\nodejs;C:\\npm", npm_config_registry: "https://company.example/npm" });
  const calls = [], output = outputBuffer(false);
  await runPackageUpdateCommand({ env, platform: "win32", source: "npm", output: output.stream,
    spawnImpl: successfulSpawn(calls), fetchImpl() { assert.fail("npm source does not look up a release"); } });
  assert.deepEqual(calls[0], { command: "C:\\Windows\\System32\\cmd.exe",
    args: ["/d", "/s", "/v:off", "/c", '"npm.cmd install --global codex-copilot-dx@latest"'],
    options: { env, shell: false, stdio: ["inherit", "inherit", "pipe"], windowsVerbatimArguments: true, windowsHide: true } });
  assert.equal(calls[0].options.env, env);
  assert.match(output.text(), /Updated codex-copilot-dx/);
});

test("POSIX sources retain exact argv and no Windows launcher flags", async () => {
  for (const platform of ["darwin", "linux"]) for (const source of ["npm", "github"]) {
    const calls = [], env = Object.freeze({ PATH: "/company/bin" });
    await runPackageUpdateCommand({ env, platform, source, output: outputBuffer(false).stream,
      spawnImpl: successfulSpawn(calls), fetchImpl: fetchRelease });
    assert.equal(calls[0].command, "npm");
    assert.deepEqual(calls[0].args, globalUpdateCommand(source, { platform, releaseTag: "v0.9.19", ...(source === "github" ? { releaseFile: "./codex-copilot-dx-0.9.19.tgz" } : {}) }).args);
    assert.deepEqual({ ...calls[0].options, cwd: undefined }, { env, shell: false, stdio: ["inherit", "inherit", "pipe"], cwd: undefined });
  }
});

test("Windows invalid source or hostile release metadata cannot reach the command interpreter", async () => {
  const spawnImpl = () => assert.fail("invalid metadata must not start an installer");
  await assert.rejects(runPackageUpdateCommand({ platform: "win32", source: "npm & whoami", spawnImpl }), /Choose npm or github/);
  for (const tag_name of ['v1.2.3" & whoami', "v1.2.3%PATH%", "v1.2.3!var!", "v1.2.3\r\nwhoami"]) {
    await assert.rejects(runPackageUpdateCommand({ platform: "win32", source: "github", spawnImpl,
      output: outputBuffer(false).stream, fetchImpl: async () => Response.json({ tag_name, draft: false, prerelease: false }),
    }), /No update was installed/);
  }
});

test("synchronous launch errors and signalled exits do not print update success", async () => {
  const output = outputBuffer(false);
  await assert.rejects(runPackageUpdateCommand({ platform: "win32", source: "npm", output: output.stream,
    spawnImpl() { throw Object.assign(new Error("fixture launch failure"), { code: "EINVAL" }); } }), /fixture launch failure/);
  await assert.rejects(runPackageUpdateCommand({ platform: "win32", source: "npm", output: output.stream,
    spawnImpl() { const child = new EventEmitter();queueMicrotask(() => child.emit("exit", null, "SIGINT"));return child; } }), /interrupted by SIGINT/);
  assert.doesNotMatch(output.text(), /Updated codex-copilot-dx/);
});

test("update preflight detects a different global prefix without changing the caller environment", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-update-env-"));t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const windows = process.platform === "win32";
  const prefix = path.join(root, "chosen");
  const target = path.join(prefix, ...(windows ? [] : ["lib"]), "node_modules", "codex-copilot-dx");
  fs.writeFileSync(path.join(root, windows ? "npm.cmd" : "npm"), "fixture");
  const env = Object.freeze({ PATH: root, npm_config_prefix: prefix });
  const result = inspectPackageUpdateEnvironment({ env, nodePath: process.execPath,
    packageRoot: path.join(root, "original", "node_modules", "codex-copilot-dx"), exec(command, args, options) {
      assert.equal(windows ? path.basename(command) : command, windows ? "cmd.exe" : "npm");
      assert.deepEqual(args, windows ? ["/d", "/s", "/v:off", "/c", '"npm.cmd prefix --global"'] : ["prefix", "--global"]);
      assert.equal(options.env, env);assert.deepEqual(options.stdio, ["ignore", "pipe", "pipe"]);return `${prefix}\n`;
    } });
  assert.equal(result.state, "different");assert.equal(result.target, target);
  assert.equal(result.node, process.execPath);assert.equal(env.PATH, root);
  assert.equal(inspectPackageUpdateEnvironment({ env, packageRoot: result.target, exec: () => prefix }).state, "matched");
  assert.equal(inspectPackageUpdateEnvironment({ env, packageRoot: root, exec: () => prefix }).state, "checkout");
  assert.equal(inspectPackageUpdateEnvironment({ env: { PATH: "" }, exec() { assert.fail(); } }).state, "unavailable");
  assert.equal(inspectPackageUpdateEnvironment({ env, exec: () => `${prefix}\nextra` }).state, "unavailable");
});

test("a mismatched npm prefix warns but preserves an explicit user's installation choice", async () => {
  const calls = [], output = outputBuffer(false);
  await runActualUpdate({ verifyRuntimeFn() {}, source: "npm", platform: "darwin", output: output.stream, spawnImpl: successfulSpawn(calls),
    verifyInstalledFn: () => "0.9.35",
    inspectEnvironmentFn: () => ({ state: "different", target: "/chosen", package_root: "/original" }) });
  assert.match(output.text(), /Existing PATH and prefix choices were preserved/);assert.equal(calls.length, 1);
});

test("installation verification checks bounded target metadata and the exact GitHub release", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-update-result-"));t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "package.json");
  for (const value of [{ name: "other", version: "1.2.3" }, { name: "codex-copilot-dx", version: "invalid" }, { name: "codex-copilot-dx", version: "1.2.2" }]) {
    fs.writeFileSync(file, JSON.stringify(value));
    assert.throws(() => verifyInstalledPackage(root, { expectedVersion: "1.2.3" }), /could not be verified/);
  }
  fs.writeFileSync(file, JSON.stringify({ name: "codex-copilot-dx", version: "1.2.3" }));
  assert.equal(verifyInstalledPackage(root, { expectedVersion: "1.2.3" }), "1.2.3");
  assert.equal(verifyInstalledPackage(root), "1.2.3");
  fs.writeFileSync(file, "x".repeat(1024 * 1024 + 1));
  assert.throws(() => verifyInstalledPackage(root), /could not be verified/);
  assert.equal(verifyInstalledPackage(null), null);
});

test("a zero installer exit cannot announce an unverified update or change service state", async () => {
  const output = outputBuffer(false), calls = [];
  await assert.rejects(runPackageUpdateCommand({ source: "github", platform: "darwin", output: output.stream, fetchImpl: fetchRelease,
    spawnImpl: successfulSpawn(calls), verifyInstalledFn(target, options) {
      assert.equal(target, "/fixture/package");assert.equal(options.expectedVersion, "0.9.19");throw new Error("verification fixture failed");
    } }), /verification fixture failed/);
  assert.equal(calls.length, 1);assert.doesNotMatch(output.text(), /Updated codex-copilot-dx/);
  await runPackageUpdateCommand({ source: "npm", platform: "darwin", output: output.stream, spawnImpl: successfulSpawn(calls), verifyInstalledFn: () => null });
  assert.match(output.text(), /installed version was not verified/);
  assert.doesNotMatch(output.text(), /Updated codex-copilot-dx/);
});

test("readonly npm policy probe requests only named safe fields and hides registry credentials", () => {
  for (const platform of ["darwin", "linux", "win32"]) {
    const calls = [], env = Object.freeze({ SystemRoot: "C:\\Windows" });
    const policy = inspectNpmDownloadPolicy({ platform, env, exec(command, args, opts) {
      calls.push({ command, args });assert.equal(opts.env, env);assert.equal(opts.shell, false);
      assert.deepEqual(opts.stdio, ["ignore", "pipe", "pipe"]);assert.equal(opts.timeout, 3000);
      return calls.length === 1 ? "12.0.1\n" : "allow-remote=none\r\nregistry=https://alice:secret@mirror.test/npm/?token=private\r\n";
    } });
    assert.deepEqual(policy, { version: "12.0.1", allowRemote: "none", registryOrigin: "https://mirror.test", supported: true });
    assert.equal(calls.length, 2);assert.doesNotMatch(JSON.stringify(policy), /alice|secret|private/);
    assert.deepEqual(calls[1].args, platform === "win32" ? ["/d", "/s", "/v:off", "/c", '"npm.cmd config get --global allow-remote registry"'] : ["config", "get", "--global", "allow-remote", "registry"]);
  }
  let calls = 0;
  assert.equal(inspectNpmDownloadPolicy({ exec() { calls++;return "10.9.3"; } }).supported, false);assert.equal(calls, 1);
  assert.equal(inspectNpmDownloadPolicy({ exec() { throw Error("probe unavailable"); } }).supported, null);
});

test("strict policy is preserved by default, with no retry or success on failure", async () => {
  let installs = 0;const output = outputBuffer(false);
  await assert.rejects(runPackageUpdateCommand({ source: "github", fetchImpl: fetchRelease, output: output.stream,
    inspectPolicyFn: () => ({ version: "12.0.1", allowRemote: "none", supported: true, registryOrigin: "https://mirror.test" }),
    spawnImpl(command, args, opts) { installs++;assert.ok(!args.some(value => value.includes("--allow-remote")));const child = new EventEmitter();queueMicrotask(() => child.emit("exit", 1));return child; },
  }), error => error.npmExitCode === 1 && /If npm reported EALLOWREMOTE/.test(error.message) && /update github --allow-remote/.test(error.message));
  assert.equal(installs, 1);assert.doesNotMatch(output.text(), /Updated codex/);
});

test("only a confirmed npm remote-policy refusal retries the pinned GitHub version with an offline complete package", async () => {
  for (const platform of ["darwin", "win32", "linux"]) for (const code of ["EALLOWREMOTE", "EINTEGRITY", "E403"]) {
    const calls = [], events = [], output = outputBuffer(false), downloads = [];
    const target = `${platform}-${process.arch}${platform === "linux" ? process.report.getReport().header.glibcVersionRuntime ? "-glibc" : "-musl" : ""}`;
    const task = runPackageUpdateCommand({ source: "github", platform, output: output.stream, fetchImpl: fetchRelease,
      downloadReleaseFn: async (tag, options) => {
        downloads.push({ tag, complete: options.complete === true });
        if (options.complete) assert.deepEqual(events, ["rollback"]);
        return { name: `codex-copilot-dx-0.9.19${options.complete ? "-" + target : ""}.tgz`, complete: options.complete === true };
      },
      protectInstallationFn: () => ({ rollback: () => events.push("rollback"), commit: () => events.push("commit") }),
      spawnImpl(command, args) {
        calls.push(args);const child = new EventEmitter();child.stderr = new PassThrough();
        queueMicrotask(() => {
          if (calls.length === 1) child.stderr.end(`npm error code ${code}\n` + "bounded synthetic output\n".repeat(30));
          else child.stderr.end();
          child.emit("exit", calls.length === 1 ? 1 : 0);
        });return child;
      },
    });
    if (code === "EALLOWREMOTE") {
      await task;assert.equal(calls.length, 2);assert.match(calls[1].join(" "), /(?:^|\s)--offline(?:\s|$)/);
      assert.match(calls[1].join(" "), /(?:^|\s)--ignore-scripts(?:\s|$)/);assert.deepEqual(events, ["rollback", "commit"]);
      assert.deepEqual(downloads, [{ tag: "v0.9.19", complete: false }, { tag: "v0.9.19", complete: true }]);
    } else { await assert.rejects(task, /status 1/);assert.equal(calls.length, 1);assert.equal(downloads.length, 1); }
    assert.ok(calls.every(args => !args.some(arg => arg.includes("--allow-remote"))));
  }
});

test("only explicit per-update consent adds the fixed remote flag on all platforms", async () => {
  for (const platform of ["win32", "darwin", "linux"]) for (const source of ["npm", "github"]) {
    const calls = [], output = outputBuffer(false), env = Object.freeze({ SystemRoot: "C:\\Windows", npm_config_allow_remote: "none", npm_config_registry: "https://mirror.test/npm/" });
    await runPackageUpdateCommand({ source, allowRemote: true, platform, env, output: output.stream, fetchImpl: fetchRelease,
      inspectPolicyFn: () => ({ version: "12.0.1", allowRemote: "none", supported: true }), spawnImpl: successfulSpawn(calls) });
    const args = calls[0].args;assert.ok(platform === "win32" ? args.at(-1).includes("--allow-remote=all") : args.includes("--allow-remote=all"));
    assert.equal(calls[0].options.env, env);assert.equal(env.npm_config_allow_remote, "none");
    assert.match(output.text(), /throughout the selected package's dependency tree/);assert.equal(calls.length, 1);
  }
});

test("unknown permission support fails before installation only for an explicit opt-in; unsupported older npm receives no unknown flag", async () => {
  const calls = [], output = outputBuffer(false);
  await assert.rejects(runPackageUpdateCommand({ source: "npm", allowRemote: true, output: output.stream,
    inspectPolicyFn: () => ({ supported: null }), spawnImpl: () => assert.fail("no unsupported override") }), /no installation was started/);
  await runPackageUpdateCommand({ source: "npm", allowRemote: true, output: output.stream, spawnImpl: successfulSpawn(calls) });
  assert.ok(!calls[0].args.some(value => value.includes("--allow-remote")));
  assert.throws(() => globalUpdateCommand("npm", { allowRemote: "all & whoami" }), /boolean/);
});
