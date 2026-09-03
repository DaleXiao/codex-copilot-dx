import { test } from "node:test";
import assert from "node:assert/strict";
import { profileRouting } from "../src/profile-routing.mjs";

test("profileRouting exposes the single Codex Responses route", () => {
  const routing = profileRouting();
  assert.deepEqual(routing, { responses: "codex" });
  assert.equal(Object.isFrozen(routing), true);
});
