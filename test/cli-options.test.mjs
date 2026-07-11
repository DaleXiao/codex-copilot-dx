import { test } from "node:test";
import assert from "node:assert/strict";
import { cliHelp, parseCliArgs, parseRuntimeOptions } from "../src/cli-options.mjs";

test("parseCliArgs: accepts supported commands and options", () => {
  assert.deepEqual(parseCliArgs([]), { command: "start", configureClaudeDesktop: false, online: false });
  assert.deepEqual(parseCliArgs(["--configure-claude-desktop"]), { command: "start", configureClaudeDesktop: true, online: false });
  assert.deepEqual(parseCliArgs(["doctor", "--online"]), { command: "doctor", configureClaudeDesktop: false, online: true });
  assert.equal(parseCliArgs(["--help"]).command, "help");
  assert.equal(parseCliArgs(["-v"]).command, "version");
  assert.equal(parseCliArgs(["usage"]).command, "usage");
  assert.match(cliHelp(), /doctor \[--online\]/);
});

test("parseCliArgs: rejects unknown commands and trailing arguments", () => {
  assert.throws(() => parseCliArgs(["serve"]), /Unknown command or option: serve/);
  assert.throws(() => parseCliArgs(["usage", "extra"]), /Unexpected argument: extra/);
  assert.throws(() => parseCliArgs(["doctor", "--write"]), /Unexpected argument: --write/);
  assert.throws(() => parseCliArgs(["doctor", "--online", "--online"]), /Unexpected argument: --online/);
});

test("parseRuntimeOptions: validates ports and startup timeouts", () => {
  assert.deepEqual(parseRuntimeOptions({}), {
    adapterPort: 2026,
    adapterHost: "127.0.0.1",
    modelRefreshTimeoutMs: 5000,
    existingAdapterTimeoutMs: 500,
    modelRefreshIntervalMs: 1800000,
    upstreamTimeoutMs: 120000,
    streamHandshakeTimeoutMs: 120000,
    streamIdleTimeoutMs: 120000,
    shutdownTimeoutMs: 5000,
  });
  assert.equal(parseRuntimeOptions({ ADAPTER_PORT: "65535" }).adapterPort, 65535);
  assert.equal(parseRuntimeOptions({ CCDX_MODEL_REFRESH_INTERVAL_MS: "0" }).modelRefreshIntervalMs, 0);
  assert.throws(() => parseRuntimeOptions({ ADAPTER_PORT: "0" }), /ADAPTER_PORT must be an integer/);
  assert.throws(() => parseRuntimeOptions({ ADAPTER_PORT: "2026x" }), /ADAPTER_PORT must be an integer/);
  assert.throws(() => parseRuntimeOptions({ CCDX_MODEL_REFRESH_TIMEOUT_MS: "-1" }), /CCDX_MODEL_REFRESH_TIMEOUT_MS/);
  assert.throws(() => parseRuntimeOptions({ CCDX_EXISTING_ADAPTER_TIMEOUT_MS: "1.5" }), /CCDX_EXISTING_ADAPTER_TIMEOUT_MS/);
  assert.throws(() => parseRuntimeOptions({ CCDX_SHUTDOWN_TIMEOUT_MS: "0" }), /CCDX_SHUTDOWN_TIMEOUT_MS/);
  assert.throws(() => parseRuntimeOptions({ CCDX_UPSTREAM_TIMEOUT_MS: "0" }), /CCDX_UPSTREAM_TIMEOUT_MS/);
  assert.throws(() => parseRuntimeOptions({ CCDX_STREAM_HANDSHAKE_TIMEOUT_MS: "nope" }), /CCDX_STREAM_HANDSHAKE_TIMEOUT_MS/);
  assert.throws(() => parseRuntimeOptions({ CCDX_STREAM_IDLE_TIMEOUT_MS: "-1" }), /CCDX_STREAM_IDLE_TIMEOUT_MS/);
});
