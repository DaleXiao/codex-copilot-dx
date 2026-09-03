import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AUTH_PROFILE_CODEX,
  authProfilePaths,
  readAuthProfileCredentials,
} from "../src/auth-profile.mjs";
import { githubTokenFingerprint } from "../src/github-identity.mjs";

test("auth profile exposes only the legacy Codex credential paths", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-auth-profile-"));
  const paths = authProfilePaths(AUTH_PROFILE_CODEX, { home });

  assert.equal(paths.tokenPath, path.join(home, ".local", "share", "copilot-api", "github_token"));
  assert.equal(paths.metadataPath, `${paths.tokenPath}.account.json`);
  assert.equal(paths.lockPath, `${paths.tokenPath}.lock`);
  assert.throws(() => authProfilePaths("claude", { home }), /Unsupported authentication profile/);
});

test("Codex credentials distinguish missing and empty tokens", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-auth-profile-state-"));
  const paths = authProfilePaths(AUTH_PROFILE_CODEX, { home });
  assert.deepEqual(
    readAuthProfileCredentials(AUTH_PROFILE_CODEX, { home }),
    {
      profile: "codex",
      configured: false,
      valid: false,
      reason: "unconfigured",
      token: "",
      identity: null,
      metadata: null,
      paths,
    },
  );

  fs.mkdirSync(path.dirname(paths.tokenPath), { recursive: true });
  fs.writeFileSync(paths.tokenPath, "\n");
  const empty = readAuthProfileCredentials(AUTH_PROFILE_CODEX, { home });
  assert.equal(empty.configured, true);
  assert.equal(empty.valid, false);
  assert.equal(empty.reason, "empty_token");
});

test("Codex credentials trust identity metadata only when bound to the token", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-auth-profile-metadata-"));
  const paths = authProfilePaths(AUTH_PROFILE_CODEX, { home });
  fs.mkdirSync(path.dirname(paths.tokenPath), { recursive: true });
  fs.writeFileSync(paths.tokenPath, "github-token\n");
  fs.writeFileSync(paths.metadataPath, JSON.stringify({
    login: "octocat",
    id: 7,
    token_fingerprint: githubTokenFingerprint("github-token"),
  }));

  const valid = readAuthProfileCredentials(AUTH_PROFILE_CODEX, { home });
  assert.equal(valid.valid, true);
  assert.deepEqual(valid.identity, { login: "octocat", id: "7" });

  fs.writeFileSync(paths.tokenPath, "different-token\n");
  assert.equal(readAuthProfileCredentials(AUTH_PROFILE_CODEX, { home }).identity, null);
});
