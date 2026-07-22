import test from "node:test";
import assert from "node:assert/strict";
import {
  githubIdentitiesEqual,
  githubIdentityLabel,
  githubIdentityMatchesExpected,
  githubTokenFingerprint,
  normalizeGithubIdentity,
} from "../src/github-identity.mjs";

test("normalizeGithubIdentity: trims login and stringifies id", () => {
  assert.deepEqual(normalizeGithubIdentity({ login: " Dale ", id: 42 }), { login: "Dale", id: "42" });
  assert.equal(normalizeGithubIdentity({ login: " ", id: null }), null);
});

test("githubIdentitiesEqual: prefers stable ids and falls back to case-insensitive login", () => {
  assert.equal(githubIdentitiesEqual({ login: "dale", id: 1 }, { login: "DALE", id: 1 }), true);
  assert.equal(githubIdentitiesEqual({ login: "dale", id: 1 }, { login: "dale", id: 2 }), false);
  assert.equal(githubIdentitiesEqual({ login: "Dale" }, { login: "dale", id: 2 }), true);
  assert.equal(githubIdentitiesEqual(null, { login: "dale" }), false);
});

test("githubIdentityMatchesExpected: an absent expectation does not constrain discovery", () => {
  assert.equal(githubIdentityMatchesExpected(null, null), true);
  assert.equal(githubIdentityMatchesExpected(null, { login: "dale" }), false);
  assert.equal(githubIdentityMatchesExpected({ login: "DALE" }, { login: "dale" }), true);
  assert.equal(githubIdentityLabel({ id: 42 }), "42");
});

test("githubTokenFingerprint: returns a stable non-secret digest prefix", () => {
  const fingerprint = githubTokenFingerprint("secret-token");
  assert.match(fingerprint, /^[a-f0-9]{24}$/);
  assert.equal(fingerprint, githubTokenFingerprint("secret-token"));
  assert.notEqual(fingerprint, githubTokenFingerprint("other-token"));
  assert.equal(fingerprint.includes("secret"), false);
});
