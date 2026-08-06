import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { atomicWriteFileSync } from "../src/atomic-file.mjs";
import {
  AUTH_PROFILE_CLAUDE,
  AUTH_PROFILE_CODEX,
  authProfilePaths,
  readAuthProfileCredentials,
  writeClaudeAuthProfile,
} from "../src/auth-profile.mjs";
import {
  githubTokenMetadataPath,
  githubTokenPath,
  writeToken,
} from "../src/auth.mjs";

test("authProfilePaths: preserves the legacy Codex paths and isolates Claude", () => {
  const home = "/tmp/ccdx-profile-home";
  const codex = authProfilePaths(AUTH_PROFILE_CODEX, { home });
  const claude = authProfilePaths(AUTH_PROFILE_CLAUDE, { home });

  assert.equal(codex.tokenPath, githubTokenPath(home));
  assert.equal(codex.metadataPath, githubTokenMetadataPath(home));
  assert.equal(codex.lockPath, `${githubTokenPath(home)}.lock`);
  assert.equal(claude.tokenPath, path.join(home, ".local", "share", "copilot-api", "profiles", "claude", "github_token"));
  assert.notEqual(claude.lockPath, codex.lockPath);
});

test("readAuthProfileCredentials: legacy Codex accepts a token without metadata", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-profile-codex-"));
  fs.mkdirSync(path.dirname(githubTokenPath(home)), { recursive: true });
  fs.writeFileSync(githubTokenPath(home), "ghu_enterprise", { mode: 0o600 });

  const profile = readAuthProfileCredentials(AUTH_PROFILE_CODEX, { home });
  assert.equal(profile.configured, true);
  assert.equal(profile.valid, true);
  assert.equal(profile.identity, null);
  assert.equal(profile.token, "ghu_enterprise");
});

test("readAuthProfileCredentials: ignores stale Codex metadata identity", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-profile-stale-"));
  writeToken("ghu_enterprise", home, { login: "enterprise", id: 1 });
  fs.writeFileSync(githubTokenPath(home), "ghu_replaced", { mode: 0o600 });

  const profile = readAuthProfileCredentials(AUTH_PROFILE_CODEX, { home });
  assert.equal(profile.valid, true);
  assert.equal(profile.identity, null);
});

test("readAuthProfileCredentials: ignores legacy Codex metadata without a token fingerprint", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-profile-unbound-metadata-"));
  fs.mkdirSync(path.dirname(githubTokenPath(home)), { recursive: true });
  fs.writeFileSync(githubTokenPath(home), "ghu_enterprise", { mode: 0o600 });
  fs.writeFileSync(githubTokenMetadataPath(home), JSON.stringify({
    login: "stale-account",
    id: 99,
  }), { mode: 0o600 });

  const profile = readAuthProfileCredentials(AUTH_PROFILE_CODEX, { home });
  assert.equal(profile.valid, true);
  assert.equal(profile.identity, null);
});

test("writeClaudeAuthProfile: atomically activates an isolated 0600 credential pair", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-profile-claude-"));
  const before = readAuthProfileCredentials(AUTH_PROFILE_CLAUDE, { home });
  assert.equal(before.configured, false);

  writeClaudeAuthProfile("ghu_personal", { login: "personal", id: 2 }, {
    home,
    now: () => new Date("2026-08-06T00:00:00.000Z"),
  });

  const profile = readAuthProfileCredentials(AUTH_PROFILE_CLAUDE, { home });
  assert.equal(profile.configured, true);
  assert.equal(profile.valid, true);
  assert.equal(profile.identity.login, "personal");
  assert.equal(profile.metadata.profile, AUTH_PROFILE_CLAUDE);
  assert.equal(profile.metadata.updated_at, "2026-08-06T00:00:00.000Z");
  assert.equal(fs.statSync(profile.paths.tokenPath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(profile.paths.metadataPath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(profile.paths.tokenPath)).mode & 0o777, 0o700);
});

test("writeClaudeAuthProfile: failed reauth restores the previous credential pair", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-profile-rollback-"));
  writeClaudeAuthProfile("ghu_old", { login: "personal", id: 2 }, { home });
  const before = readAuthProfileCredentials(AUTH_PROFILE_CLAUDE, { home });
  const beforeMetadata = fs.readFileSync(before.paths.metadataPath, "utf8");
  let writes = 0;
  const failMetadataOnce = (filePath, data, options) => {
    writes += 1;
    if (writes === 2) throw new Error("simulated metadata failure");
    atomicWriteFileSync(filePath, data, options);
  };

  assert.throws(
    () => writeClaudeAuthProfile("ghu_new", { login: "another", id: 3 }, {
      home,
      writeFile: failMetadataOnce,
    }),
    /simulated metadata failure/,
  );

  const after = readAuthProfileCredentials(AUTH_PROFILE_CLAUDE, { home });
  assert.equal(after.valid, true);
  assert.equal(after.token, "ghu_old");
  assert.equal(after.identity.login, "personal");
  assert.equal(fs.readFileSync(after.paths.metadataPath, "utf8"), beforeMetadata);
});

test("Claude activation fails closed for partial credentials and never changes Codex files", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-profile-isolation-"));
  writeToken("ghu_enterprise", home, { login: "enterprise", id: 1 });
  const codexToken = fs.readFileSync(githubTokenPath(home));
  const codexMetadata = fs.readFileSync(githubTokenMetadataPath(home));
  const paths = authProfilePaths(AUTH_PROFILE_CLAUDE, { home });
  fs.mkdirSync(path.dirname(paths.tokenPath), { recursive: true });
  fs.writeFileSync(paths.tokenPath, "ghu_orphan", { mode: 0o600 });

  const partial = readAuthProfileCredentials(AUTH_PROFILE_CLAUDE, { home });
  assert.equal(partial.configured, true);
  assert.equal(partial.valid, false);
  assert.equal(partial.reason, "missing_metadata");
  writeClaudeAuthProfile("ghu_personal", { login: "personal", id: 2 }, { home });

  assert.deepEqual(fs.readFileSync(githubTokenPath(home)), codexToken);
  assert.deepEqual(fs.readFileSync(githubTokenMetadataPath(home)), codexMetadata);
  assert.equal(readAuthProfileCredentials(AUTH_PROFILE_CLAUDE, { home }).configured, true);
});
