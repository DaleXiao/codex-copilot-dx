import { createHash } from "node:crypto";

export function normalizeGithubIdentity(identity) {
  if (!identity || typeof identity !== "object") return null;
  const login = typeof identity.login === "string" ? identity.login.trim() : "";
  const id = identity.id === undefined || identity.id === null ? "" : String(identity.id).trim();
  return login || id ? { login, id } : null;
}

export function githubTokenFingerprint(token) {
  return createHash("sha256").update(String(token || "")).digest("hex").slice(0, 24);
}

export function githubIdentitiesEqual(first, second) {
  const a = normalizeGithubIdentity(first);
  const b = normalizeGithubIdentity(second);
  if (!a || !b) return false;
  if (a.id && b.id) return a.id === b.id;
  return Boolean(a.login && b.login && a.login.toLowerCase() === b.login.toLowerCase());
}

export function githubIdentityMatchesExpected(identity, expected) {
  if (!normalizeGithubIdentity(expected)) return true;
  return githubIdentitiesEqual(identity, expected);
}

export function githubIdentityLabel(identity) {
  const normalized = normalizeGithubIdentity(identity);
  return normalized?.login || normalized?.id || "unknown";
}
