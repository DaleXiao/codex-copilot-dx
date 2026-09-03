import {
  AUTH_PROFILE_CODEX,
  readAuthProfileCredentials,
} from "./auth-profile.mjs";
import { defaultCopilotClient } from "./copilot.mjs";
import { githubTokenFingerprint } from "./github-identity.mjs";

function safeProfileStatus(credentials) {
  const identity = credentials.identity
    ? {
        login: credentials.identity.login,
        id: credentials.identity.id,
      }
    : null;
  return Object.freeze({
    profile: credentials.profile,
    configured: credentials.configured,
    valid: credentials.valid,
    reason: credentials.reason,
    identity: identity ? Object.freeze(identity) : null,
  });
}

export function createProfileRuntime({
  home,
  codexClient = defaultCopilotClient,
} = {}) {
  let credentials;
  try {
    credentials = readAuthProfileCredentials(AUTH_PROFILE_CODEX, { home });
  } catch {
    credentials = {
      profile: AUTH_PROFILE_CODEX,
      configured: true,
      valid: false,
      reason: "credential_read_failed",
      token: "",
      identity: null,
    };
  }

  return Object.freeze({
    codexClient,
    codexProfile: safeProfileStatus(credentials),
    codexCredentialFingerprint: credentials.valid
      ? githubTokenFingerprint(credentials.token)
      : "",
  });
}
