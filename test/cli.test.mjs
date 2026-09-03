import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { localPackageVersion } from "../src/version.mjs";
import { assertSafeAdapterHost, isLanAllowed } from "../src/security.mjs";
import packageJson from "../package.json" with { type: "json" };

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL("../bin/cli.mjs", import.meta.url));
const legacyCliPath = fileURLToPath(new URL("../bin/codex-copilot-dx.mjs", import.meta.url));
const nonDarwinPlatformPreload = fileURLToPath(new URL("./fixtures/non-darwin-platform.cjs", import.meta.url));
const legacyWarning = /codex-copilot-dx is deprecated; use ccdx instead/;

function assertNoCompatibilityWarning(stderr) {
  assert.equal(stderr, "");
}

test("package exposes ccdx and keeps the deprecated command as a compatibility shim", () => {
  assert.deepEqual(packageJson.bin, {
    ccdx: "bin/cli.mjs",
    "codex-copilot-dx": "bin/codex-copilot-dx.mjs",
  });
});

test("cli --version exits without starting the adapter", async () => {
  const { stdout, stderr } = await execFileAsync(process.execPath, [cliPath, "--version"], {
    timeout: 2000,
    env: { ...process.env, ADAPTER_PORT: "0" },
  });

  assert.equal(stdout.trim(), `ccdx v${localPackageVersion()} by Dale Xiao`);
  assert.equal(stderr, "");
});

test("deprecated cli --version stays silent outside an interactive terminal", async () => {
  const { stdout, stderr } = await execFileAsync(process.execPath, [legacyCliPath, "--version"], {
    timeout: 2000,
    env: { ...process.env, ADAPTER_PORT: "0" },
  });

  assert.equal(stdout.trim(), `ccdx v${localPackageVersion()} by Dale Xiao`);
  assertNoCompatibilityWarning(stderr);
});

test("cli --help exits without validating runtime configuration", async () => {
  const { stdout, stderr } = await execFileAsync(process.execPath, [cliPath, "--help"], {
    timeout: 2000,
    env: { ...process.env, ADAPTER_PORT: "invalid" },
  });

  assert.match(stdout, /Usage:/);
  assert.match(stdout, /ccdx doctor/);
  assert.doesNotMatch(stdout, /Equivalent command/);
  assert.match(stdout, /ccdx status/);
  assert.match(stdout, /ccdx models/);
  assert.match(stdout, /ccdx auth status/);
  assert.match(stdout, /doctor \[--online\] \[--compat\]/);
  assert.doesNotMatch(stdout, /Claude|Anthropic|pms|pm-studio/i);
  assert.equal(stderr, "");
});

test("cli rejects unknown commands without starting the adapter", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [cliPath, "serve"], { timeout: 2000, env: { ...process.env } }),
    (error) => {
      assert.equal(error.code, 2);
      assert.match(error.stderr, /Unknown command or option: serve/);
      assert.match(error.stderr, /Run ccdx --help for usage/);
      return true;
    },
  );
});

test("deprecated cli help and argument errors use the canonical command name without warning scripts", async () => {
  const { stdout, stderr } = await execFileAsync(process.execPath, [legacyCliPath, "--help"], {
    timeout: 2000,
    env: { ...process.env, ADAPTER_PORT: "invalid" },
  });
  assert.match(stdout, /ccdx doctor/);
  assert.match(stdout, /ccdx status/);
  assert.match(stdout, /ccdx models/);
  assert.match(stdout, /ccdx auto-review-model/);
  assert.match(stdout, /ccdx update \[npm\|github\]/);
  assert.doesNotMatch(stdout, /Claude|Anthropic|pms|pm-studio/i);
  assertNoCompatibilityWarning(stderr);

  await assert.rejects(
    execFileAsync(process.execPath, [legacyCliPath, "serve"], { timeout: 2000, env: { ...process.env } }),
    (error) => {
      assert.equal(error.code, 2);
      assert.doesNotMatch(error.stderr, legacyWarning);
      assert.match(error.stderr, /Run ccdx --help for usage/);
      return true;
    },
  );
});

