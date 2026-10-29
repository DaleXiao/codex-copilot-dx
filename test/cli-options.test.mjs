import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cliCommandName,
  cliHelp,
  parseAdapterProbeOptions,
  parseCliArgs,
  parseRuntimeOptions,
} from "../src/cli-options.mjs";

test("one command grammar exposes grouped management and rejects removed entrypoints", () => {
  assert.equal(parseCliArgs([]).command, "start");
  assert.equal(parseCliArgs(["--no-browser"]).noBrowser, true);
  assert.equal(parseCliArgs(["--version"]).command, "version");
  assert.equal(parseCliArgs(["status"]).group, "status");
  assert.equal(parseCliArgs(["usage", "--format", "table"]).flags.format, "table");
  assert.equal(parseCliArgs(["source", "github", "reauth", "--login", "user"]).expectedLogin, "user");
  assert.equal(parseCliArgs(["source", "m365", "account", "--id", "a".repeat(64)]).accountId, "a".repeat(64));
  assert.equal(parseCliArgs(["app", "codex", "image", "setup"]).action, "enable");
  assert.equal(parseCliArgs(["app", "codex", "prediction", "repair"]).action, "fix");
  assert.equal(parseCliArgs(["doctor", "cache", "--clean", "--history", "--yes"]).history, true);
  assert.equal(parseCliArgs(["config", "limits", "--decoded", "256"]).limitMib, 256);
  assert.equal(parseCliArgs(["update", "github", "--allow-remote"]).allowRemote, true);
  for (const root of ["auth", "reauth", "models", "m365", "image", "prediction", "animation", "cache", "limits", "enable-image", "disable-image", "image-status", "auto-review-model", "suggestion", "--doctor", "--status", "pm-studio"]) {
    assert.throws(() => parseCliArgs([root]), undefined, root);
  }
  assert.throws(() => parseCliArgs(["help", "legacy"]));
  for (const args of [["version", "extra"], ["status", "--format", "xml"], ["source", "github"], ["source", "m365", "account", "--id", "wrong"], ["doctor", "cache", "--history"], ["config", "limits", "--decoded", "wrong"], ["start", "--verbose", "--verbose"]]) assert.throws(() => parseCliArgs(args));
  assert.doesNotMatch(cliHelp(), /Compatibility|help legacy/);
});
test("doctor configuration checks have a read-only grammar", () => {
  assert.equal(parseCliArgs(["doctor", "--fix", "--json"]).fix, true);
  assert.equal(parseCliArgs(["doctor", "config"]).configOnly, true);
  for (const args of [["doctor", "config", "--help"], ["help", "doctor", "config"]]) assert.equal(parseCliArgs(args).helpTopic, "doctor config");
  for (const extra of ["--online", "--compat", "--write", "--profile", "extra"]) assert.throws(() => parseCliArgs(["doctor", "config", extra]));
});

test("cliCommandName: always presents the canonical ccdx command", () => {
  assert.equal(cliCommandName("/usr/local/bin/ccdx"), "ccdx");
  assert.equal(cliCommandName("C:\\Users\\Dale\\bin\\codex-copilot-dx"), "ccdx");
  assert.equal(cliCommandName("/workspace/bin/cli.mjs"), "ccdx");
  assert.equal(cliCommandName(), "ccdx");
});

test("parseRuntimeOptions: validates ports and startup timeouts", () => {
  assert.deepEqual(parseRuntimeOptions({}), {
    adapterPort: 2026,
    adapterHost: "127.0.0.1",
    modelRefreshTimeoutMs: 5000,
    existingAdapterTimeoutMs: 500,
    modelRefreshIntervalMs: 7200000,
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
  assert.throws(() => parseRuntimeOptions({ CCDX_UPSTREAM_TIMEOUT_MS: "2147483648" }), /CCDX_UPSTREAM_TIMEOUT_MS/);
  assert.throws(() => parseRuntimeOptions({ CCDX_MODEL_REFRESH_INTERVAL_MS: "9007199254740992" }), /CCDX_MODEL_REFRESH_INTERVAL_MS/);
});

test("parseAdapterProbeOptions: validates only status probe settings", () => {
  assert.deepEqual(parseAdapterProbeOptions({ CCDX_UPSTREAM_TIMEOUT_MS: "invalid" }), {
    adapterPort: 2026,
    adapterHost: "127.0.0.1",
    existingAdapterTimeoutMs: 500,
  });
  assert.deepEqual(parseAdapterProbeOptions({
    ADAPTER_PORT: "3456",
    ADAPTER_HOST: "::1",
    CCDX_EXISTING_ADAPTER_TIMEOUT_MS: "750",
  }), {
    adapterPort: 3456,
    adapterHost: "::1",
    existingAdapterTimeoutMs: 750,
  });
  assert.throws(() => parseAdapterProbeOptions({ ADAPTER_PORT: "0" }), /ADAPTER_PORT/);
  assert.throws(() => parseAdapterProbeOptions({ CCDX_EXISTING_ADAPTER_TIMEOUT_MS: "0" }), /CCDX_EXISTING_ADAPTER_TIMEOUT_MS/);
});
