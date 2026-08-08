import os from "node:os";
import { spawn } from "node:child_process";
import {
  discoverGithubToken,
  fetchGithubIdentity,
  interpretPoll,
  sourceDescription,
  validateGithubToken,
} from "./auth.mjs";
import {
  AUTH_PROFILE_CLAUDE,
  AUTH_PROFILE_CODEX,
  readAuthProfileCredentials,
  withAuthProfileLock,
  writeClaudeAuthProfile,
} from "./auth-profile.mjs";
import { buildHeaders, DEFAULT_API_BASE, FALLBACK_VSCODE_VERSION } from "./copilot.mjs";
import {
  githubIdentitiesEqual,
  githubTokenFingerprint,
  normalizeGithubIdentity,
} from "./github-identity.mjs";
import { saveModelCache } from "./model-cache.mjs";
import { profileRouting } from "./profile-routing.mjs";
import { status } from "./status.mjs";

const CLIENT_ID = "Iv1.b507a08c87ecfe98";
const SCOPE = "read:user";
const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
const DEFAULT_DEVICE_INTERVAL_SECONDS = 5;
const DEFAULT_DEVICE_EXPIRES_SECONDS = 900;

function abortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

function sleep(ms, { signal } = {}) {
  if (signal?.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(abortError(signal));
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function openAndCopy(userCode, verificationUri) {
  if (process.platform !== "darwin") return;
  try {
    const clipboard = spawn("pbcopy");
    clipboard.on("error", () => {});
    clipboard.stdin.on("error", () => {});
    clipboard.stdin.end(userCode);
  } catch {}
  try {
    const browser = spawn("open", [verificationUri], { detached: true, stdio: "ignore" });
    browser.on("error", () => {});
  } catch {}
}

function responseDetail(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 240);
}

async function jsonResponse(response, label) {
  if (!response.ok) throw new Error(`${label} failed with HTTP ${response.status}`);
  try {
    return await response.json();
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
}

export async function requestDeviceFlowToken({
  fetchImpl = fetch,
  signal,
  log = console.log,
  openAndCopyFn = openAndCopy,
  sleepImpl = sleep,
  now = Date.now,
} = {}) {
  const codeResponse = await fetchImpl(DEVICE_CODE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ client_id: CLIENT_ID, scope: SCOPE }),
    signal,
  });
  const code = await jsonResponse(codeResponse, "Device code request");
  if (!code.device_code || !code.user_code || !code.verification_uri) {
    throw new Error("Device code response is missing required fields");
  }

  log(`\n${status("info", `Open ${code.verification_uri}`)}\n${status("info", `Enter Claude account code: ${code.user_code}`)}\n`);
  openAndCopyFn(code.user_code, code.verification_uri);

  let waitMs = (Number(code.interval) || DEFAULT_DEVICE_INTERVAL_SECONDS) * 1000;
  const expiresMs = (Number(code.expires_in) || DEFAULT_DEVICE_EXPIRES_SECONDS) * 1000;
  const deadline = now() + expiresMs;

  while (now() < deadline) {
    await sleepImpl(waitMs, { signal });
    const pollResponse = await fetchImpl(ACCESS_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        device_code: code.device_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
      signal,
    });
    if (!pollResponse.ok) continue;
    const result = interpretPoll(await pollResponse.json());
    if (result.state === "done") return result.token;
    if (result.state === "slow") {
      waitMs += 5000;
      continue;
    }
    if (result.state === "fail") throw new Error(`Claude login failed: ${result.error}`);
  }
  throw new Error("Claude login failed: device code expired");
}

async function codexIdentity({ home, fetchImpl, signal }) {
  const codex = readAuthProfileCredentials(AUTH_PROFILE_CODEX, { home });
  if (!codex.valid) throw new Error("The existing Codex GitHub account is not configured; refusing to create an unbound Claude profile");
  const tokenFingerprint = githubTokenFingerprint(codex.token);
  if (codex.identity) return { identity: codex.identity, tokenFingerprint };
  const identity = await fetchGithubIdentity(codex.token, { fetchImpl, signal });
  if (!identity.ok) throw new Error("Could not verify the existing Codex GitHub account; its credential was not changed");
  return { identity: normalizeGithubIdentity(identity), tokenFingerprint };
}