test("both CLI entrypoints expose the same complete subcommand help", async () => {
  const [primary, legacy] = await Promise.all([
    execFileAsync(process.execPath, [cliPath, "--help"], { timeout: 2000 }),
    execFileAsync(process.execPath, [legacyCliPath, "--help"], { timeout: 2000 }),
  ]);

  assert.equal(legacy.stdout, primary.stdout);
  assertNoCompatibilityWarning(legacy.stderr);
  for (const command of ["auth", "doctor", "status", "models", "usage", "auto-review-model", "update"]) {
    assert.match(primary.stdout, new RegExp(`ccdx ${command}`));
  }
  assert.doesNotMatch(primary.stdout, /Claude|Anthropic|pms|pm-studio/i);
});

test("both CLI entrypoints keep nested help and argument errors byte-for-byte equivalent", async () => {
  const [primaryHelp, legacyHelp] = await Promise.all([
    execFileAsync(process.execPath, [cliPath, "auth", "status", "--help"], { timeout: 2000 }),
    execFileAsync(process.execPath, [legacyCliPath, "auth", "status", "--help"], { timeout: 2000 }),
  ]);
  assert.equal(legacyHelp.stdout, primaryHelp.stdout);
  assert.match(primaryHelp.stdout, /Shows the saved GitHub Copilot account/);
  assertNoCompatibilityWarning(legacyHelp.stderr);

  const [primaryError, legacyError] = await Promise.allSettled([
    execFileAsync(process.execPath, [cliPath, "models", "--profile", "all"], { timeout: 2000 }),
    execFileAsync(process.execPath, [legacyCliPath, "models", "--profile", "all"], { timeout: 2000 }),
  ]);
  assert.equal(primaryError.status, "rejected");
  assert.equal(legacyError.status, "rejected");
  assert.equal(legacyError.reason.code, primaryError.reason.code);
  assert.equal(legacyError.reason.stderr, primaryError.reason.stderr);
});

test("both CLI entrypoints retire legacy integrations before runtime, auth, logging, or GUI startup", async () => {
  for (const [executable, args, integration] of [
    [cliPath, ["pms", "setup"], "PM Studio"],
    [legacyCliPath, ["pm-studio", "restore"], "PM Studio"],
    [cliPath, ["--configure-claude-desktop"], "Claude App and Claude Code"],
    [legacyCliPath, ["auth", "login", "claude", "--reauth"], "Claude App and Claude Code"],
    [cliPath, ["models", "--profile", "claude"], "Claude App and Claude Code"],
    [legacyCliPath, ["doctor", "--profile", "all"], "Claude App and Claude Code"],
  ]) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-cli-retired-"));
    const logPath = path.join(home, "debug.log");
    try {
      await assert.rejects(
        execFileAsync(process.execPath, [executable, ...args], {
          timeout: 30000,
          env: {
            ...process.env,
            HOME: home,
            ADAPTER_PORT: "invalid",
            CCDX_LOG_PATH: logPath,
            CCDX_CONFIGURE_CLAUDE_DESKTOP: "1",
            CCDX_AUTO_LAUNCH: "1",
          },
        }),
        (error) => {
          assert.equal(error.code, 1);
          assert.match(error.stderr, new RegExp(`${integration} integration was retired in ccdx 0\\.7\\.0`));
          assert.doesNotMatch(error.stderr, /ADAPTER_PORT/);
          return true;
        },
      );
      assert.equal(fs.existsSync(logPath), false);
      assert.equal(fs.existsSync(path.join(home, ".local")), false);
      assert.equal(fs.existsSync(path.join(home, ".codex")), false);
      assert.equal(fs.existsSync(path.join(home, ".claude")), false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }
});

test("both CLI entrypoints report auth status through the canonical command", async () => {
  for (const executable of [cliPath, legacyCliPath]) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-cli-auth-status-"));
    const logPath = path.join(home, "debug.log");
    const { stdout, stderr } = await execFileAsync(process.execPath, [executable, "auth", "status"], {
      timeout: 2000,
      env: {
        ...process.env,
        HOME: home,
        ADAPTER_PORT: "invalid",
        CCDX_LOG_PATH: logPath,
      },
    });

    assert.match(stdout, /^ccdx auth status/m);
    assert.match(stdout, /Codex: not configured/);
    assert.match(stdout, /Routing: responses -> codex/);
    assert.doesNotMatch(stdout, /Claude|Anthropic|messages ->/i);
    assertNoCompatibilityWarning(stderr);
    assert.equal(fs.existsSync(logPath), false);
    assert.equal(fs.existsSync(path.join(home, ".local")), false);
    assert.equal(fs.existsSync(path.join(home, ".codex")), false);
    assert.equal(fs.existsSync(path.join(home, ".claude")), false);
  }
});

