import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { installedPredictionApp, predictionAppMatches } from "../src/native-prediction-app.mjs";

function fixture(t) {
  const app = "/Applications/ChatGPT.app", metadata = app + "/Contents/Info.plist", executable = app + "/Contents/MacOS/ChatGPT";
  let generation = 1;
  t.mock.method(fs, "existsSync", file => file === metadata);
  t.mock.method(fs, "statSync", file => {
    assert.ok([metadata, executable].includes(file), "App archives and renderer files must never be inspected");
    return { isFile: () => true, size: 100, mtimeMs: generation };
  });
  return { app, metadata, executable, change() { generation++; },
    info: JSON.stringify({ CFBundleIdentifier: "com.openai.codex", CFBundleExecutable: "ChatGPT" }) };
}

test("prediction discovery verifies system identity without requiring an App archive or protocol strings", async t => {
  const f = fixture(t), calls = [];
  const exec = async (command, args, options) => {
    calls.push(command);assert.ok(options.timeout <= 15000);
    if (command.endsWith("plutil")) return { stdout: f.info };
    assert.ok(args.includes("--strict"));assert.match(args[args.indexOf("-R") + 1], /com\.openai\.codex/);
    return { stdout: "" };
  };
  const app = await installedPredictionApp({ platform: "darwin", exec });
  assert.equal(app.identity_version, 2);assert.equal(app.archive, undefined);assert.equal(predictionAppMatches(app), true);
  await installedPredictionApp({ platform: "darwin", exec });
  assert.equal(calls.filter(s => s.endsWith("codesign")).length, 1);
  f.change();assert.equal(predictionAppMatches(app), false);
  await installedPredictionApp({ platform: "darwin", exec });
  assert.equal(calls.filter(s => s.endsWith("codesign")).length, 2);
});

test("concurrent signature checks share asynchronous work while the event loop remains responsive", async t => {
  const f = fixture(t);let finish, signatures = 0;
  const exec = async command => {
    if (command.endsWith("plutil")) return { stdout: f.info };
    signatures++;await new Promise(resolve => { finish = resolve; });return { stdout: "" };
  };
  const pending = [installedPredictionApp({ platform: "darwin", exec }), installedPredictionApp({ platform: "darwin", exec })];
  await new Promise(resolve => setImmediate(resolve));assert.equal(signatures, 1);assert.equal(typeof finish, "function");
  finish();const apps = await Promise.all(pending);assert.deepEqual(apps[0], apps[1]);assert.notEqual(apps[0], apps[1]);
});

test("foreign identities, signature failures and updates during verification are not adopted", async t => {
  const f = fixture(t);
  await assert.rejects(installedPredictionApp({ platform: "darwin", exec: async () => ({ stdout: f.info.replace("com.openai.codex", "com.example.other") }) }), /Unknown Codex/);
  let calls = 0;
  const invalid = async command => {
    if (command.endsWith("plutil")) return { stdout: f.info };
    calls++;throw Error("invalid signature fixture");
  };
  for (let i = 0; i < 2; i++) await assert.rejects(installedPredictionApp({ platform: "darwin", exec: invalid }), /invalid signature/);
  assert.equal(calls, 2, "failed verification must not become a cached success");
  await assert.rejects(installedPredictionApp({ platform: "darwin", exec: async command => {
    if (command.endsWith("plutil")) return { stdout: f.info };
    f.change();return { stdout: "" };
  } }), /changed during/);
  assert.equal(predictionAppMatches({ app: f.app, archive: "old-layout", size: 1, mtimeMs: 1 }), false);
});
