import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("published source lock pins versions/integrity without a developer's company mirror", () => {
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url)));
  const lock = JSON.parse(fs.readFileSync(new URL("../package-lock.json", import.meta.url)));
  for (const [name, version] of Object.entries({ ...pkg.dependencies, ...pkg.optionalDependencies })) {
    const entry = lock.packages[`node_modules/${name}`];assert.equal(entry.version, version);
    assert.match(entry.integrity, /^sha(?:1|256|384|512)-/);
  }
  for (const entry of Object.values(lock.packages)) if (entry.resolved) assert.equal(new URL(entry.resolved).origin, "https://registry.npmjs.org");
});
