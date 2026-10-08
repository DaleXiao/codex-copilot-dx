import { authStatus, authStatusOnline } from "./auth-status.mjs";
import { status } from "./status.mjs";
import {
  cliOutputFormat,
  cliOutputWidth,
  formatResponsiveCliTable,
  terminalCell,
} from "./cli-table.mjs";

export { authStatus, authStatusOnline } from "./auth-status.mjs";

function accountLabel(profile) {
  if (!profile.configured) return "not configured";
  if (!profile.valid) return `invalid (${profile.reason})`;
  return profile.login || profile.id || "configured";
}

function onlineStatusLine(profile) {
  const online = profile.online;
  if (!online) return null;
  if (!online.ok) {
    const httpStatus = online.httpStatus ? ` (HTTP ${online.httpStatus})` : "";
    return status("warn", `Codex online: ${online.reason || "unavailable"}${httpStatus}`);
  }
  const account = online.login ? `${online.login}; ` : "";
  return status("ok", `Codex online: ${account}${online.models} models`);
}

function authStatusPlainLines(snapshot, { commandName }) {
  return [
    `${commandName} auth status`,
    status(snapshot.profiles.codex.valid ? "ok" : "warn", `Codex: ${accountLabel(snapshot.profiles.codex)} [legacy path]`),
    onlineStatusLine(snapshot.profiles.codex),
    status("info", `Routing: responses -> ${snapshot.routing.responses}`),
  ].filter(Boolean);
}

function authTableOnline(profile) {
  const online = profile.online;
  if (!online) return { state: "[INFO] not checked", models: "—" };
  if (!online.ok) {
    const httpStatus = online.httpStatus ? ` (HTTP ${online.httpStatus})` : "";
    return { state: `[WARN] ${online.reason || "unavailable"}${httpStatus}`, models: "—" };
  }
  return {
    state: `[OK] verified${online.login ? ` as ${online.login}` : ""}`,
    models: Number.isFinite(online.models) ? String(online.models) : "—",
  };
}

export function formatAuthStatus(snapshot = authStatus(), {
  commandName = "ccdx",
  format = "plain",
  output = process.stdout,
  width = cliOutputWidth(output),
} = {}) {
  const plainLines = authStatusPlainLines(snapshot, { commandName });
  if (cliOutputFormat(format, output) === "plain") {
    return plainLines.join("\n");
  }

  const profile = snapshot.profiles.codex;
  const online = authTableOnline(profile);
  const rows = [{
    profile: "Codex",
    account: accountLabel(profile),
    local: profile.valid ? "[OK] ready" : `[WARN] ${accountLabel(profile)}`,
    online: online.state,
    models: online.models,
  }];
  const table = formatResponsiveCliTable({
    columns: [
      { key: "profile", label: "PROFILE" },
      { key: "account", label: "ACCOUNT" },
      { key: "local", label: "LOCAL" },
      { key: "online", label: "ONLINE" },
      { key: "models", label: "MODELS", align: "right" },
    ],
    compactColumns: [
      { key: "profile", label: "PROFILE" },
      { key: "local", label: "LOCAL" },
      { key: "online", label: "ONLINE" },
    ],
    rows,
    width,
  });
  if (format === "auto" && table.overflow) {
    return plainLines.map((line) => terminalCell(line, { fallback: "" })).join("\n");
  }
  const lines = [`${commandName} auth status`, "", table.output];
  if (table.compact) {
    lines.push("", "Details:", ...plainLines.slice(1, -1).map((line) => terminalCell(line, { fallback: "" })));
  }
  lines.push(terminalCell(plainLines.at(-1), { fallback: "" }));
  return lines.join("\n");
}

export async function runAuthCommand({
  action = "status",
  online = false,
  commandName = "ccdx",
  format = "plain",
  output = process.stdout,
  ...options
} = {}) {
  if (action !== "status") throw new Error(`Unsupported auth action: ${action}`);
  const snapshot = online ? await authStatusOnline(options) : authStatus(options);
  return { action, output: formatAuthStatus(snapshot, { commandName, format, output }), snapshot };
}
