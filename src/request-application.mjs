const APPLICATIONS = new Set(["codex_app", "codex_cli", "claude_app", "claude_code", "claude", "api"]);
const DECLARED = new Map([["codex-app", "codex_app"], ["codex-cli", "codex_cli"], ["claude-app", "claude_app"], ["claude-code", "claude_code"]]);
const ORIGINATORS = new Map([["codex_desktop", "codex_app"], ["codex_app", "codex_app"], ["codex_cli_rs", "codex_cli"]]);

export function requestApplication(headers = {}, fallback = "api") {
  const declared = DECLARED.get(headers?.["x-ccdx-client"]);
  if (declared) return declared;
  // These are client-reported presentation hints, never routing or auth evidence.
  const originator = ORIGINATORS.get(headers?.originator);
  return originator || (APPLICATIONS.has(fallback) ? fallback : "api");
}

export function applicationLabel(value) {
  return APPLICATIONS.has(value) ? value : "api";
}
