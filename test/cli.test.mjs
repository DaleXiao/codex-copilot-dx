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

test("package exposes ccdx and keeps the legacy command on the shared CLI implementation", () => {
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

test("legacy cli --version keeps its invoked command name", async () => {
  const { stdout, stderr } = await execFileAsync(process.execPath, [legacyCliPath, "--version"], {
    timeout: 2000,
    env: { ...process.env, ADAPTER_PORT: "0" },
  });

  assert.equal(stdout.trim(), `codex-copilot-dx v${localPackageVersion()} by Dale Xiao`);
  assert.equal(stderr, "");
});

test("cli --help exits without validating runtime configuration", async () => {
  const { stdout, stderr } = await execFileAsync(process.execPath, [cliPath, "--help"], {
    timeout: 2000,
    env: { ...process.env, ADAPTER_PORT: "invalid" },
  });

  assert.match(stdout, /Usage:/);
  assert.match(stdout, /ccdx doctor/);
  assert.match(stdout, /Equivalent command: codex-copilot-dx/);
  assert.match(stdout, /ccdx status/);
  assert.match(stdout, /doctor \[--online\] \[--compat\]/);
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

test("legacy cli help and argument errors use the legacy command name", async () => {
  const { stdout } = await execFileAsync(process.execPath, [legacyCliPath, "--help"], {
    timeout: 2000,
    env: { ...process.env, ADAPTER_PORT: "invalid" },
  });
  assert.match(stdout, /codex-copilot-dx doctor/);
  assert.match(stdout, /codex-copilot-dx status/);
  assert.match(stdout, /Equivalent command: ccdx/);

  await assert.rejects(
    execFileAsync(process.execPath, [legacyCliPath, "serve"], { timeout: 2000, env: { ...process.env } }),
    (error) => {
      assert.equal(error.code, 2);
      assert.match(error.stderr, /Run codex-copilot-dx --help for usage/);
      return true;
    },
  );
});

test("cli doctor exits without starting the adapter", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-cli-doctor-"));
  const { stdout, stderr } = await execFileAsync(process.execPath, [cliPath, "doctor"], {
    timeout: 2000,
    env: { ...process.env, HOME: home, ADAPTER_PORT: "9" },
  });

  assert.match(stdout, /ccdx doctor/);
  assert.match(stdout, /\[WARN\] Adapter is not listening on http:\/\/127\.0\.0\.1:9/);
  assert.equal(stderr, "");
});

test("cli doctor returns nonzero when a configuration file is invalid", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-cli-doctor-invalid-"));
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", "settings.json"), "{broken");

  await assert.rejects(
    execFileAsync(process.execPath, [cliPath, "doctor"], {
      timeout: 2000,
      env: { ...process.env, HOME: home, ADAPTER_PORT: "9" },
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stdout, /\[ERR\] Claude Code settings could not parse/);
      return true;
    },
  );
});

test("legacy cli doctor heading uses the legacy command name", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-cli-legacy-doctor-"));
  const { stdout, stderr } = await execFileAsync(process.execPath, [legacyCliPath, "doctor"], {
    timeout: 2000,
    env: { ...process.env, HOME: home, ADAPTER_PORT: "9" },
  });

  assert.match(stdout, /^codex-copilot-dx doctor/m);
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