function claudeModels(payload) {
  const models = Array.isArray(payload) ? payload : payload?.data;
  if (!Array.isArray(models)) throw new Error("Claude account model catalog contained no model list");
  return models.filter((model) => {
    const id = String(model?.id || "").trim();
    const vendor = String(model?.vendor || model?.owned_by || "").trim().toLowerCase();
    const policy = String(model?.policy?.state || "").trim().toLowerCase();
    const endpoints = Array.isArray(model?.supported_endpoints) ? model.supported_endpoints : [];
    return Boolean(id)
      && (id.toLowerCase().startsWith("claude-") || vendor === "anthropic")
      && model?.model_picker_enabled === true
      && (!policy || policy === "enabled")
      && (endpoints.includes("/chat/completions") || endpoints.includes("/v1/messages"));
  });
}

function catalogModels(payload) {
  const models = Array.isArray(payload) ? payload : payload?.data;
  if (!Array.isArray(models)) throw new Error("Copilot model catalog contained no model list");
  return models;
}

async function fetchCopilotCatalog(tokenData, {
  fetchImpl,
  signal,
  vscodeVersion = FALLBACK_VSCODE_VERSION,
  label = "Copilot",
} = {}) {
  const apiBase = tokenData?.endpoints?.api || DEFAULT_API_BASE;
  const headers = buildHeaders({
    token: tokenData.token,
    version: vscodeVersion,
    initiator: "user",
    vision: false,
  });
  const modelResponse = await fetchImpl(`${apiBase}/models`, {
    headers,
    redirect: "error",
    signal,
  });
  const modelText = await modelResponse.text();
  if (!modelResponse.ok) {
    const detail = responseDetail(modelText);
    throw new Error(`${label} model catalog failed with HTTP ${modelResponse.status}${detail ? `: ${detail}` : ""}`);
  }

  let catalog;
  try {
    catalog = JSON.parse(modelText);
  } catch {
    throw new Error(`${label} model catalog returned invalid JSON`);
  }
  catalogModels(catalog);
  return { catalog, apiBase };
}

export async function validateClaudeCandidate(githubToken, {
  home = os.homedir(),
  expectedLogin = "",
  fetchImpl = fetch,
  signal,
  vscodeVersion = FALLBACK_VSCODE_VERSION,
} = {}) {
  const validation = await validateGithubToken(githubToken, { fetchImpl, signal });
  if (!validation.ok) {
    const httpStatus = validation.status ? ` (HTTP ${validation.status})` : "";
    throw new Error(`Claude GitHub/Copilot validation failed: ${validation.reason}${httpStatus}`);
  }

  const identity = normalizeGithubIdentity(validation);
  if (!identity) throw new Error("Claude GitHub account identity is missing");
  const pinnedLogin = String(expectedLogin || "").trim();
  if (pinnedLogin && identity.login.toLowerCase() !== pinnedLogin.toLowerCase()) {
    throw new Error(`Authorized GitHub account ${identity.login || identity.id} does not match requested Claude account ${pinnedLogin}`);
  }

  const existingCodex = await codexIdentity({ home, fetchImpl, signal });
  if (githubIdentitiesEqual(identity, existingCodex.identity)) {
    throw new Error(`Claude must use a different GitHub account; ${identity.login || identity.id} is already the Codex account`);
  }

  const { catalog, apiBase } = await fetchCopilotCatalog(validation.copilotTokenData, {
    fetchImpl,
    signal,
    vscodeVersion,
    label: "Claude account",
  });
  const models = claudeModels(catalog);
  if (!models.length) {
    throw new Error(`GitHub account ${identity.login || identity.id} has Copilot access but advertises no enabled Claude models`);
  }

  return {
    identity,
    models,
    catalog,
    apiBase,
    codexTokenFingerprint: existingCodex.tokenFingerprint,
  };
}

