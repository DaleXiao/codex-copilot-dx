import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseCliArgs } from "../src/cli-options.mjs";
import { loadRuntimeConfig } from "../src/runtime-config.mjs";
import { startupReady } from "../src/startup-ui.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const readme = fs.readFileSync(path.join(root, "README.md"), "utf8")
  + "\n" + fs.readFileSync(path.join(root, "docs/REFERENCE.md"), "utf8");

test("current installation links and both bootstrap scripts target the shipped package", () => {
  const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"))).version;
  const links = [...readme.matchAll(/https:\/\/github\.com\/DaleXiao\/codex-copilot-dx\/releases\/download\/v([\d.]+)\/(install\.(?:sh|ps1)|codex-copilot-dx-[\d.]+\.tgz)/gi)];
  assert.ok(links.some(link => link[2] === "install.sh"));
  assert.ok(links.some(link => link[2] === "install.ps1"));
  for (const [, tag, asset] of links) {
    assert.equal(tag, version);
    if (asset.endsWith(".tgz")) assert.equal(asset, `codex-copilot-dx-${version}.tgz`);
  }
  assert.ok(fs.readFileSync(path.join(root, "install/install.sh"), "utf8").includes(`version=${version}`));
  assert.ok(fs.readFileSync(path.join(root, "install/install.ps1"), "utf8").includes(`$version = '${version}'`));
});


test("documented runtime defaults match the runtime configuration", () => {
  const source = fs.readFileSync(path.join(root, "src/runtime-config.mjs"), "utf8");
  const bindings = [...source.matchAll(/(\w+):\s*parse(?:TimerMs|PositiveInteger|SafePositiveInteger)\(\s*env\.(CCDX_[A-Z0-9_]+)/g)];
  const defaults = loadRuntimeConfig({});
  assert.equal(bindings.length, Object.keys(defaults).length);
  for (const [, property, variable] of bindings) {
    assert.ok(readme.includes(`| \`${variable}\` | \`${defaults[property]}\` |`), `${variable} default is missing or stale`);
  }
});

test("public environment controls and README command examples match code", () => {
  for (const variable of ["ADAPTER_HOST", "ADAPTER_PORT", "CCDX_M365", "CCDX_AUTO_LAUNCH", "CCDX_USAGE_PATH", "CCDX_LOG_LEVEL", "CCDX_LOG_PATH"]) {
    assert.ok(readme.includes(`\`${variable}\``), `${variable} is undocumented`);
  }
  const quickStart = fs.readFileSync(path.join(root, "README.md"), "utf8");
  const commands = [...quickStart.matchAll(/`(ccdx(?: [^`\n]+)?)`/g)].map(match => match[1]).filter(command => !/[<>\[\]|…]/.test(command));
  assert.ok(commands.length >= 10);
  for (const command of commands) assert.doesNotThrow(() => parseCliArgs(command.split(/\s+/).slice(1)), command);
});

test("startup advertises the canonical help command on new and reused adapters", () => {
  const source = fs.readFileSync(path.join(root, "bin/cli.mjs"), "utf8");
  assert.equal(source.match(/console\.log\(startupReady\(/g)?.length, 2);
  for (const reused of [false, true]) assert.match(startupReady({ reused }), /Help    ccdx help/);
});

test("documentation local links resolve and release reports identify their historical scope", () => {
  const files = ["README.md", "scripts/fixtures/README.md", ...fs.readdirSync(path.join(root, "docs")).filter((name) => name.endsWith(".md")).map((name) => `docs/${name}`)];
  for (const relative of files) {
    const absolute = path.join(root, relative);
    const content = fs.readFileSync(absolute, "utf8");
    for (const [, target] of content.matchAll(/\]\(([^\s)]+)\)/g)) {
      if (/^(?:https?:|#)/.test(target)) continue;
      assert.ok(fs.existsSync(path.resolve(path.dirname(absolute), target.split("#")[0])), `${relative}: broken link ${target}`);
    }
    if (/RELEASE_0\.7\.[345]\.md$/.test(relative)) assert.match(content, /Historical verification/);
  }
});
