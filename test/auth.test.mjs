import { test } from "node:test";
import assert from "node:assert/strict";
import { interpretPoll } from "../src/auth.mjs";

test("interpretPoll: 拿到 access_token → done", () => {
  assert.deepEqual(interpretPoll({ access_token: "gho_x" }), { state: "done", token: "gho_x" });
});

test("interpretPoll: authorization_pending → wait", () => {
  assert.deepEqual(interpretPoll({ error: "authorization_pending" }), { state: "wait" });
});

test("interpretPoll: slow_down → slow", () => {
  assert.deepEqual(interpretPoll({ error: "slow_down" }), { state: "slow" });
});

test("interpretPoll: expired_token → fail", () => {
  assert.equal(interpretPoll({ error: "expired_token" }).state, "fail");
});

test("interpretPoll: 未知 error → fail", () => {
  assert.equal(interpretPoll({ error: "access_denied" }).state, "fail");
});
