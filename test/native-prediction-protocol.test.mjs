import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inspectPredictionArchive } from "../src/native-prediction-protocol.mjs";
import { installedPredictionApp } from "../src/native-prediction-profile.mjs";

function archive(t, { main = { "main-real.js": "/wham/predictions/config experimentalPredictionMode" },
  settings = { "general-settings-forward.js": 'export * from "./general-settings-real.js"', "general-settings-real.js": "4290031608" }, changeHeader } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-protocol-"));t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const chunks = [];let offset = 0;
  const entries = values => Object.fromEntries(Object.entries(values).map(([name, text]) => {
    const bytes = Buffer.from(text), item = { size: bytes.length, offset: String(offset) };chunks.push(bytes);offset += bytes.length;return [name, item];
  }));
  const tree = { files: { ".vite": { files: { build: { files: entries(main) } } }, webview: { files: { assets: { files: entries(settings) } } } } };
  changeHeader?.(tree);
  const header = Buffer.from(JSON.stringify(tree)), prefix = Buffer.alloc(16);prefix.writeUInt32LE(8 + header.length, 4);prefix.writeUInt32LE(header.length, 12);
  const file = path.join(root, "app.asar");fs.writeFileSync(file, Buffer.concat([prefix, header, ...chunks]));return file;
}

test("protocol recognition accepts forwarding chunks in either order without broad archive scanning", t => {
  for (const settings of [{ "general-settings-forward.js": "shim", "general-settings-real.js": "4290031608" },
    { "general-settings-real.js": "4290031608", "general-settings-forward.js": "shim" }]) {
    const file = archive(t, { settings, main: { "main-forward.js": "shim", "main-real.js": "/wham/predictions/config experimentalPredictionMode" } });
    assert.equal(inspectPredictionArchive(file).compatible, true);
  }
  assert.equal(inspectPredictionArchive(archive(t, { settings: { "general-settings-real.js": "no prediction gate" } })).compatible, false);
  assert.equal(inspectPredictionArchive(archive(t, { main: { "main-real.js": "experimentalPredictionMode" } })).compatible, false);
});

test("malformed offsets, oversized entries/headers and excessive candidates fail closed", t => {
  for (const mutate of [tree => { tree.files[".vite"].files.build.files["main-real.js"].offset = "-999999"; },
    tree => { tree.files[".vite"].files.build.files["main-real.js"].size = 32 * 1024 * 1024 + 1; },
    tree => { tree.files[".vite"].files.build.files["main-real.js"].offset = "NaN"; }]) {
    assert.throws(() => inspectPredictionArchive(archive(t, { changeHeader: mutate })), /bounds|inspection limit/);
  }
  const file = archive(t);const fd = fs.openSync(file, "r+");try { const size = Buffer.alloc(4);size.writeUInt32LE(32 * 1024 * 1024 + 1);fs.writeSync(fd, size, 0, 4, 12); } finally { fs.closeSync(fd); }
  assert.throws(() => inspectPredictionArchive(file), /header exceeds/);
  const settings = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`general-settings-${i}.js`, "4290031608"]));
  assert.throws(() => inspectPredictionArchive(archive(t, { settings })), /candidates exceed/);
});

test("recognizing a real settings chunk still requires platform signature verification", t => {
  const file = archive(t), realExists = fs.existsSync, realInspectOpen = fs.openSync, realStat = fs.statSync;
  const target = path.join("/Applications/ChatGPT.app", "Contents", "Resources", "app.asar");
  const alternate = path.join("/Applications/Codex.app", "Contents", "Resources", "app.asar");
  t.mock.method(fs, "existsSync", value => value === target || (value === alternate ? false : realExists(value)));
  t.mock.method(fs, "openSync", (value, ...args) => realInspectOpen(value === target ? file : value, ...args));
  t.mock.method(fs, "statSync", (value, ...args) => realStat(value === target ? file : value, ...args));
  let checks = 0;
  const app = installedPredictionApp({ platform: "darwin", exec(command, args) { checks++;assert.equal(command, "/usr/bin/codesign");assert.ok(args.includes("--strict")); } });
  assert.equal(checks, 1);assert.equal(app.app, "/Applications/ChatGPT.app");
  assert.throws(() => installedPredictionApp({ platform: "darwin", exec() { throw new Error("signature fixture invalid"); } }), /signature fixture invalid/);
});
