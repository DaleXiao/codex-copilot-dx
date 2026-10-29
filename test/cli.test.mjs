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
const nonDarwinPlatformPreload = fileURLToPath(new URL("./fixtures/non-darwin-platform.cjs", import.meta.url));

test("package exposes only the ccdx command", () => {
  assert.deepEqual(packageJson.bin, {
    ccdx: "bin/cli.mjs",
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


test("doctor config CLI stays offline and read-only even with startup and logging settings", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-doctor-config-cli-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const configPath = path.join(home, ".codex", "config.toml");
  fs.mkdirSync(path.dirname(configPath));
  const content = `openai_base_url = "http://127.0.0.1:2026/v1"
model_context_window = 1000000
model_auto_compact_token_limit = 900000
[features]
context_management = false
`;
  fs.writeFileSync(configPath, content);
  const before = fs.statSync(configPath);
  const guard = path.join(home, "guard.cjs");
  fs.writeFileSync(guard, `
    Object.defineProperty(process.stderr, "isTTY", { value: true });
    const deny = () => { process.exit(99); };
    globalThis.fetch = deny;
    require("node:net").createConnection = deny;
    require("node:net").Server.prototype.listen = deny;
    require("node:child_process").spawn = deny;
    const fs = require("node:fs");
    for (const key of ["writeFileSync", "appendFileSync", "mkdirSync", "renameSync"]) fs[key] = deny;
    require("node:module").syncBuiltinESMExports();
  `);
  const env = {
    ...process.env, HOME: home, ADAPTER_HOST: "127.0.0.1", ADAPTER_PORT: "2026",
    CCDX_UPSTREAM_TIMEOUT_MS: "invalid", CCDX_EXISTING_ADAPTER_TIMEOUT_MS: "invalid",
    CCDX_LOG_PATH: path.join(home, "logs", "must-not-exist.log"),
    XDG_CACHE_HOME: path.join(home, "cache"),
  };
  for (const executable of [cliPath]) {
    const { stdout, stderr } = await execFileAsync(process.execPath, ["--require", guard, executable, "doctor", "config"], { env, timeout: 5000 });
    assert.match(stdout, /^ccdx doctor config/m);
    assert.match(stdout, /explicitly disabled; retained/);
    assert.match(stdout, /0 error\(s\)/);
    assert.equal(stderr, "");
  }
  assert.equal(fs.readFileSync(configPath, "utf8"), content);
  assert.equal(fs.statSync(configPath).mtimeMs, before.mtimeMs);
  assert.equal(fs.existsSync(path.join(home, "logs")), false);
  assert.equal(fs.existsSync(path.join(home, ".local")), false);
  assert.equal(fs.existsSync(path.join(home, "cache")), false);

  fs.writeFileSync(configPath, 'key = "do-not-echo-this-secret\n');
  await assert.rejects(execFileAsync(process.execPath, [cliPath, "doctor", "config"], { env, timeout: 5000 }), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stdout, /Invalid TOML.*line \d+, column \d+/);
    assert.doesNotMatch(error.stdout + error.stderr, /do-not-echo-this-secret/);
    return true;
  });
  fs.unlinkSync(configPath);
  const missing = await execFileAsync(process.execPath, [cliPath, "doctor", "config"], { env, timeout: 5000 });
  assert.match(missing.stdout, /Next startup would create/);
  assert.equal(fs.existsSync(configPath), false);
});


test("cli --help exits without validating runtime configuration", async () => {
  const { stdout, stderr } = await execFileAsync(process.execPath, [cliPath, "--help"], {
    timeout: 2000,
    env: { ...process.env, ADAPTER_PORT: "invalid" },
  });

  assert.match(stdout, /Usage:/);
  assert.match(stdout, /doctor\s+Check local setup/);
  assert.doesNotMatch(stdout, /Equivalent command/);
  assert.match(stdout, /status\s+Show service state/);
  assert.match(stdout, /deeper checks are explicit/);
  assert.doesNotMatch(stdout, /pms|pm-studio/i);
  assert.equal(stderr, "");
});


test("cli rejects unknown commands without starting the adapter", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [cliPath, "serve"], { timeout: 2000, env: { ...process.env } }),
    (error) => {
      assert.equal(error.code, 2);
      assert.match(error.stderr, /Unknown command path: serve/);
      assert.match(error.stderr, /Help: ccdx --help/);
      return true;
    },
  );
});


