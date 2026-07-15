import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  checkForUpdate,
  fetchLatestVersion,
  isVersionGreater,
  localPackageVersion,
} from "../src/version.mjs";

test("localPackageVersion: reads package.json version", () => {
  assert.match(localPackageVersion(), /^\d+\.\d+\.\d+/);
});

test("package requires the first Node release line with built-in zstd", () => {
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.engines.node, ">=22.15.0");
  assert.equal(pkg.author, "Dale Xiao");
});

test("isVersionGreater: compares numeric semver parts", () => {
  assert.equal(isVersionGreater("0.4.2", "0.4.1"), true);
  assert.equal(isVersionGreater("0.5.0", "0.4.9"), true);
  assert.equal(isVersionGreater("1.0.0", "0.9.9"), true);
  assert.equal(isVersionGreater("0.4.1", "0.4.1"), false);
  assert.equal(isVersionGreater("0.4.0", "0.4.1"), false);
});

test("fetchLatestVersion: returns version from registry response", async () => {
  const latest = await fetchLatestVersion({
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ version: "0.4.2" }),
    }),
  });
  assert.equal(latest, "0.4.2");
});

test("fetchLatestVersion: returns null on network or malformed response", async () => {
  assert.equal(await fetchLatestVersion({ fetchImpl: async () => ({ ok: false }) }), null);
  assert.equal(await fetchLatestVersion({ fetchImpl: async () => ({ ok: true, json: async () => ({}) }) }), null);
  assert.equal(await fetchLatestVersion({ fetchImpl: async () => { throw new Error("offline"); } }), null);
});

test("checkForUpdate: reports update availability", async () => {
  const result = await checkForUpdate({
    currentVersion: "0.4.1",
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ version: "0.4.2" }),
    }),
  });
  assert.equal(result.currentVersion, "0.4.1");
  assert.equal(result.latestVersion, "0.4.2");
  assert.equal(result.updateAvailable, true);
});