test("both CLI entrypoints render the same explicit auth status table", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-cli-auth-table-"));
  try {
    const [primary, legacy] = await Promise.all([
      execFileAsync(process.execPath, [cliPath, "auth", "status", "--format", "table"], {
        timeout: 2000,
        env: { ...process.env, HOME: home, ADAPTER_PORT: "invalid" },
      }),
      execFileAsync(process.execPath, [legacyCliPath, "auth", "status", "--format", "table"], {
        timeout: 2000,
        env: { ...process.env, HOME: home, ADAPTER_PORT: "invalid" },
      }),
    ]);
    assert.equal(legacy.stdout, primary.stdout);
    assert.match(primary.stdout, /^PROFILE\s+ACCOUNT\s+LOCAL\s+ONLINE\s+MODELS$/m);
    assert.match(primary.stdout, /Routing: responses -> codex/);
    assert.doesNotMatch(primary.stdout, /Claude|Anthropic|messages ->/i);
    assert.equal(primary.stderr, "");
    assertNoCompatibilityWarning(legacy.stderr);
    assert.equal(fs.existsSync(path.join(home, ".local")), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("usage table is explicit while non-interactive default output stays compatible", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-cli-usage-table-"));
  const usagePath = path.join(home, "usage.jsonl");
  fs.writeFileSync(usagePath, [
    JSON.stringify({ model: "gpt-test", usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 2, total_tokens: 12 } }),
    JSON.stringify({ model: "gpt-fast-test", usage: { cache_read_input_tokens: 5, output_tokens: 3, total_tokens: 8 } }),
    "",
  ].join("\n"));
  const env = { ...process.env, HOME: home, CCDX_USAGE_PATH: usagePath, ADAPTER_PORT: "invalid" };
  try {
    const [primary, legacy, plain] = await Promise.all([
      execFileAsync(process.execPath, [cliPath, "usage", "--format", "table"], { timeout: 2000, env }),
      execFileAsync(process.execPath, [legacyCliPath, "usage", "--format", "table"], { timeout: 2000, env }),
      execFileAsync(process.execPath, [cliPath, "usage"], { timeout: 2000, env }),
    ]);
    assert.equal(legacy.stdout, primary.stdout);
    assert.match(primary.stdout, /^MODEL\s+RECORDS\s+INPUT\s+CACHE READ\s+OUTPUT\s+TOTAL$/m);
    assert.match(primary.stdout, /TOTAL\s+2\s+10\s+9\s+5\s+20/);
    assert.match(plain.stdout, /^Usage log: .*\nRequests: 2\nTokens:/);
    assert.doesNotMatch(plain.stdout, /^MODEL\s+RECORDS/m);
    assert.equal(primary.stderr, "");
    assertNoCompatibilityWarning(legacy.stderr);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("both CLI entrypoints fail models cleanly without a saved token or startup side effects", async () => {
  for (const executable of [cliPath, legacyCliPath]) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-cli-models-"));
    const logPath = path.join(home, "debug.log");
    await assert.rejects(
      execFileAsync(process.execPath, [executable, "models"], {
        timeout: 2000,
        env: { ...process.env, HOME: home, ADAPTER_PORT: "invalid", CCDX_LOG_PATH: logPath },
      }),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /GitHub token not found/);
        return true;
      },
    );
    assert.equal(fs.existsSync(logPath), false, executable);
    assert.equal(fs.existsSync(path.join(home, ".codex")), false, executable);
    assert.equal(fs.existsSync(path.join(home, ".claude")), false, executable);
  }
});

test("both CLI entrypoints require a source for non-interactive updates", async () => {
  for (const executable of [cliPath, legacyCliPath]) {
    await assert.rejects(
      execFileAsync(process.execPath, [executable, "update"], { timeout: 2000 }),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /ccdx update npm or ccdx update github/);
        return true;
      },
    );
  }
});