test("CLI require a source for non-interactive updates", async () => {
  for (const executable of [cliPath]) {
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


test("CLI reject non-interactive animation selection before startup side effects", async () => {
  for (const executable of [cliPath]) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-cli-animation-"));
    const logPath = path.join(home, "debug.log");
    try {
      await assert.rejects(
        execFileAsync(process.execPath, [executable, "config", "animation"], {
          timeout: 2000,
          env: {
            ...process.env,
            HOME: home,
            XDG_CONFIG_HOME: path.join(home, ".config"),
            ADAPTER_PORT: "invalid",
            CCDX_LOG_PATH: logPath,
            CCDX_AUTO_LAUNCH: "1",
          },
        }),
        (error) => {
          assert.equal(error.code, 1);
          assert.match(error.stderr, /requires an interactive terminal/);
          assert.doesNotMatch(error.stderr, /ADAPTER_PORT/);
          return true;
        },
      );
      assert.equal(fs.existsSync(logPath), false);
      assert.equal(fs.existsSync(path.join(home, ".local")), false);
      assert.equal(fs.existsSync(path.join(home, ".codex")), false);
      assert.equal(fs.existsSync(path.join(home, ".config")), false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }
});


test("cli doctor exits without starting the adapter", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-cli-doctor-"));
  const { stdout, stderr } = await execFileAsync(process.execPath, ["--require", nonDarwinPlatformPreload, cliPath, "doctor"], {
    timeout: 2000,
    env: { ...process.env, HOME: home, ADAPTER_PORT: "9" },
  });

  assert.match(stdout, /ccdx doctor/);
  assert.match(stdout, /\[WARN\]\s+Adapter is not listening on http:\/\/127\.0\.0\.1:9/);
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
test("removed command roots fail before authentication, file writes or service startup", async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-removed-cli-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  for (const root of ["auth", "models", "m365", "prediction", "image-status", "suggestion", "animation"]) {
    await assert.rejects(execFileAsync(process.execPath, [cliPath, root], {
      timeout: 5000, env: { ...process.env, HOME: home, ADAPTER_PORT: "invalid", CCDX_AUTO_LAUNCH: "1", CCDX_LOG_PATH: path.join(home, "must-not-exist.log") },
    }), error => error.code === 2 && /Unknown command/.test(error.stderr) && !/ADAPTER_PORT|Ready|Starting/.test(error.stdout));
  }
  assert.deepEqual(fs.readdirSync(home), []);
});

test("recorded usage stays readable offline and malformed records do not leak into output", async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-cli-usage-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = path.join(home, "usage.jsonl");
  const run = target => execFileAsync(process.execPath, [cliPath, "usage", "--format", "json"], { timeout: 5000, env: { ...process.env, HOME: home, CCDX_USAGE_PATH: target } });
  const missing = await run(file);assert.equal(JSON.parse(missing.stdout).requests, 0);assert.equal(fs.existsSync(file), false);
  fs.writeFileSync(file, "PRIVATE-MALFORMED-RECORD\n");
  const malformed = await run(file);assert.equal(JSON.parse(malformed.stdout).requests, 0);assert.match(malformed.stderr, /invalid record/);assert.doesNotMatch(malformed.stdout + malformed.stderr, /PRIVATE-MALFORMED/);
  await assert.rejects(run(home), error => error.code === 1 && typeof JSON.parse(error.stdout).error.code === "string" && !/triggerUncaughtException/.test(error.stderr));
});
