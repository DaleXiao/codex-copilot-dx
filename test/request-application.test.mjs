import test from "node:test";
import assert from "node:assert/strict";
import { requestApplication, applicationLabel } from "../src/request-application.mjs";

test("application hints are explicit allowlisted labels, with no identity guessed from a user agent", () => {
  for (const [marker, expected] of [["codex-app", "codex_app"], ["codex-cli", "codex_cli"], ["claude-app", "claude_app"], ["claude-code", "claude_code"]]) {
    assert.equal(requestApplication({ "x-ccdx-client": marker }), expected);
  }
  assert.equal(requestApplication({ originator: "codex_desktop" }), "codex_app");
  assert.equal(requestApplication({ originator: "codex_cli_rs" }), "codex_cli");
  assert.equal(requestApplication({ "user-agent": "Claude Desktop", authorization: "secret" }, "claude"), "claude");
  for (const value of [undefined, null, "constructor", "__proto__", "unknown", ["claude-app"], {}]) {
    assert.equal(requestApplication({ "x-ccdx-client": value, originator: value }), "api");
    assert.equal(applicationLabel(value), "api");
  }
  assert.equal(requestApplication(null, "claude"), "claude");
});
