import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { inspectApplicationProcesses } from "../src/application-process.mjs";

test("Mac inventory uses verified bundle paths, C-locale dates and no process arguments", async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ccdx-process-check-")), root = path.join(home, "installed");
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const app = path.join(root, "Claude.app"), file = path.join(app, "Contents/Info.plist"), executable = path.join(app, "Contents/MacOS/Claude");
  await fs.mkdir(path.dirname(file), { recursive: true });await fs.writeFile(file, "synthetic");let invalid = false;
  const exec = async (command, args, options) => {
    if (command === "/bin/ps") {
      assert.equal(options.env.LC_ALL, "C");assert.equal(options.env.PRIVATE_TOKEN, undefined);assert.ok(args.includes("pid=,ppid=,lstart=,comm="));
      return { stdout: ` 10 1 ${invalid ? "invalid date" : "Tue Nov 17 10:00:00 2026"} ${executable}\n` };
    }
    return { stdout: JSON.stringify({ CFBundleIdentifier: "com.anthropic.claudefordesktop", CFBundleExecutable: "Claude", CFBundleShortVersionString: "synthetic" }) };
  };
  const options = { home, applicationsRoot: root, platform: "darwin", env: { LANG: "zh_CN", PRIVATE_TOKEN: "synthetic" }, exec };
  assert.equal((await inspectApplicationProcesses(options)).apps.claude_app.status, "running");
  invalid = true;assert.equal((await inspectApplicationProcesses(options)).apps.claude_app.status, "unknown");
});
test("Windows inventory accepts a registered Appx target and treats Electron descendants as one app", async () => {
  const executable = "C:\\Apps\\Claude.exe", target = "shell:AppsFolder\\Anthropic.Claude_x64!Claude", started = "2026-11-17T00:00:00Z";
  const result = await inspectApplicationProcesses({ platform: "win32", env: {}, discoverWindows: () => null, exec: async (_command, args) => {
    assert.ok(args.at(-1).includes("'shell:AppsFolder\\'"));
    return { stdout: JSON.stringify({ claude: { app: executable, target }, processes: [{ pid: 10, parent: 1, started, command: executable }, { pid: 11, parent: 10, started, command: executable.toLowerCase() }] }) };
  } });
  assert.equal(result.apps.claude_app.status, "running");assert.equal(result.apps.claude_app.pid, 10);assert.equal(result.apps.claude_app.target, target);
});
