import { test } from "node:test";
import assert from "node:assert/strict";
import { githubReauthMessage, interpretPoll } from "../src/auth.mjs";

test("interpretPoll: access_token returns done", () => {
  assert.deepEqual(interpretPoll({ access_token: "gho_x" }), { state: "done", token: "gho_x" });
});

test("interpretPoll: authorization_pending returns wait", () => {
  assert.deepEqual(interpretPoll({ error: "authorization_pending" }), { state: "wait" });
});

test("interpretPoll: slow_down returns slow", () => {
  assert.deepEqual(interpretPoll({ error: "slow_down" }), { state: "slow" });
});

test("interpretPoll: expired_token returns fail", () => {
  assert.deepEqual(interpretPoll({ error: "expired_token" }), { state: "fail", error: "expired_token" });
});

test("interpretPoll: unknown errors return fail", () => {
  assert.deepEqual(interpretPoll({ error: "access_denied" }), { state: "fail", error: "access_denied" });
});

test("interpretPoll: empty access_token is not done", () => {
  assert.equal(interpretPoll({ access_token: "" }).state, "fail");
});

test("githubReauthMessage: points users to the token file and login command", () => {
  const message = githubReauthMessage("Saved token is invalid.", "/tmp/ccdx-home");
  assert.match(message, /Saved token is invalid\./);
  assert.match(message, /rm '\/tmp\/ccdx-home\/\.local\/share\/copilot-api\/github_token'/);
  assert.match(message, /codex-copilot-dx/);
});
