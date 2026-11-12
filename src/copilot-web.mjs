import { readSavedGithubToken } from "./auth-credentials.mjs";
import { githubTokenFingerprint } from "./github-identity.mjs";
import { httpError, readBoundedResponseText } from "./http-transport.mjs";
import { localPackageVersion } from "./version.mjs";

const trustedHosts = new Set(["api.githubcopilot.com", "api.enterprise.githubcopilot.com"]);
const unsupported = ["image_query", "literature_search_query", "screenshot", "finance", "weather", "sports", "time"];

function failure(message, code = "ccdx_copilot_search_unavailable", statusCode = 502) {
  return Object.assign(httpError(message, statusCode), { code });
}

function url(value, base) {
  try {
    const parsed = new URL(value, base);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) return null;
    return parsed.href;
  } catch { return null; }
}

function domainMatch(host, domain) {
  return host === domain || host.endsWith("." + domain);
}

async function rpc(endpoint, headers, method, id, params, signal, session, fetchImpl) {
  const response = await fetchImpl(endpoint, { method: "POST", redirect: "error", signal,
    headers: { ...headers, ...(session ? { "Mcp-Session-Id": session } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", ...(id ? { id } : {}), method, params }) });
  const sessionId = response.headers.get("mcp-session-id");
  if (!response.ok) {
    await response.body?.cancel();
    const error = failure("GitHub Copilot search was refused (HTTP " + response.status + ")", "ccdx_copilot_search_http", response.status);
    const retryAfter = response.headers.get("retry-after");
    if (retryAfter && /^(?:\d{1,8}|[A-Za-z0-9,: ]{10,40})$/.test(retryAfter)) error.retryAfter = retryAfter;
    throw error;
  }
  const raw = await readBoundedResponseText(response, { maxBytes: 4 * 1024 * 1024, signal, label: "Copilot search" });
  if (!id) return { sessionId };
  let value;
  try { value = JSON.parse(raw); } catch {
    for (const line of raw.split(/\r?\n/)) if (line.startsWith("data:")) {
      try { const event = JSON.parse(line.slice(5).trim());if (event.id === id) value = event; } catch {}
    }
  }
  if (!value || value.error || value.id !== id) throw failure("GitHub Copilot returned an invalid search response");
  return { sessionId, value: value.result };
}

async function copilotQuery(query, { endpoint, credential, signal, fetchImpl }) {
  const headers = { Authorization: "Bearer " + credential, Accept: "application/json, text/event-stream",
    "Content-Type": "application/json", "X-MCP-Toolsets": "web_search" };
  const init = await rpc(endpoint, headers, "initialize", 1, {
    protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "ccdx", version: localPackageVersion() },
  }, signal, null, fetchImpl);
  await rpc(endpoint, headers, "notifications/initialized", null, {}, signal, init.sessionId, fetchImpl);
  const call = await rpc(endpoint, headers, "tools/call", 2, { name: "web_search", arguments: { query } }, signal, init.sessionId, fetchImpl);
  if (call.value?.isError) throw failure("GitHub Copilot web search failed");
  const texts = (call.value?.content || []).filter(item => item?.type === "text" && typeof item.text === "string");
  let data;
  for (const item of texts) {
    try { const parsed = JSON.parse(item.text);if (Array.isArray(parsed.search_result_groups)) { data = parsed;break; } } catch {}
  }
  if (!data) throw failure("GitHub Copilot returned an unrecognized search result");
  return data;
}

function referenceStore() {
  const sessions = new Map();
  return {
    session(id) {
      let state = sessions.get(id);
      if (!state) state = { next: 0, refs: new Map(), bytes: 0 };
      sessions.delete(id);sessions.set(id, state);
      if (sessions.size > 16) sessions.delete(sessions.keys().next().value);
      return state;
    },
    add(state, key, value) {
      const bytes = Buffer.byteLength(JSON.stringify(value));
      const previous = state.refs.get(key);if (previous) state.bytes -= previous.bytes;
      state.refs.delete(key);state.refs.set(key, { ...value, bytes });state.bytes += bytes;
      while (state.refs.size > 128 || state.bytes > 1024 * 1024) {
        const oldest = state.refs.keys().next().value;state.bytes -= state.refs.get(oldest).bytes;state.refs.delete(oldest);
      }
    },
    clear() { sessions.clear(); },
  };
}

function pageLinks(text, base) {
  const links = [];
  for (const match of text.matchAll(/\[([^\]\n]{1,200})\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const href = url(match[2], base);
    if (href && links.length < 150) links.push({ title: match[1], url: href });
  }
  return links;
}

export function createCopilotWeb({ client, query = copilotQuery, readToken = readSavedGithubToken, fetchImpl = fetch,
  pageReader = async options => (await import("./copilot-web-fetch.mjs")).createCopilotPageReader(options) } = {}) {
  const store = referenceStore();
  async function search(body, { signal, providerProfile } = {}) {
    if (typeof body.id !== "string" || !body.id || body.id.length > 160 || !body.commands || typeof body.commands !== "object"
      || Array.isArray(body.commands)) throw failure("Invalid Copilot search request", "ccdx_copilot_search_invalid", 400);
    const commands = body.commands, filters = body.settings?.filters, access = body.settings?.external_web_access;
    if (filters && (typeof filters !== "object" || Array.isArray(filters)
      || Object.keys(filters).some(key => !["allowed_domains", "blocked_domains"].includes(key))
      || Object.values(filters).some(value => !Array.isArray(value) || value.length))) {
      throw failure("Copilot search cannot enforce configured domain policy", "ccdx_copilot_search_policy", 400);
    }
    if (access !== undefined && ![true, false, "cached", "indexed", "live"].includes(access)) {
      throw failure("Unsupported web access mode", "ccdx_copilot_search_invalid", 400);
    }
    const queries = commands.search_query || [];
    if (!Array.isArray(queries) || queries.length > 4) throw failure("Copilot supports at most four search queries", "ccdx_copilot_search_invalid", 400);
    for (const name of ["open", "find", "click"]) if (commands[name] !== undefined && !Array.isArray(commands[name])) {
      throw failure("Invalid Copilot page request", "ccdx_copilot_search_invalid", 400);
    }
    const credential = readToken();
    if (!credential) throw failure("The GitHub Copilot sign-in is unavailable", "ccdx_copilot_search_auth", 401);
    if (providerProfile?.startsWith("codex:") && providerProfile !== "codex:" + githubTokenFingerprint(credential)) {
      throw failure("The GitHub sign-in changed; restart CCDX before searching", "ccdx_copilot_search_account_changed", 409);
    }
    await client.getCopilotToken({ signal });
    const base = new URL(client.getApiBase());
    if (base.protocol !== "https:" || !trustedHosts.has(base.hostname) || base.port || base.username || base.password) {
      throw failure("The Copilot search host is not supported", "ccdx_copilot_search_host", 503);
    }
    const endpoint = new URL("/mcp/readonly", base);
    const state = store.session(body.id), turn = state.next++, output = [], results = [];
    let refIndex = 0;
    for (const item of queries) {
      if (!item || typeof item.q !== "string" || !item.q.trim() || item.q.length > 4096
        || item.domains !== undefined && (!Array.isArray(item.domains) || item.domains.some(d => typeof d !== "string" || !/^[a-z0-9.-]+$/i.test(d)))
        || item.recency !== undefined && (!Number.isSafeInteger(item.recency) || item.recency < 1)) {
        throw failure("Invalid Copilot search query", "ccdx_copilot_search_invalid", 400);
      }
      const domains = (item.domains || []).map(value => value.toLowerCase().replace(/^\.+|\.+$/g, ""));
      const constraints = [domains.length ? "Limit results to these domains: " + domains.join(", ") + "." : "",
        item.recency ? "Prefer sources from the past " + item.recency + " days." : ""].filter(Boolean).join(" ");
      const data = await query(item.q + (constraints ? "\n" + constraints : ""), { endpoint, credential, signal, fetchImpl });
      output.push("GitHub Copilot search: " + item.q);
      let count = 0;
      for (const group of data.search_result_groups || []) {
        for (const result of group.items || []) {
          const href = url(result?.url);if (!href) continue;
          const host = new URL(href).hostname.toLowerCase();
          if (domains.length && !domains.some(domain => domainMatch(host, domain))) continue;
          const updated = Date.parse(result.last_updated_date);
          if (item.recency && Number.isFinite(updated) && updated < Date.now() - item.recency * 86400000) continue;
          const title = typeof result.title === "string" ? result.title.slice(0, 400) : href;
          const snippets = (Array.isArray(result.snippets) ? result.snippets : []).filter(value => typeof value === "string").join("\n").slice(0, 2500);
          const ref = "turn" + turn + "search" + refIndex++;
          store.add(state, ref, { url: href, snippets });
          const dateNote = item.recency ? Number.isFinite(updated)
            ? " [last updated " + new Date(updated).toISOString().slice(0, 10) + "; publication date not verified]"
            : " [publication date not verified]" : "";
          output.push(title + " (" + href + ")\n【" + ref + "】" + dateNote
            + (snippets ? "\n" + snippets : ""));
          results.push({ type: "text_result", ref_id: ref, url: href, title });count++;
          if (count >= 10) break;
        }
        if (count >= 10) break;
      }
      if (!count) output.push("No matching Copilot search results.");
    }
    const pending = [];
    for (const operation of commands.open || []) pending.push({ type: "open", operation });
    for (const operation of commands.find || []) pending.push({ type: "find", operation });
    for (const operation of commands.click || []) pending.push({ type: "click", operation });
    if (pending.length > 8) throw failure("Copilot supports at most eight page operations", "ccdx_copilot_search_invalid", 400);
    const pages = [];
    for (const entry of pending) {
      const op = entry.operation;
      if (!op || typeof op.ref_id !== "string") throw failure("Invalid Copilot page request", "ccdx_copilot_search_invalid", 400);
      if (entry.type === "open" && op.lineno !== undefined && (!Number.isSafeInteger(op.lineno) || op.lineno < 0)
        || entry.type === "click" && (!Number.isSafeInteger(op.id) || op.id < 0)) {
        throw failure("Invalid Copilot page request", "ccdx_copilot_search_invalid", 400);
      }
      const stored = state.refs.get(op.ref_id);
      let href = stored?.url || url(op.ref_id);
      if (entry.type === "click") href = stored?.links?.[op.id]?.url || null;
      if (!href) { output.push("Reference unavailable: " + op.ref_id);continue; }
      if (entry.type === "find" && (typeof op.pattern !== "string" || !op.pattern)) throw failure("Invalid page search pattern", "ccdx_copilot_search_invalid", 400);
      pages.push({ ...entry, href, stored });
    }
    const cachedOnly = access !== true && access !== "live";
    if (pages.length && cachedOnly) {
      for (const page of pages) {
        const snippet = page.stored?.snippets;
        if (!snippet) { output.push("Live page reading is unavailable in cached-only mode: " + page.href);continue; }
        const match = page.type === "find" ? snippet.toLowerCase().includes(page.operation.pattern.toLowerCase()) : null;
        output.push("Cached Copilot search excerpt (" + page.href + "):"
          + (match === null ? "" : match ? " Pattern found in excerpt." : " Pattern not found in excerpt; the full page was not searched.")
          + "\n" + snippet);
      }
    } else if (pages.length) {
      const reader = await pageReader({ credential, urls: pages.map(page => page.href), signal });
      try {
        for (const page of pages) {
          const text = await reader.read(page.href);
          const ref = "turn" + turn + "view" + refIndex++, links = pageLinks(text, page.href);
          store.add(state, ref, { url: page.href, links });
          const lines = text.split("\n");
          if (page.type === "find") {
            const at = lines.findIndex(line => line.toLowerCase().includes(page.operation.pattern.toLowerCase()));
            output.push(at < 0 ? "Pattern not found in the retrieved page excerpt: " + page.href
              : page.href + "\n【" + ref + "】\n" + lines.slice(Math.max(0, at - 2), at + 3).map((line, i) => "L" + (Math.max(0, at - 2) + i + 1) + ": " + line).join("\n"));
          } else {
            const start = Number.isSafeInteger(page.operation.lineno) ? Math.max(0, page.operation.lineno - 1) : 0;
            output.push(page.href + "\n【" + ref + "】\n"
              + (start >= lines.length ? "Requested line is outside the retrieved page excerpt." : lines.slice(start, start + 200).map((line, i) => "L" + (start + i + 1) + ": " + line).join("\n"))
              + (links.length ? "\nLinks:\n" + links.map((link, index) => "【" + index + "†" + link.title + "】 " + link.url).join("\n") : ""));
          }
          results.push({ type: "text_result", ref_id: ref, url: page.href, title: page.href });
        }
      } finally { await reader.close(); }
    }
    for (const name of unsupported) if (Array.isArray(commands[name]) && commands[name].length) {
      output.push("Copilot search does not support " + name + " in this preview.");
    }
    if (!output.length) output.push("No supported Copilot search operation was requested.");
    return Response.json({ output: output.join("\n\n"), results });
  }
  return { search, close: () => store.clear() };
}
