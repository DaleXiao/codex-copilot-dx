import { terminalCell } from "./terminal-text.mjs";

const integer = value => Number.isSafeInteger(value) && value >= 0;
const appIds = { codex_app: "codex", codex_cli: "codex", codex: "codex", claude_app: "claude_app", claude_code: "claude_code" };
export const TERMINAL_CLIENT_NAMES = Object.freeze({ codex: "Codex", claude_app: "Claude App", claude_code: "Claude Code" });
const labels = { configured: "Configured", paused: "Paused", disabled: "Disabled", not_configured: "Not configured", not_installed: "Not installed",
  preserved: "Preserved", partially_preserved: "Partly preserved", manual_sync: "Manual sync", default_unavailable: "Default unavailable", configuration_unavailable: "Unreadable", unavailable: "Unavailable" };
export function terminalUptime(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return "unknown";
  const minutes = Math.floor(milliseconds / 60000), hours = Math.floor(minutes / 60), days = Math.floor(hours / 24);
  return days ? `${days}d ${hours % 24}h` : hours ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}
export function clientSetup(client = {}) {
  if (client.enabled === false) return "Disabled";
  if (client.enabled && (Array.isArray(client.deployments) ? !client.deployments.length : client.source === null)) return "Paused";
  return labels[client.setup] || "Not checked";
}
export function projectTerminalState(data = {}) {
  const routes = data.requests?.by_route, names = ["responses", "responses_compact", "messages"];
  const known = routes && names.every(name => integer(routes[name]?.active) && integer(routes[name]?.total));
  const partialRoutes = routes && names.some(name => routes[name]);
  const active = partialRoutes ? names.reduce((sum, name) => sum + (routes[name]?.active || 0), 0) : null;
  const requests = partialRoutes ? names.reduce((sum, name) => sum + (routes[name]?.total || 0), 0) : null;
  const claude = (data.providers?.claude || data.providers?.m365?.claude)?.requests?.performance;
  const performance = [data.stream_performance, claude].filter(Boolean);
  const outcomes = Object.fromEntries(["completed", "incomplete", "failed", "cancelled", "unknown"].map(key => [key,
    performance.flatMap(part => Object.entries(part.by_route || {}).filter(([route]) => part === claude ? route === "messages" : ["responses", "responses_compact"].includes(route)).map(([, row]) => row.terminal_outcomes?.totals || {}))
      .reduce((sum, row) => sum + (integer(row[key]) ? row[key] : 0), 0)]));
  const activity = Object.hasOwn(data.model_activity || {}, "active") ? integer(data.model_activity.active) ? data.model_activity.active : null : active;
  const running = [...new Map(performance.flatMap(part => (part.active_requests || []).filter(row => part === claude ? !row.route || row.route === "messages" : !row.route || ["responses", "responses_compact"].includes(row.route))).map((row, i) => [row.request_id || `unknown-${i}`, row])).values()];
  const byApp = new Map(), requestIds = new Set();let unidentified = 0;
  for (const row of running) {
    if (row.request_id && requestIds.has(row.request_id)) continue;
    if (row.request_id) requestIds.add(row.request_id);
    const app = appIds[row.application];if (app) byApp.set(app, (byApp.get(app) || 0) + 1);else unidentified++;
  }
  const connection = data.providers?.connections, clientRows = connection?.clients;
  const clients = (clientRows || [
    { id: "codex", setup: null },
    ...[["app", "claude_app"], ["code", "claude_code"]].map(([key, id]) => ({ id, setup: data.providers?.m365?.claude?.clients?.[key] })),
  ]).map(client => ({ id: client.id, name: TERMINAL_CLIENT_NAMES[client.id] || terminalCell(client.name || client.id),
    setup: clientSetup(client.id === "codex" && !connection?.managed && !client.setup && data.client_integrations?.codex?.setup ? { ...client, setup: data.client_integrations.codex.setup } : client), active: running.length || active === 0 ? byApp.get(client.id) || 0 : null, observed_at: client.observed_at || null }));
  if (integer(active) && active > running.length) unidentified += active - running.length;
  if (unidentified) clients.push({ id: "other", name: "Other clients", setup: "Not identified", active: unidentified });
  const sources = connection?.providers?.filter(item => item.enabled && !(item.id === "m365" && data.providers?.m365?.enabled === false)).map(item => ({ id: item.id, name: terminalCell(item.name || item.id) }))
    || (data.providers ? [{ id: "github", name: "GitHub Copilot" }, ...(data.providers.m365?.enabled ? [{ id: "m365", name: "Microsoft 365" }] : [])] : null);
  const lastFailure = data.http_errors?.actionable_recent?.at(-1);
  let issue = null;
  if (lastFailure) {
    const app = TERMINAL_CLIENT_NAMES[appIds[lastFailure.application]] || "Unidentified client";
    const source = connection?.providers?.find(item => item.id === lastFailure.provider)?.name || ({ github: "GitHub Copilot", m365: "Microsoft 365" }[lastFailure.provider]) || lastFailure.provider || "Unknown source";
    const causes = { m365_network_error: "Network request failed", m365_catalog_http_403: "Model catalog access denied", ccdx_api_model_unavailable: "Selected model is unavailable", ccdx_client_source_disabled: "Model access is paused" };
    const message = causes[lastFailure.code] || (lastFailure.route === "messages_count_tokens" ? "Token-count check failed" : lastFailure.http_status === 401 ? "Sign-in was rejected" : lastFailure.http_status === 403 ? "Access was denied" : lastFailure.http_status === 429 ? "Request limit reached" : "Request failed");
    issue = { label: `${terminalCell(app)} / ${terminalCell(source)}: ${message}`, request_id: lastFailure.request_id, application: lastFailure.application };
  }
  return { sources, clients, requests, active, activity, outcomes, issue, complete_activity: Boolean(known) };
}

export function retainedRequests(data = {}) {
  const claude = (data.providers?.claude || data.providers?.m365?.claude)?.requests?.performance;
  const parts = [data.stream_performance, claude].filter(Boolean), rows = new Map();
  for (const part of parts) {
    for (const record of part.recent_requests || []) if (record.request_id) rows.set(record.request_id, { ...record, state: record.outcome || record.terminal_outcome || "unknown", active: false });
    for (const record of part.active_requests || []) if (record.request_id) rows.set(record.request_id, { ...record, state: record.phase || "active", active: true });
  }
  for (const record of data.http_errors?.recent || data.http_errors?.actionable_recent || []) if (record.request_id) {
    const existing = rows.get(record.request_id);
    rows.set(record.request_id, { ...existing, ...record, error: true, active: existing?.active === true, state: ["cancelled", "incomplete"].includes(existing?.state) ? existing.state : "failed" });
  }
  const time = row => { const value = Date.parse(row.at || row.time || "");return Number.isFinite(value) ? value : 0; };
  return [...rows.values()].sort((a, b) => Number(a.active) - Number(b.active) || time(a) - time(b));
}
