import { authStatus, authStatusOnline } from "./auth-status.mjs";
import { status } from "./status.mjs";
import { createInterface } from "node:readline/promises";
import { createAccountTools } from "./account-tools.mjs";
import { terminalCell as safeCell } from "./terminal-text.mjs";
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
    status(snapshot.profiles.codex.valid ? "ok" : "warn", `Codex: ${accountLabel(snapshot.profiles.codex)} [${snapshot.profiles.codex.source === "ccdx" ? "CCDX store" : "legacy path"}]`),
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
      { key: "profile", label: "APP" },
      { key: "account", label: "ACCOUNT" },
      { key: "local", label: "SAVED SIGN-IN" },
      { key: "online", label: "ACCESS CHECK" },
      { key: "models", label: "MODELS", align: "right" },
    ],
    compactColumns: [
      { key: "profile", label: "APP" },
      { key: "local", label: "SAVED SIGN-IN" },
      { key: "online", label: "ACCESS CHECK" },
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
  if (["login", "reauth", "logout", "check"].includes(action)) {
    const tools = options.tools || createAccountTools(options);
    if (action === "check") {
      const checked = await tools.check(), snapshot = authStatus(options);
      snapshot.profiles.codex.online = checked.online ? { ...checked.online, httpStatus: checked.online.http_status } : null;
      return { action, output: formatAuthStatus(snapshot, { commandName, format, output }), snapshot };
    }
    if (action === "logout") {
      if (!options.yes) {
        const input = options.input || process.stdin;
        if (!input.isTTY || !output.isTTY) throw new Error("Use --yes to sign out of CCDX. Other apps stay signed in.");
        const prompt = createInterface({ input, output });
        try { if (!/^y(?:es)?$/i.test((await prompt.question("Sign out of CCDX? New requests will need a sign-in [y/N]: ")).trim())) return { action, output: "Sign-out cancelled." }; }
        finally { prompt.close(); }
      }
      await tools.logout({ confirmed: true });
      return { action, output: "Signed out of CCDX. Other apps stay signed in." };
    }
    const controller = new AbortController();
    let id;
    const cancel = () => { controller.abort();if (id) void tools.cancel(id);else tools.dispose(); };
    process.once("SIGINT", cancel);
    try {
      const started = await tools.start({ reauth: action === "reauth" || options.reauth === true, expectedLogin: options.expectedLogin });
      id = started.operation?.id;
      if (controller.signal.aborted && id) await tools.cancel(id);
      if (started.operation?.state === "authorizing") output.write(`Open ${started.operation.verification_uri}\nCode: ${started.operation.user_code}\nWaiting for GitHub. Ctrl+C cancels; saved sign-in is kept.\n`);
      const result = await tools.wait();
      if (result.operation?.state === "failed") throw new Error(`Sign-in failed: ${safeCell(result.operation.reason)}. Saved sign-in kept.`);
      return { action, output: result.operation?.state === "cancelled" ? "Sign-in cancelled. Saved sign-in kept."
        : result.operation?.state === "complete" ? "Signed in and verified. Use a new conversation; restart CCDX to change accounts."
          : "A sign-in is saved. Run ccdx auth check to verify it, or ccdx auth reauth to replace it." };
    } finally { process.removeListener("SIGINT", cancel);tools.dispose(); }
  }
  if (action !== "status") throw new Error(`Unsupported auth action: ${action}`);
  const snapshot = online ? await authStatusOnline(options) : authStatus(options);
  return { action, output: formatAuthStatus(snapshot, { commandName, format, output }), snapshot };
}