export async function authorizeClaudeProfile({
  home = os.homedir(),
  env = process.env,
  reauth = false,
  expectedLogin = "",
  fetchImpl = fetch,
  signal,
  log = console.log,
  openAndCopyFn = openAndCopy,
  sleepImpl = sleep,
  now = Date.now,
  saveModelCacheFn = saveModelCache,
} = {}) {
  return withAuthProfileLock(AUTH_PROFILE_CLAUDE, async () => {
    const current = readAuthProfileCredentials(AUTH_PROFILE_CLAUDE, { home });
    if (current.configured && current.valid && !reauth) {
      const pinnedLogin = String(expectedLogin || "").trim();
      const currentLogin = String(current.identity?.login || "");
      if (pinnedLogin && currentLogin.toLowerCase() !== pinnedLogin.toLowerCase()) {
        throw new Error(`Claude is already authenticated as ${currentLogin || current.identity?.id || "another account"}; use --reauth to authorize ${pinnedLogin}`);
      }
      return { changed: false, profile: AUTH_PROFILE_CLAUDE, identity: current.identity, models: [] };
    }
    if (current.configured && !reauth) {
      throw new Error(`Claude profile is configured but invalid (${current.reason}); run ccdx auth login claude --reauth`);
    }

    let githubToken = "";
    if (!reauth) {
      const codex = readAuthProfileCredentials(AUTH_PROFILE_CODEX, { home });
      if (!codex.valid) {
        throw new Error("The existing Codex GitHub account is not configured; refusing to create an unbound Claude profile");
      }
      const existingCodex = await codexIdentity({ home, fetchImpl, signal });
      const pinnedLogin = String(expectedLogin || "").trim();
      const discovered = await discoverGithubToken({
        home,
        env,
        fetchImpl,
        signal,
        excludeTokens: [codex.token],
        excludeIdentities: [existingCodex.identity],
        expectedIdentity: pinnedLogin ? { login: pinnedLogin } : undefined,
        strictExpectedIdentity: Boolean(pinnedLogin),
      });
      if (discovered.ambiguous) {
        const accounts = [...new Set(discovered.candidates
          .map((candidate) => candidate.login || candidate.id || "unknown"))];
        throw new Error(`Multiple reusable GitHub Copilot accounts were found (${accounts.join(", ")}). Use --github-login or CCDX_GITHUB_TOKEN_PATH to select the Claude account.`);
      }
      if (discovered.ok) {
        githubToken = discovered.token;
        const login = discovered.validation?.login ? ` for ${discovered.validation.login}` : "";
        log(status("info", `Reusing a local Copilot credential from ${sourceDescription(discovered.source)}${login}`));
      }
    }
    if (!githubToken) {
      githubToken = await requestDeviceFlowToken({
        fetchImpl,
        signal,
        log,
        openAndCopyFn,
        sleepImpl,
        now,
      });
    }
    const candidate = await validateClaudeCandidate(githubToken, {
      home,
      expectedLogin,
      fetchImpl,
      signal,
    });
    await withAuthProfileLock(AUTH_PROFILE_CODEX, () => {
      const currentCodex = readAuthProfileCredentials(AUTH_PROFILE_CODEX, { home });
      if (!currentCodex.valid
        || githubTokenFingerprint(currentCodex.token) !== candidate.codexTokenFingerprint) {
        throw new Error("Codex authentication changed while Claude was being authorized; no Claude credential was saved. Retry the command.");
      }
      writeClaudeAuthProfile(githubToken, candidate.identity, { home });
    }, { home, env });
    let modelCacheSaved = false;
    try {
      modelCacheSaved = saveModelCacheFn(candidate.catalog, {
        home,
        profile: AUTH_PROFILE_CLAUDE,
        credentialFingerprint: githubTokenFingerprint(githubToken),
      }) === true;
      if (!modelCacheSaved) throw new Error("model catalog was not cacheable");
    } catch (error) {
      log(status("warn", `Claude authentication succeeded, but its model cache could not be saved (${error.message})`));
    }
    log(status("ok", `Claude authenticated as ${candidate.identity.login || candidate.identity.id}; existing Codex authentication was not changed`));
    return {
      changed: true,
      profile: AUTH_PROFILE_CLAUDE,
      identity: candidate.identity,
      models: candidate.models,
      catalog: candidate.catalog,
      apiBase: candidate.apiBase,
      modelCacheSaved,
    };
  }, { home, env });
}

function publicProfile(credentials, source) {
  return {
    configured: credentials.configured,
    valid: credentials.valid,
    reason: credentials.reason,
    login: credentials.identity?.login || "",
    id: credentials.identity?.id || "",
    source,
  };
}

function readStatusCredentials(profile, home) {
  try {
    return readAuthProfileCredentials(profile, { home });
  } catch {
    // Treat an unreadable optional profile as configured-but-invalid. This
    // keeps status useful without leaking a filesystem path or silently
    // borrowing the other account.
    return {
      profile,
      configured: true,
      valid: false,
      reason: "credential_read_failed",
      token: "",
      identity: null,
    };
  }
}

export function authStatus({ home = os.homedir() } = {}) {
  const codex = readStatusCredentials(AUTH_PROFILE_CODEX, home);
  const claude = readStatusCredentials(AUTH_PROFILE_CLAUDE, home);
  return {
    profiles: {
      codex: publicProfile(codex, "legacy"),
      claude: publicProfile(claude, "isolated"),
    },
    routing: profileRouting({ claudeConfigured: claude.configured }),
  };
}

