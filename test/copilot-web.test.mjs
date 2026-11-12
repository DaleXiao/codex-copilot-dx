import test from "node:test";
import assert from "node:assert/strict";
import { createCopilotWeb } from "../src/copilot-web.mjs";
import { copilotPagePermission } from "../src/copilot-web-fetch.mjs";
import { githubTokenFingerprint } from "../src/github-identity.mjs";

const credential = "fixture-github-token";
const client = { getCopilotToken: async () => "unused-fixture", getApiBase: () => "https://api.enterprise.githubcopilot.com" };
const searchResults = { search_result_groups: [{ search_result_type: "webResults", items: [
  { title: "Official docs", url: "https://docs.example.test/guide", snippets: ["A useful indexed excerpt."], last_updated_date: null },
  { title: "Other site", url: "https://other.example.test/page", snippets: ["Another result."] },
] }] };

test("Copilot page reader honors managed decisions and the requested origin", () => {
  const allowed = new Set(["https://docs.example.test"]);
  const request = { kind: "url", url: "https://docs.example.test/guide" };
  assert.equal(copilotPagePermission(request, allowed).kind, "approve-once");
  assert.equal(copilotPagePermission({ ...request, managedApprovalRequired: true }, allowed).kind, "reject");
  assert.equal(copilotPagePermission({ ...request, requestSandboxBypass: true }, allowed).kind, "reject");
  assert.equal(copilotPagePermission({ ...request, url: "https://other.example.test/" }, allowed).kind, "reject");
  assert.equal(copilotPagePermission({ kind: "shell", url: request.url }, allowed).kind, "reject");
});

test("Copilot search returns source references, preserves domain filters and scopes references to a session", async () => {
  const seen = [];
  const web = createCopilotWeb({ client, readToken: () => credential, query: async (value, options) => {
    seen.push({ value, host: options.endpoint.host });return searchResults;
  } });
  const body = { id: "session-a", model: "gemini-4-carbon", commands: { search_query: [
    { q: "find docs", domains: ["docs.example.test"], recency: 7 },
  ] } };
  const data = await (await web.search(body, { providerProfile: "codex:" + githubTokenFingerprint(credential) })).json();
  assert.equal(seen.length, 1);assert.equal(seen[0].host, "api.enterprise.githubcopilot.com");
  assert.match(seen[0].value, /docs\.example\.test/);
  assert.equal(data.results.length, 1);assert.equal(data.results[0].ref_id, "turn0search0");
  assert.match(data.output, /publication date not verified/);assert.match(data.output, /useful indexed excerpt/);
  const other = await (await web.search({ id: "session-b", commands: { open: [{ ref_id: "turn0search0" }] },
    settings: { external_web_access: false } })).json();
  assert.match(other.output, /Reference unavailable/);
  web.close();
});

test("cached-only Copilot pages use indexed excerpts and do not open the live site", async () => {
  let readers = 0;
  const web = createCopilotWeb({ client, readToken: () => credential, query: async () => searchResults,
    pageReader: async () => { readers += 1;throw new Error("must not open"); } });
  await web.search({ id: "a", commands: { search_query: [{ q: "docs" }] } });
  const data = await (await web.search({ id: "a", commands: { open: [{ ref_id: "turn0search0" }],
    find: [{ ref_id: "turn0search0", pattern: "missing" }] }, settings: { external_web_access: false } })).json();
  assert.equal(readers, 0);assert.match(data.output, /Cached Copilot search excerpt/);
  assert.match(data.output, /full page was not searched/);
});

test("live pages use Copilot reader and support opening, finding and following page links", async () => {
  const reads = [], opened = [], closed = [];
  const web = createCopilotWeb({ client, readToken: () => credential, query: async () => searchResults,
    pageReader: async ({ urls }) => {
      opened.push(urls);
      return { read: async href => { reads.push(href);return "Header\nThe target text\n[Next page](/next)\n"; },
        close: async () => { closed.push(true); } };
    } });
  await web.search({ id: "a", commands: { search_query: [{ q: "docs" }] } });
  const first = await (await web.search({ id: "a", commands: { open: [{ ref_id: "turn0search0" }] },
    settings: { external_web_access: true } })).json();
  assert.match(first.output, /L2: The target text/);assert.match(first.output, /Next page/);
  assert.equal(first.results[0].ref_id, "turn1view0");
  const second = await (await web.search({ id: "a", commands: { click: [{ ref_id: "turn1view0", id: 0 }],
    find: [{ ref_id: "turn1view0", pattern: "target" }] }, settings: { external_web_access: "live" } })).json();
  assert.match(second.output, /L2: The target text/);
  assert.deepEqual(reads, ["https://docs.example.test/guide", "https://docs.example.test/guide", "https://docs.example.test/next"]);
  assert.equal(opened.length, 2);assert.equal(closed.length, 2);
});

