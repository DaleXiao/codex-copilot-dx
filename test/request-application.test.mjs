import test from "node:test";
import assert from "node:assert/strict";
import { requestApplication, applicationLabel } from "../src/request-application.mjs";

test("application hints recognize real desktop spelling and only known versioned Codex agents", () => {
  for (const [marker, expected] of [["codex-app", "codex_app"], ["codex-cli", "codex_cli"], ["claude-app", "claude_app"], ["claude-code", "claude_code"]]) {
    assert.equal(requestApplication({ "x-ccdx-client": marker }), expected);
  }
  assert.equal(requestApplication({ originator: "codex_desktop" }), "codex_app");
  assert.equal(requestApplication({ originator: "Codex Desktop" }), "codex_app");
  assert.equal(requestApplication({ originator: " CODEX DESKTOP " }), "codex_app");
  assert.equal(requestApplication({ originator: "codex_cli_rs" }), "codex_cli");
  assert.equal(requestApplication({ "user-agent": "Claude Desktop", authorization: "secret" }, "claude"), "claude");
  for (const value of [undefined, null, "constructor", "__proto__", "unknown", ["claude-app"], {}]) {
    assert.equal(requestApplication({ "x-ccdx-client": value, originator: value }), "api");
    assert.equal(applicationLabel(value), "api");
  }
  assert.equal(requestApplication(null, "claude"), "claude");
  assert.equal(requestApplication({ "user-agent": "Codex Desktop/0.163.0-alpha.11.1 (Mac OS 27.0.1; arm64)" }), "codex_app");
  assert.equal(requestApplication({ "user-agent": "codex_cli_rs/0.163.0 (Windows NT 10.0; x86_64)" }), "codex_cli");
  assert.equal(requestApplication({ "user-agent": "codex/0.163.0 (Linux)" }), "codex");
  assert.equal(requestApplication({ originator: "codex_vscode" }), "codex");
  assert.equal(requestApplication({ "x-ccdx-client": "claude-app", "user-agent": "codex/1.0" }), "claude_app");
  for (const agent of ["NotCodex/1.0", "My client codex/1.0", "codex/not-versioned", "codex/1.0-secret/other", "Codex Desktop", ["codex/1.0"], "codex/1.0 " + "x".repeat(512)]) {
    assert.equal(requestApplication({ "user-agent": agent }), "api");
  }
});
