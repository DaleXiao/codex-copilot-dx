const APPLICATIONS = new Set(["codex_app", "codex_cli", "codex", "claude_app", "claude_code", "claude", "api"]);
const DECLARED = new Map([["codex-app", "codex_app"], ["codex-cli", "codex_cli"], ["codex", "codex"], ["claude-app", "claude_app"], ["claude-code", "claude_code"]]);
const ORIGINATORS = new Map([["codex desktop", "codex_app"], ["codex_desktop", "codex_app"], ["codex_app", "codex_app"], ["codex_cli_rs", "codex_cli"], ["codex_exec", "codex_cli"], ["codex-cli", "codex_cli"], ["codex", "codex"], ["codex_vscode", "codex"]]);
const hint = value => typeof value === "string" && value.length <= 80 ? value.trim().toLowerCase() : "";

export function requestApplication(headers = {}, fallback = "api") {
  const declared = DECLARED.get(hint(headers?.["x-ccdx-client"]));
  if (declared) return declared;
  // These are client-reported presentation hints, never routing or auth evidence.
  const originator = ORIGINATORS.get(hint(headers?.originator));
  if (originator) return originator;
  // Accept only a known, versioned Codex agent prefix, never a substring match.
  const agent = headers?.["user-agent"];
  const prefix = typeof agent === "string" && agent.length <= 512
    ? /^(codex desktop|codex_desktop|codex_app|codex_cli_rs|codex_exec|codex-cli|codex_vscode|codex)\/\d[\w.+-]{0,63}(?:\s|$)/i.exec(agent)?.[1] : null;
  return ORIGINATORS.get(hint(prefix)) || (APPLICATIONS.has(fallback) ? fallback : "api");
}

export function applicationLabel(value) {
  return APPLICATIONS.has(value) ? value : "api";
}
