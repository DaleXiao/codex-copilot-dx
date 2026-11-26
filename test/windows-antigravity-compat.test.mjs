import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { inspectWindowsAntigravity } from "../src/windows-antigravity-app.mjs";
import { createWindowsAntigravityManifest, parseWindowsAntigravityManifest, windowsAntigravityManifestUrl } from "../src/windows-antigravity-compat.mjs";

const triple = digits => [...digits].map(digit => digit.repeat(64));
const future = { version: "2.39.1", x64: triple("123"), arm64: triple("456") };
const manifest = { schema: 1, releases: [future] };
const app = String.raw`D:\Developer Tools\Antigravity\Antigravity.exe`;
const version = "2.39.1.0";

test("a verified manifest is available offline after restarting CCDX", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "ccdx-compat-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const options = { env: {}, home };
  const online = createWindowsAntigravityManifest({ persistent: true, getFetch: () => async () => Response.json(manifest) });
  assert.deepEqual(await online(version, options), [future.x64, future.arm64]);
  const offline = createWindowsAntigravityManifest({ persistent: true, getFetch: () => assert.fail("must not need the network") });
  assert.deepEqual(await offline(version, options), [future.x64, future.arm64]);
});

test("recognizes future releases from one bounded fetch and validates all three files", async () => {
  let requests = 0;
  const readBundles = createWindowsAntigravityManifest({ getFetch: () => async (url, options) => {
    requests++;
    assert.equal(url, windowsAntigravityManifestUrl);
    assert.equal(options.redirect, "error");
    return Response.json(manifest);
  } });
  const exec = hashes => async () => ({ stdout: JSON.stringify([{app,version,hashes,pids:[]}]) });
  const inspect = hashes => inspectWindowsAntigravity({ app, readBundles, exec: exec(hashes) });
  const [discovered, x64, arm64, mixed] = await Promise.all([
    inspectWindowsAntigravity({ readBundles, exec: exec() }),
    inspect(future.x64.map(hash => hash.toUpperCase())), inspect(future.arm64), inspect([...future.x64.slice(0, 2), future.arm64[2]]),
  ]);
  assert.equal(discovered.version, version);
  assert.equal(x64.status, "stopped");
  assert.equal(arm64.status, "stopped");
  assert.equal(mixed.status, "unverified_build");
  assert.equal(requests, 1);
});

test("a failed or malformed manifest is throttled and does not authorize an unknown build", async () => {
  let requests = 0, clock = 0;
  const readBundles = createWindowsAntigravityManifest({ now: () => clock, getFetch: () => async () => {
    requests++;
    return requests === 1 ? Response.json({ schema: 2, releases: [] }) : Response.json(manifest);
  } });
  assert.deepEqual(await readBundles(version), []);
  assert.deepEqual(await readBundles(version), []);
  assert.equal(requests, 1);
  clock = 300_000;
  assert.deepEqual(await readBundles(version), [future.x64,future.arm64]);
  assert.equal(requests, 2);
  assert.throws(() => parseWindowsAntigravityManifest({ schema: 1, releases: [future,future] }));
  assert.throws(() => parseWindowsAntigravityManifest({ schema: 1, releases: [{ ...future, arm64: [...future.arm64,"0"] }] }));
});

test("the official Windows 2.35.2 builds and metadata-only discovery work offline", async () => {
  const asar = "e057115571cf5085406d20f2427a5afac272b712ec84332c7157da0113d4b2d0";
  const bundles = [
    ["baa56cfeb0f0934782b60fba2733313822cff5f48606d47c5a463a276f2ed138",asar,"fcdf7454007c6edc8162e601628c28cc1e6f575be849f329bb864c41ba6e6b02"],
    ["9693f0cb3c142fd629d9468275fd33e9d36b64df36d2e9899e7c62726f09e677",asar,"aeb57eb01da844a6bce41f2bc8b8d20d7bc0e1154f57e6ee61a9da6782f6325d"],
  ];
  const readBundles = () => assert.fail("recognized builds and inventory must not fetch metadata");
  for (const hashes of bundles) {
    const exec = async (_command, args) => {
      assert.match(args.at(-1), /121a0be4-63bd-531e-acf8-fc3924c7e984/);
      return { stdout: JSON.stringify([{ app, version: "2.35.2.0", hashes, pids: [] }]) };
    };
    assert.equal((await inspectWindowsAntigravity({ exec, readBundles })).version, "2.35.2.0");
    assert.equal((await inspectWindowsAntigravity({ exec, app, readBundles })).status, "stopped");
  }
});