test("both CLI entrypoints reject non-interactive model selection consistently", async () => {
  for (const executable of [cliPath, legacyCliPath]) {
    await assert.rejects(
      execFileAsync(process.execPath, [executable, "auto-review-model"], { timeout: 2000 }),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /ccdx auto-review-model requires an interactive terminal/);
        return true;
      },
    );
  }
});

test("cli doctor exits without starting the adapter", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-cli-doctor-"));
  const { stdout, stderr } = await execFileAsync(process.execPath, ["--require", nonDarwinPlatformPreload, cliPath, "doctor"], {
    timeout: 2000,
    env: { ...process.env, HOME: home, ADAPTER_PORT: "9" },
  });

  assert.match(stdout, /ccdx doctor/);
  assert.match(stdout, /\[WARN\] Adapter is not listening on http:\/\/127\.0\.0\.1:9/);
  assert.equal(stderr, "");
});

test("cli doctor ignores retired Claude settings and remains Codex-only", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-cli-doctor-retired-"));
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", "settings.json"), "{broken");

  const { stdout, stderr } = await execFileAsync(process.execPath, ["--require", nonDarwinPlatformPreload, cliPath, "doctor"], {
    timeout: 2000,
    env: { ...process.env, HOME: home, ADAPTER_PORT: "9" },
  });

  assert.match(stdout, /^ccdx doctor/m);
  assert.doesNotMatch(stdout, /Claude|Anthropic/i);
  assert.equal(stderr, "");
});

test("deprecated cli doctor heading uses the canonical command name without warning scripts", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-cli-legacy-doctor-"));
  const { stdout, stderr } = await execFileAsync(process.execPath, ["--require", nonDarwinPlatformPreload, legacyCliPath, "doctor"], {
    timeout: 2000,
    env: { ...process.env, HOME: home, ADAPTER_PORT: "9" },
  });

  assert.match(stdout, /^ccdx doctor/m);
  assertNoCompatibilityWarning(stderr);
});

test("cli status fails read-only before unrelated runtime validation or initialization", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-cli-status-"));
  const logPath = path.join(home, "debug.log");
  await assert.rejects(
    execFileAsync(process.execPath, [cliPath, "status"], {
      timeout: 2000,
      env: {
        ...process.env,
        HOME: home,
        ADAPTER_PORT: "9",
        CCDX_LOG_PATH: logPath,
        CCDX_UPSTREAM_TIMEOUT_MS: "invalid",
      },
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /Could not read adapter status/);
      assert.doesNotMatch(error.stderr, /CCDX_UPSTREAM_TIMEOUT_MS/);
      return true;
    },
  );
  assert.equal(fs.existsSync(logPath), false);
  assert.equal(fs.existsSync(path.join(home, ".codex")), false);
  assert.equal(fs.existsSync(path.join(home, ".claude")), false);
});

test("isLanAllowed: requires an explicit opt-in", () => {
  assert.equal(isLanAllowed({}), false);
  assert.equal(isLanAllowed({ CCDX_ALLOW_LAN: "1" }), true);
  assert.equal(isLanAllowed({ CCDX_ALLOW_LAN: "true" }), true);
  assert.equal(isLanAllowed({ CCDX_ALLOW_LAN: "yes" }), true);
});

test("assertSafeAdapterHost: allows loopback hosts", () => {
  assert.doesNotThrow(() => assertSafeAdapterHost("127.0.0.1", {}));
  assert.doesNotThrow(() => assertSafeAdapterHost("localhost", {}));
  assert.doesNotThrow(() => assertSafeAdapterHost("::1", {}));
  assert.doesNotThrow(() => assertSafeAdapterHost("[::1]", {}));
});

test("assertSafeAdapterHost: blocks non-loopback hosts unless LAN is explicitly allowed", () => {
  assert.throws(
    () => assertSafeAdapterHost("0.0.0.0", {}),
    /Refusing to bind ADAPTER_HOST=0\.0\.0\.0 beyond loopback/,
  );
  assert.throws(
    () => assertSafeAdapterHost("192.168.1.8", {}),
    /CCDX_ALLOW_LAN=1/,
  );
  assert.doesNotThrow(() => assertSafeAdapterHost("0.0.0.0", { CCDX_ALLOW_LAN: "1" }));
});
