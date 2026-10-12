import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  checkForUpdate,
  fetchLatestVersion,
  fetchLatestRelease,
  lookupLatestRelease,
  githubReleaseVersion,
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

const releaseResponse = (tag = "v0.4.2", overrides = {}) => new Response(null, { status: 302, headers: {
  location: `/DaleXiao/codex-copilot-dx/releases/tag/${overrides.tag_name ?? tag}${Object.keys(overrides).length && !overrides.tag_name ? "-invalid" : ""}`,
} });

test("fetchLatestVersion: anonymously checks only the fixed GitHub release endpoint", async () => {
  const calls = [];
  const latest = await fetchLatestVersion({
    fetchImpl: async (url, options) => { calls.push({ url, options }); return releaseResponse(); },
  });
  assert.equal(latest, "0.4.2");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://github.com/DaleXiao/codex-copilot-dx/releases/latest");
  assert.equal(calls[0].options.redirect, "manual");
  assert.deepEqual(calls[0].options.headers, { Accept: "text/html", "User-Agent": "codex-copilot-dx" });
});

test("fetchLatestVersion: returns null on network or malformed response", async () => {
  assert.equal(await fetchLatestVersion({ fetchImpl: async () => new Response("limited", { status: 403 }) }), null);
  assert.equal(await fetchLatestVersion({ fetchImpl: async () => Response.json({}) }), null);
  assert.equal(await fetchLatestVersion({ fetchImpl: async () => new Response("{") }), null);
  assert.equal(await fetchLatestVersion({ fetchImpl: async () => { throw new Error("offline"); } }), null);
});

test("checkForUpdate: reports update availability", async () => {
  const result = await checkForUpdate({
    currentVersion: "0.4.1",
    fetchImpl: async () => releaseResponse(),
  });
  assert.equal(result.currentVersion, "0.4.1");
  assert.equal(result.latestVersion, "0.4.2");
  assert.equal(result.updateAvailable, true);
});

test("stable GitHub tags reject prereleases, unsafe text and imprecise numbers", () => {
  assert.equal(githubReleaseVersion("v0.9.19"), "0.9.19");
  assert.equal(githubReleaseVersion("1.2.3"), "1.2.3");
  for (const tag of [null, "", "main", "v01.2.3", "v1.2", "v1.2.3-beta", "v1.2.3+build", " v1.2.3", "v1.2.3\n", "v1.2.3#main", "v1.2.3;echo secret", "v9007199254740992.0.0", "9".repeat(65)]) {
    assert.equal(githubReleaseVersion(tag), null, String(tag));
  }
});

test("release checks reject invalid redirects and prereleases without following them", async () => {
  for (const overrides of [{ tag_name: "main" }, { tag_name: "v1.2.3-beta" }, { tag_name: "v1.2.3?download=1" }, { tag_name: "v1.2.3#main" }, { tag_name: "v1.2.3-rc.1" }]) {
    let calls = 0;
    assert.equal(await fetchLatestRelease({ fetchImpl: async () => { calls++; return releaseResponse("v1.2.3", overrides); } }), null);
    assert.equal(calls, 1);
  }
  assert.deepEqual(await fetchLatestRelease({ fetchImpl: async () => releaseResponse("1.2.3") }), { version: "1.2.3", tagName: "1.2.3" });
  for (const version of ["v0.4.1", "v0.4.0"]) {
    assert.equal((await checkForUpdate({ currentVersion: "0.4.1", fetchImpl: async () => releaseResponse(version) })).updateAvailable, false);
  }
});

test("GitHub HTTP errors cancel bodies and never retry or query npm", async () => {
  for (const status of [403, 404, 429, 500]) {
    let cancelled = false;
    let calls = 0;
    const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status });
    assert.equal(await fetchLatestVersion({ fetchImpl: async () => { calls++; return response; } }), null);
    assert.equal(cancelled, true);
    assert.equal(calls, 1);
  }
});

test("release lookup deadline covers headers; response bodies are never read", async () => {
  let aborted = false;
  assert.equal(await fetchLatestVersion({ timeoutMs: 5, fetchImpl: async (_, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => { aborted = true; reject(new Error("offline")); }, { once: true });
  }) }), null);
  assert.equal(aborted, true);
  let cancelled = false;
  const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 302, headers: { location: "/DaleXiao/codex-copilot-dx/releases/tag/v1.2.3" } });
  assert.equal(await fetchLatestVersion({ timeoutMs: 5, fetchImpl: async () => response }), "1.2.3");
  assert.equal(cancelled, true);
});

test("GitHub HTML is cancelled without any reads or parsing", async () => {
  for (const declared of [false, true]) {
    let cancelled = false;
    let reads = 0;
    const response = new Response(new ReadableStream({
      pull(controller) { reads++; controller.enqueue(new Uint8Array(256 * 1024 + 1)); },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 }), { headers: declared ? { "Content-Length": String(256 * 1024 + 1) } : {} });
    assert.equal(await fetchLatestVersion({ fetchImpl: async () => response }), null);
    assert.equal(cancelled, true);
    assert.equal(reads, 0);
  }
});

test("manual release errors preserve actionable status, timeout and network causes", async () => {
  await assert.rejects(lookupLatestRelease({ fetchImpl: async () => new Response(null, { status: 429 }) }), e => e.code === "github_rate_limit" && e.status === 429);
  await assert.rejects(lookupLatestRelease({ fetchImpl: async () => new Response(null, { status: 404 }) }), e => e.code === "github_http_error");
  await assert.rejects(lookupLatestRelease({ fetchImpl: async () => { throw Object.assign(new Error("failed"), { cause: { code: "ENOTFOUND" } }); } }), e => e.code === "ENOTFOUND");
  await assert.rejects(lookupLatestRelease({ timeoutMs: 5, fetchImpl: async (_, { signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))) }), e => e.code === "github_timeout");
});

test("stable redirects cannot target another repository, host, HTTP origin or credentials", async () => {
  for (const location of ["https://evil.test/DaleXiao/codex-copilot-dx/releases/tag/v1.2.3", "https://github.com/other/repo/releases/tag/v1.2.3", "http://github.com/DaleXiao/codex-copilot-dx/releases/tag/v1.2.3", "https://user@github.com/DaleXiao/codex-copilot-dx/releases/tag/v1.2.3", ""]) {
    assert.equal(await fetchLatestRelease({ fetchImpl: async () => new Response(null, { status: 302, headers: { location } }) }), null);
  }
});
