import {
  AUTH_PROFILE_CLAUDE,
  authProfilePaths,
  profileReauthMessage,
  readAuthProfileCredentials,
} from "./auth-profile.mjs";
import { createCopilotClient, defaultCopilotClient } from "./copilot.mjs";
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
  const unreadableCredentials = () => ({
    profile: AUTH_PROFILE_CLAUDE,
    configured: true,
    valid: false,
    reason: "credential_read_failed",
    token: "",
    identity: null,
    paths: authProfilePaths(AUTH_PROFILE_CLAUDE, { home }),
  });
  const readCredentials = () => {
    try {
      return readAuthProfileCredentials(AUTH_PROFILE_CLAUDE, { home });
    } catch {
      return unreadableCredentials();
    }
  };
  const credentials = readCredentials();
  const claudeProfile = safeProfileStatus(credentials);

  if (!credentials.configured) {
    return Object.freeze({
      codexClient,
      claudeClient: codexClient,
      claudeMode: "inherited",
      claudeProfile,
      claudeCredentialFingerprint: "",
    });
  }

  const readRuntimeCredentials = credentials.reason === "credential_read_failed"
    ? () => credentials
    : readCredentials;
  const claudeClient = createCopilotClient({
    profile: AUTH_PROFILE_CLAUDE,
    home,
    tokenPath: credentials.paths.tokenPath,
    allowTokenDiscovery: false,
    readGithubCredentials: readRuntimeCredentials,
    reauthMessage: (reason) => `${reason}\n${profileReauthMessage(AUTH_PROFILE_CLAUDE, { home })}`,
  });

  return Object.freeze({
    codexClient,
    claudeClient,
    claudeMode: "isolated",
    claudeProfile,
    claudeCredentialFingerprint: credentials.valid
      ? githubTokenFingerprint(credentials.token)
      : "",
  });
}
