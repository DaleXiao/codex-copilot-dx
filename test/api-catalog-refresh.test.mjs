import test from "node:test";
import assert from "node:assert/strict";
import { createApiCatalogRefresh } from "../src/api-catalog-refresh.mjs";

const deferred = () => { let resolve;const promise = new Promise(done => { resolve = done; });return { promise, resolve }; };
test("catalog reads join, cancel obsolete generations and publish only current results", async () => {
  let selected = { enabled: true, version: "one", models: [] }, releases = 0;
  const pending = [], commits = [], states = [];
  const refresh = createApiCatalogRefresh({ config: () => selected, revision: item => item.version,
    source: () => ({ discover({ signal }) { const read = deferred();pending.push({ ...read, signal });return read.promise; } }),
    track: () => () => { releases++; }, commit: async (_id, models, _version, _at, active) => { assert.ok(active());commits.push(models); }, onState: (_id, state) => states.push(state) });
  const first = refresh.refresh("api"), joined = refresh.refresh("api");
  assert.equal(pending.length, 1);
  selected = { ...selected, version: "two" };refresh.invalidate();assert.equal(pending[0].signal.aborted, true);
  const old = Promise.allSettled([first, joined]);const second = refresh.refresh("api");
  pending[0].resolve([{ id: "old" }]);pending[1].resolve([{ id: "current" }]);
  assert.ok((await old).every(result => result.status === "rejected"));await second;
  assert.deepEqual(commits, [[{ id: "current" }]]);assert.equal(releases, 2);assert.equal(states.at(-1).state, "ready");
  await refresh.close();
});

test("explicit cancellation preserves last-good results and does not record a failed read", async () => {
  const read = deferred(), states = [];let release = 0, commits = 0;
  const refresh = createApiCatalogRefresh({ config: () => ({ enabled: true, models: [] }), revision: () => "same",
    source: () => ({ discover: () => read.promise }), track: () => () => { release++; }, commit: async () => { commits++; }, onState: (_id, state) => states.push(state) });
  const job = refresh.refresh("api");refresh.cancel("api");const settled = assert.rejects(job, { code: "ccdx_connections_conflict" });
  read.resolve([{ id: "cancelled" }]);await settled;assert.equal(commits, 0);assert.equal(release, 1);assert.equal(states.at(-1).state, "cancelled");await refresh.close();
});
