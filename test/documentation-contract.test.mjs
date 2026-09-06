import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseCliArgs } from "../src/cli-options.mjs";
import { loadRuntimeConfig } from "../src/runtime-config.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");

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
  const source = ["src", "bin"].flatMap((directory) => fs.readdirSync(path.join(root, directory))
    .filter((name) => name.endsWith(".mjs"))
    .map((name) => fs.readFileSync(path.join(root, directory, name), "utf8"))).join("\n");
  const variables = new Set([
    ...[...source.matchAll(/\b(?:env|process\.env)\.((?:CCDX|ADAPTER)_[A-Z0-9_]+)/g)].map((match) => match[1]),
    ...[...source.matchAll(/integerEnv\(env, "((?:CCDX|ADAPTER)_[A-Z0-9_]+)"/g)].map((match) => match[1]),
  ]);
  for (const variable of variables) assert.ok(readme.includes(`\`${variable}\``), `${variable} is undocumented`);
  const commands = [...readme.matchAll(/^ccdx(?: ([^\n]+))?$/gm)];
  assert.ok(commands.length >= 10);
  for (const [, argumentsText = ""] of commands) assert.doesNotThrow(() => parseCliArgs(argumentsText ? argumentsText.split(/\s+/) : []));
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
