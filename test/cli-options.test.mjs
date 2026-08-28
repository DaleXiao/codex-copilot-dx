import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cliCommandName,
  cliHelp,
  parseAdapterProbeOptions,
  parseCliArgs,
  parseRuntimeOptions,
} from "../src/cli-options.mjs";

test("parseCliArgs: accepts supported commands and options", () => {
  assert.deepEqual(parseCliArgs([]), { command: "start", configureClaudeDesktop: false, showRequestId: false, online: false, compat: false });
  assert.deepEqual(parseCliArgs(["--configure-claude-desktop"]), { command: "start", configureClaudeDesktop: true, showRequestId: false, online: false, compat: false });
  assert.deepEqual(parseCliArgs(["start", "--configure-claude-app"]), { command: "start", configureClaudeDesktop: true, showRequestId: false, online: false, compat: false });
  assert.deepEqual(parseCliArgs(["--show-request-id"]), { command: "start", configureClaudeDesktop: false, showRequestId: true, online: false, compat: false });
  assert.deepEqual(parseCliArgs(["--show-request-id", "--configure-claude-desktop"]), { command: "start", configureClaudeDesktop: true, showRequestId: true, online: false, compat: false });
  assert.deepEqual(parseCliArgs(["doctor", "--online"]), { command: "doctor", configureClaudeDesktop: false, showRequestId: false, online: true, compat: false, profile: "codex" });
  assert.deepEqual(parseCliArgs(["doctor", "--compat"]), { command: "doctor", configureClaudeDesktop: false, showRequestId: false, online: false, compat: true, profile: "codex" });
  assert.deepEqual(parseCliArgs(["doctor", "--compat", "--online"]), { command: "doctor", configureClaudeDesktop: false, showRequestId: false, online: true, compat: true, profile: "codex" });
  assert.equal(parseCliArgs(["doctor", "--profile", "claude"]).profile, "claude");
  assert.equal(parseCliArgs(["--doctor", "--profile", "all"]).profile, "all");
  assert.equal(parseCliArgs(["--help"]).command, "help");
  assert.equal(parseCliArgs(["-v"]).command, "version");
  assert.equal(parseCliArgs(["status"]).command, "status");
  assert.equal(parseCliArgs(["--status"]).command, "status");
  assert.equal(parseCliArgs(["usage"]).command, "usage");
  assert.equal(parseCliArgs(["usage", "--format", "table"]).outputFormat, "table");
  assert.deepEqual(parseCliArgs(["pms", "setup"]), {
    command: "pms", action: "setup", configureClaudeDesktop: false, showRequestId: false,
    online: false, compat: false,
  });
  assert.equal(parseCliArgs(["pms", "status"]).action, "status");
  assert.equal(parseCliArgs(["pms", "status", "--format", "plain"]).outputFormat, "plain");
  assert.equal(parseCliArgs(["pms", "restore"]).action, "restore");
  assert.equal(parseCliArgs(["pm-studio", "setup"]).action, "setup");
  assert.equal(parseCliArgs(["pm-studio", "status"]).action, "status");
  assert.equal(parseCliArgs(["pm-studio", "restore"]).action, "restore");
  assert.deepEqual(parseCliArgs(["models"]), { command: "models", configureClaudeDesktop: false, showRequestId: false, online: false, compat: false, profile: "codex" });
  assert.equal(parseCliArgs(["models", "--profile", "claude"]).profile, "claude");
  assert.equal(parseCliArgs(["models", "--format", "table", "--profile", "claude"]).outputFormat, "table");
  assert.deepEqual(parseCliArgs(["auth", "status"]), {
    command: "auth", action: "status", profile: "", configureClaudeDesktop: false, showRequestId: false,
    online: false, compat: false, expectedLogin: "", reauth: false,
  });
  assert.equal(parseCliArgs(["auth", "status", "--online"]).online, true);
  assert.equal(parseCliArgs(["auth", "status", "--online", "--format", "table"]).outputFormat, "table");
  assert.deepEqual(parseCliArgs(["auth", "login", "claude", "--github-login", "personal", "--reauth"]), {
    command: "auth", action: "login", profile: "claude", configureClaudeDesktop: false, showRequestId: false,
    online: false, compat: false, expectedLogin: "personal", reauth: true,
  });
  assert.equal(parseCliArgs(["auto-review-model"]).command, "auto-review-model");
  assert.equal(parseCliArgs(["update"]).command, "update");
  assert.equal(parseCliArgs(["update", "npm"]).updateSource, "npm");
  assert.equal(parseCliArgs(["update", "github"]).updateSource, "github");
  assert.equal(parseCliArgs(["update", "gh"]).updateSource, "github");
  assert.match(cliHelp(), /ccdx status/);
  assert.match(cliHelp(), /ccdx models/);
  assert.match(cliHelp(), /ccdx pms status/);
  assert.match(cliHelp(), /ccdx pms setup/);
  assert.match(cliHelp(), /ccdx pms restore/);
  assert.match(cliHelp(), /ccdx auth status \[--online\]/);
  assert.match(cliHelp(), /ccdx auth login claude \[--github-login <login>\] \[--reauth\]/);
  assert.match(cliHelp(), /models \[--profile codex\|claude\]/);
  assert.match(cliHelp(), /doctor \[--online\] \[--compat\] \[--profile codex\|claude\|all\]/);
  assert.match(cliHelp(), /doctor \[--online\] \[--compat\]/);
  assert.match(cliHelp(), /--show-request-id/);
  assert.match(cliHelp(), /ccdx auto-review-model/);
  assert.match(cliHelp(), /ccdx update \[npm\|github\]/);
  assert.match(cliHelp("codex-copilot-dx"), /ccdx status/);
  assert.doesNotMatch(cliHelp("codex-copilot-dx"), /Equivalent command/);
  assert.equal(parseCliArgs(["doctor", "--help"]).helpTopic, "doctor");
  assert.equal(parseCliArgs(["auth", "login", "claude", "--help"]).helpTopic, "auth login");
  assert.equal(parseCliArgs(["pms", "status", "--help"]).helpTopic, "pms status");
  assert.equal(parseCliArgs(["help", "pm-studio", "setup"]).helpTopic, "pms setup");
  assert.equal(parseCliArgs(["pm-studio", "restore", "--help"]).helpTopic, "pms restore");
  assert.match(cliHelp("ccdx", "doctor"), /consumes a small amount of Copilot usage/);
  assert.match(cliHelp("ccdx", "pms setup"), /exact or structurally compatible PM Studio bundle/);
  assert.doesNotMatch(cliHelp("ccdx", "pms setup"), /exactly supported/);
  assert.match(cliHelp("ccdx", "pms restore"), /exact source-bound verified backup/);
  assert.match(cliHelp("ccdx", "pms restore"), /no confirmation prompt/);
  assert.doesNotMatch(cliHelp("ccdx", "pms restore"), /--app|--yes|--format/);
  assert.equal(cliHelp("ccdx"), cliHelp("codex-copilot-dx"));
});

