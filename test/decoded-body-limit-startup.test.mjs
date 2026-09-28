import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { writeDecodedBodyLimitMib } from "../src/user-settings.mjs";

const transportUrl = new URL("../src/http-transport.mjs", import.meta.url).href;
const observabilityUrl = new URL("../src/observability.mjs", import.meta.url).href;
const probeScript = `
import { Readable } from "node:stream";
import { readJsonBody } from ${JSON.stringify(transportUrl)};
import { runtimeStatusPayload } from ${JSON.stringify(observabilityUrl)};
const request = Readable.from([]);
request.headers = { "content-length": String(129 * 1024 * 1024) };
let error;
try { await readJsonBody(request); } catch (value) { error = value; }
console.log(JSON.stringify({ limit: runtimeStatusPayload().limits.max_decoded_body_bytes, status: error?.statusCode, message: error?.message }));
`;

test("saved decoded-body limit applies only after startup and env retains precedence", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-decoded-startup-"));
  const env = { XDG_CONFIG_HOME: path.join(home, "xdg") };
  const probe = (override) => {
    const childEnv = { ...process.env, ...env, CCDX_MAX_BODY_BYTES: String(256 * 1024 * 1024) };
    delete childEnv.CCDX_MAX_DECODED_BODY_BYTES;
    if (override) childEnv.CCDX_MAX_DECODED_BODY_BYTES = override;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", probeScript], {
      env: childEnv, encoding: "utf8", timeout: 10000,
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout.trim());
  };
  try {
    assert.deepEqual(probe(), {
      limit: 128 * 1024 * 1024, status: 413,
      message: "Decoded request body exceeds 134217728 bytes",
    });
    writeDecodedBodyLimitMib(256, { env, home });
    const saved = probe();
    assert.equal(saved.limit, 256 * 1024 * 1024);
    assert.equal(saved.status, 400);
    assert.match(saved.message, /request body/);
    assert.equal(probe("134217728").limit, 128 * 1024 * 1024);
    writeDecodedBodyLimitMib(null, { env, home });
    assert.equal(probe().limit, 128 * 1024 * 1024);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