async function inspectProfileOnline(credentials, {
  fetchImpl,
  timeoutMs,
  inherited = false,
} = {}) {
  if (inherited) {
    return { checked: false, inherited: true, ok: null, reason: "inherits_codex" };
  }
  if (!credentials.valid) {
    return { checked: false, inherited: false, ok: false, reason: credentials.reason || "unconfigured" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const validation = await validateGithubToken(credentials.token, {
      fetchImpl,
      signal: controller.signal,
    });
    if (!validation.ok) {
      return {
        checked: true,
        inherited: false,
        ok: false,
        reason: validation.reason,
        httpStatus: validation.status || null,
      };
    }
    const { catalog, apiBase } = await fetchCopilotCatalog(validation.copilotTokenData, {
      fetchImpl,
      signal: controller.signal,
      label: credentials.profile === AUTH_PROFILE_CLAUDE ? "Claude account" : "Codex account",
    });
    const models = catalogModels(catalog);
    let upstreamHost = "GitHub Copilot";
    try { upstreamHost = new URL(apiBase).hostname; } catch {}
    return {
      checked: true,
      inherited: false,
      ok: true,
      login: validation.login || credentials.identity?.login || "",
      models: models.length,
      claudeModels: claudeModels(catalog).length,
      upstreamHost,
    };
  } catch (error) {
    return {
      checked: true,
      inherited: false,
      ok: false,
      reason: controller.signal.aborted ? `timed out after ${timeoutMs}ms` : error.message,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function authStatusOnline({
  home = os.homedir(),
  fetchImpl = fetch,
  timeoutMs = 10000,
} = {}) {
  const local = authStatus({ home });
  const codexCredentials = readStatusCredentials(AUTH_PROFILE_CODEX, home);
  const claudeCredentials = readStatusCredentials(AUTH_PROFILE_CLAUDE, home);
  const [codexOnline, claudeOnline] = await Promise.all([
    inspectProfileOnline(codexCredentials, { fetchImpl, timeoutMs }),
    inspectProfileOnline(claudeCredentials, {
      fetchImpl,
      timeoutMs,
      inherited: !claudeCredentials.configured,
    }),
  ]);
  return {
    ...local,
    profiles: {
      codex: { ...local.profiles.codex, online: codexOnline },
      claude: { ...local.profiles.claude, online: claudeOnline },
    },
  };
}

function accountLabel(profile) {
  if (!profile.configured) return "not configured";
  if (!profile.valid) return `invalid (${profile.reason})`;
  return profile.login || profile.id || "configured";
}

function onlineStatusLine(name, profile) {
  const online = profile.online;
  if (!online) return null;
  if (online.inherited) return status("info", `${name} online: inherits the Codex profile`);
  if (!online.ok) {
    const httpStatus = online.httpStatus ? ` (HTTP ${online.httpStatus})` : "";
    return status("warn", `${name} online: ${online.reason || "unavailable"}${httpStatus}`);
  }
  const account = online.login ? `${online.login}; ` : "";
  return status("ok", `${name} online: ${account}${online.models} models, ${online.claudeModels} Claude`);
}

export function formatAuthStatus(snapshot = authStatus(), { commandName = "ccdx" } = {}) {
  const claudeLabel = snapshot.profiles.claude.configured
    ? `${accountLabel(snapshot.profiles.claude)} [isolated profile]`
    : "inherits Codex [no isolated profile]";
  const claudeKind = snapshot.profiles.claude.valid
    ? "ok"
    : snapshot.profiles.claude.configured ? "warn" : "info";
  return [
    `${commandName} auth status`,
    status(snapshot.profiles.codex.valid ? "ok" : "warn", `Codex: ${accountLabel(snapshot.profiles.codex)} [legacy path]`),
    onlineStatusLine("Codex", snapshot.profiles.codex),
    status(claudeKind, `Claude: ${claudeLabel}`),
    onlineStatusLine("Claude", snapshot.profiles.claude),
    status("info", `Routing: responses -> ${snapshot.routing.responses}; messages -> ${snapshot.routing.messages}`),
  ].filter(Boolean).join("\n");
}

export async function runAuthCommand({
  action = "status",
  profile = "",
  online = false,
  reauth = false,
  expectedLogin = "",
  commandName = "ccdx",
  ...options
} = {}) {
  if (action === "status") {
    const snapshot = online ? await authStatusOnline(options) : authStatus(options);
    return { action, output: formatAuthStatus(snapshot, { commandName }), snapshot };
  }
  if (profile !== AUTH_PROFILE_CLAUDE) throw new Error("Only the isolated Claude profile can be changed by this command");
  if (action === "login") return { action, ...(await authorizeClaudeProfile({ ...options, reauth, expectedLogin })) };
  throw new Error(`Unsupported auth action: ${action}`);
}
