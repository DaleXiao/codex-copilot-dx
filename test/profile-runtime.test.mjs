import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { githubTokenPath } from "../src/auth.mjs";
import { githubTokenFingerprint } from "../src/github-identity.mjs";
import { createProfileRuntime } from "../src/profile-runtime.mjs";

test("createProfileRuntime exposes the supplied Codex client only", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-profile-runtime-"));
  const tokenPath = githubTokenPath(home);
  fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
  fs.writeFileSync(tokenPath, "github-enterprise\n");
  const codexClient = { name: "codex" };

  const runtime = createProfileRuntime({ home, codexClient });

  assert.deepEqual(Object.keys(runtime).sort(), [
    "codexClient",
    "codexCredentialFingerprint",
    "codexProfile",
  ]);
  assert.equal(runtime.codexClient, codexClient);
  assert.equal(runtime.codexProfile.valid, true);
  assert.equal(runtime.codexCredentialFingerprint, githubTokenFingerprint("github-enterprise"));
  assert.equal(Object.isFrozen(runtime), true);
});

test("createProfileRuntime remains usable when Codex credentials are absent", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-profile-runtime-empty-"));
  const runtime = createProfileRuntime({ home, codexClient: {} });

  assert.equal(runtime.codexProfile.configured, false);
  assert.equal(runtime.codexProfile.valid, false);
  assert.equal(runtime.codexProfile.reason, "unconfigured");
  assert.equal(runtime.codexCredentialFingerprint, "");
});