test("Copilot reports unsupported operations without pretending they succeeded", async () => {
  let queries = 0;
  const web = createCopilotWeb({ client, readToken: () => credential, query: async () => { queries += 1;return searchResults; } });
  const data = await (await web.search({ id: "a", commands: { image_query: [{ q: "mountains" }],
    screenshot: [{ ref_id: "x", pageno: 0 }] } })).json();
  assert.equal(queries, 0);assert.match(data.output, /does not support image_query/);
  assert.match(data.output, /does not support screenshot/);
});

test("Copilot rejects changed accounts, untrusted hosts and policies it cannot enforce", async () => {
  let requests = 0;
  const query = async () => { requests += 1;return searchResults; };
  const web = createCopilotWeb({ client, readToken: () => credential, query });
  const body = { id: "a", commands: { search_query: [{ q: "docs" }] } };
  await assert.rejects(() => web.search(body, { providerProfile: "codex:other" }), { code: "ccdx_copilot_search_account_changed" });
  await assert.rejects(() => web.search({ ...body, settings: { filters: { allowed_domains: ["example.test"] } } }),
    { code: "ccdx_copilot_search_policy" });
  await assert.rejects(() => web.search({ ...body, settings: { filters: { unknown: ["example.test"] } } }),
    { code: "ccdx_copilot_search_policy" });
  await assert.rejects(() => web.search({ ...body, settings: { external_web_access: "unknown" } }),
    { code: "ccdx_copilot_search_invalid" });
  const unsafe = createCopilotWeb({ client: { ...client, getApiBase: () => "https://example.test" }, readToken: () => credential, query });
  await assert.rejects(() => unsafe.search(body), { code: "ccdx_copilot_search_host" });
  assert.equal(requests, 0);
});

test("Copilot validates page operations before opening a page", async () => {
  let opened = 0;
  const web = createCopilotWeb({ client, readToken: () => credential,
    pageReader: async () => { opened += 1;throw new Error("must not open"); } });
  for (const commands of [
    { open: [{ ref_id: "https://example.test/", lineno: -1 }] },
    { click: [{ ref_id: "turn0view0", id: -1 }] },
    { find: [{ ref_id: "https://example.test/", pattern: "" }] },
    { open: { ref_id: "https://example.test/" } },
  ]) await assert.rejects(() => web.search({ id: "a", commands, settings: { external_web_access: true } }),
    { code: "ccdx_copilot_search_invalid" });
  assert.equal(opened, 0);
});

test("Copilot MCP uses one tool call, retains the session and forwards only the search query", async () => {
  const seen = [];
  const fetchImpl = async (target, options) => {
    const body = JSON.parse(options.body);seen.push({ target: String(target), headers: options.headers, body });
    if (body.method === "initialize") return Response.json({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-03-26" } },
      { headers: { "mcp-session-id": "fixture-session" } });
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    return new Response("event: message\ndata: " + JSON.stringify({ jsonrpc: "2.0", id: 2,
      result: { content: [{ type: "text", text: JSON.stringify(searchResults) }] } }) + "\n\n",
    { headers: { "content-type": "text/event-stream" } });
  };
  const web = createCopilotWeb({ client, readToken: () => credential, fetchImpl });
  const response = await web.search({ id: "a", model: "gemini-4-carbon", input: "private conversation",
    commands: { search_query: [{ q: "fixture query" }] } });
  const data = await response.json();
  assert.equal(data.results.length, 2);
  assert.deepEqual(seen.map(item => item.body.method), ["initialize", "notifications/initialized", "tools/call"]);
  assert.equal(seen[2].headers["Mcp-Session-Id"], "fixture-session");
  assert.equal(seen[2].body.params.name, "web_search");
  assert.equal(seen[2].body.params.arguments.query, "fixture query");
  assert.equal(JSON.stringify(seen.map(item => item.body)).includes("private conversation"), false);
  assert.equal(seen.every(item => item.target === "https://api.enterprise.githubcopilot.com/mcp/readonly"), true);
});

test("Copilot MCP exposes rate limits without repeating the request", async () => {
  let calls = 0;
  const web = createCopilotWeb({ client, readToken: () => credential, fetchImpl: async () => {
    calls += 1;return new Response(null, { status: 429, headers: { "retry-after": "5" } });
  } });
  await assert.rejects(() => web.search({ id: "a", commands: { search_query: [{ q: "fixture" }] } }),
    error => error.statusCode === 429 && error.retryAfter === "5");
  assert.equal(calls, 1);
});

test("Copilot page reader is closed when a page fetch fails", async () => {
  let closed = false;
  const web = createCopilotWeb({ client, readToken: () => credential,
    pageReader: async () => ({ read: async () => { throw new Error("fetch failed"); }, close: async () => { closed = true; } }) });
  await assert.rejects(() => web.search({ id: "a", commands: { open: [{ ref_id: "https://example.test/" }] },
    settings: { external_web_access: true } }), /fetch failed/);
  assert.equal(closed, true);
});