test("parseCliArgs: rejects unknown commands and trailing arguments", () => {
  assert.throws(() => parseCliArgs(["serve"]), /Unknown command or option: serve/);
  assert.throws(() => parseCliArgs(["usage", "extra"]), /Unexpected argument: extra/);
  assert.throws(() => parseCliArgs(["usage", "--format"]), /Missing value for --format/);
  assert.throws(() => parseCliArgs(["usage", "--format", "json"]), /Format must be table or plain: json/);
  assert.throws(() => parseCliArgs(["pms"]), /Missing pms action: expected setup, status, or restore/);
  assert.throws(() => parseCliArgs(["pms", "setup", "extra"]), /Unexpected argument: extra/);
  assert.throws(() => parseCliArgs(["pms", "setup", "--format", "table"]), /Unexpected arguments: --format table/);
  assert.throws(() => parseCliArgs(["pms", "restore", "--yes"]), /Unexpected argument: --yes/);
  assert.throws(() => parseCliArgs(["pms", "restore", "--app", "\/tmp\/PM Studio.app"]), /Unexpected arguments: --app \/tmp\/PM Studio.app/);
  assert.throws(() => parseCliArgs(["pms", "restore", "--format", "table"]), /Unexpected arguments: --format table/);
  assert.throws(() => parseCliArgs(["status", "extra"]), /Unexpected argument: extra/);
  assert.throws(() => parseCliArgs(["models", "extra"]), /Unexpected argument: extra/);
  assert.throws(() => parseCliArgs(["models", "--profile"]), /Missing value for --profile/);
  assert.throws(() => parseCliArgs(["models", "--profile", "all"]), /Profile must be codex or claude: all/);
  assert.throws(() => parseCliArgs(["models", "--profile", "codex", "--profile", "claude"]), /Unexpected argument: --profile/);
  assert.throws(() => parseCliArgs(["models", "--format", "wide"]), /Format must be table or plain: wide/);
  assert.throws(() => parseCliArgs(["auth"]), /Missing auth action/);
  assert.throws(() => parseCliArgs(["auth", "logout", "claude"]), /Unknown auth action: logout/);
  assert.throws(() => parseCliArgs(["auth", "status", "claude"]), /Unexpected argument: claude/);
  assert.throws(() => parseCliArgs(["auth", "status", "--online", "--online"]), /Unexpected argument: --online/);
  assert.throws(() => parseCliArgs(["auth", "status", "--format", "table", "--format", "plain"]), /Unexpected argument: --format/);
  assert.throws(() => parseCliArgs(["auth", "login"]), /Missing auth login profile/);
  assert.throws(() => parseCliArgs(["auth", "login", "codex"]), /Auth login profile must be claude: codex/);
  assert.throws(() => parseCliArgs(["auth", "login", "claude", "--github-login"]), /Missing value for --github-login/);
  assert.throws(() => parseCliArgs(["auth", "login", "claude", "--github-login", "one", "--github-login", "two"]), /Unexpected argument: --github-login/);
  assert.throws(() => parseCliArgs(["auth", "login", "claude", "--reauth", "--reauth"]), /Unexpected argument: --reauth/);
  assert.throws(() => parseCliArgs(["auto-review-model", "gpt-5.6-sol"]), /Unexpected argument: gpt-5.6-sol/);
  assert.throws(() => parseCliArgs(["update", "other"]), /Update source must be npm or github/);
  assert.throws(() => parseCliArgs(["update", "npm", "extra"]), /Unexpected argument: extra/);
  assert.throws(() => parseCliArgs(["doctor", "--write"]), /Unexpected argument: --write/);
  assert.throws(() => parseCliArgs(["doctor", "--online", "--online"]), /Unexpected argument: --online/);
  assert.throws(() => parseCliArgs(["doctor", "--compat", "--compat"]), /Unexpected argument: --compat/);
  assert.throws(() => parseCliArgs(["doctor", "--profile"]), /Missing value for --profile/);
  assert.throws(() => parseCliArgs(["doctor", "--profile", "other"]), /Profile must be codex, claude, or all: other/);
  assert.throws(() => parseCliArgs(["doctor", "--profile", "codex", "--profile", "all"]), /Unexpected argument: --profile/);
  assert.throws(() => parseCliArgs(["--show-request-id", "--show-request-id"]), /Unexpected argument: --show-request-id/);
});

test("cliCommandName: always presents the canonical ccdx command", () => {
  assert.equal(cliCommandName("/usr/local/bin/ccdx"), "ccdx");
  assert.equal(cliCommandName("C:\\Users\\Dale\\bin\\codex-copilot-dx"), "ccdx");
  assert.equal(cliCommandName("/usr/local/lib/bin/codex-copilot-dx.mjs"), "ccdx");
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
