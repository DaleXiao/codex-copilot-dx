import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import http from "node:http";
import { Readable } from "node:stream";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  createPmStudioRelayHandler,
  PM_STUDIO_RELAY_PREFIX,
} from "../src/pm-studio-relay.mjs";
import { createCopilotClient } from "../src/copilot.mjs";

const ENTERPRISE_TOKEN = "tid=fake-enterprise;exp=4102444800;sig=enterprise-bearer-secret";

function enterpriseCatalog(models = [{ id: "gpt-enterprise", vendor: "OpenAI" }], extra = {}) {
  return { object: "list", data: models, ...extra };
}

function claudeModel(id = "claude-personal") {
  return {
    id,
    name: "Claude Personal",
    vendor: "Anthropic",
    model_picker_enabled: true,
    supported_endpoints: ["/chat/completions"],
    capabilities: { family: "claude" },
  };
}

function request(server, pathname, {
  method = "GET",
  token = ENTERPRISE_TOKEN,
  headers = {},
  body,
} = {}) {
  const address = server.address();
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port: address.port,
      path: pathname,
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks),
      }));
      res.on("error", reject);
    });
    req.on("error", reject);
    if (body !== undefined) req.end(typeof body === "string" ? body : JSON.stringify(body));
    else req.end();
  });
}

async function withRelay(options, run) {
  const handler = createPmStudioRelayHandler(options);
  const server = http.createServer((req, res) => {
    handler(req, res).catch((error) => {
      if (!res.headersSent) res.writeHead(500);
      res.end(error.message);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    return await run(server, handler);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function successfulCatalogResponse(models, extra) {
  return Response.json(enterpriseCatalog(models, extra), {
    headers: { "X-GitHub-Request-Id": "models-request" },
  });
}

function isolatedOptions(overrides = {}) {
  return {
    claudeMode: "isolated",
    claudeProfile: { valid: true },
    claudeModelRegistry: { models: enterpriseCatalog([claudeModel()]) },
    claudeClient: {
      async chatCompletions() {
        return Response.json({ id: "claude-response" });
      },
    },
    ...overrides,
  };
}

test("PM relay requires real loopback and a bearer Authorization header", async () => {
  let upstreamCalls = 0;
  await withRelay({
    fetchImpl: async () => {
      upstreamCalls += 1;
      return successfulCatalogResponse();
    },
  }, async (server, handler) => {
    const missing = await request(server, `${PM_STUDIO_RELAY_PREFIX}/models`, { token: "" });
    assert.equal(missing.status, 401);
    assert.equal(missing.headers["www-authenticate"], "Bearer");
    assert.equal(upstreamCalls, 0);

    const success = await request(server, `${PM_STUDIO_RELAY_PREFIX}/models`);
    assert.equal(success.status, 200);
    assert.equal(upstreamCalls, 1);

    const req = { url: `${PM_STUDIO_RELAY_PREFIX}/models`, method: "GET", headers: { authorization: "Bearer x" }, socket: { remoteAddress: "192.0.2.10" } };
    const res = new FakeResponse();
    assert.equal(await handler(req, res), true);
    assert.equal(res.statusCode, 403);
  });
});

test("PM relay exposes only the explicit path and method matrix and rejects upgrades locally", async () => {
  let upstreamCalls = 0;
  await withRelay({
    fetchImpl: async () => {
      upstreamCalls += 1;
      return successfulCatalogResponse();
    },
  }, async (server) => {
    const unknown = await request(server, `${PM_STUDIO_RELAY_PREFIX}/arbitrary`);
    assert.equal(unknown.status, 404);
    assert.equal(JSON.parse(unknown.body).error.code, "route_not_found");

    const wrongModelsMethod = await request(server, `${PM_STUDIO_RELAY_PREFIX}/models`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: {},
    });
    assert.equal(wrongModelsMethod.status, 405);
    assert.equal(wrongModelsMethod.headers.allow, "GET");

    const wrongChatMethod = await request(server, `${PM_STUDIO_RELAY_PREFIX}/chat/completions`);
    assert.equal(wrongChatMethod.status, 405);
    assert.equal(wrongChatMethod.headers.allow, "POST");

    const upgrade = await request(server, `${PM_STUDIO_RELAY_PREFIX}/models`, {
      headers: { Connection: "Upgrade", Upgrade: "websocket" },
    });
    assert.equal(upgrade.status, 426);
    assert.equal(JSON.parse(upgrade.body).error.code, "upgrade_not_supported");
    assert.equal(upstreamCalls, 0);
  });
});

test("GET /models validates once, preserves enterprise schema and appends only eligible isolated Claude models", async () => {
  const calls = [];
  const duplicate = claudeModel("claude-duplicate");
  const added = claudeModel("claude-added");
  const pickerDefault = { ...claudeModel("claude-picker-default") };
  delete pickerDefault.model_picker_enabled;
  const disabled = { ...claudeModel("claude-disabled"), model_picker_enabled: false };
  const wrongVendor = { ...claudeModel("claude-wrong-vendor"), vendor: "OpenAI" };
  const wrongEndpoint = { ...claudeModel("claude-wrong-endpoint"), supported_endpoints: ["/responses"] };
  const enterpriseModels = [{ id: "gpt-enterprise", custom: 1 }, { ...duplicate, source: "enterprise" }];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return successfulCatalogResponse(enterpriseModels, { custom_root: { kept: true } });
  };

  await withRelay(isolatedOptions({
    fetchImpl,
    claudeModelRegistry: { models: enterpriseCatalog([duplicate, added, pickerDefault, disabled, wrongVendor, wrongEndpoint]) },
  }), async (server) => {
    const result = await request(server, `${PM_STUDIO_RELAY_PREFIX}/models`, {
      headers: { Connection: "close" },
    });
    assert.equal(result.status, 200);
    assert.equal(calls.length, 1, "the validation GET must also serve the first /models response");
    assert.equal(calls[0].url, "https://api.githubcopilot.com/models");
    assert.equal(calls[0].init.redirect, "manual");
    assert.equal(calls[0].init.headers.get("authorization"), `Bearer ${ENTERPRISE_TOKEN}`);
    assert.equal(calls[0].init.headers.get("accept"), "application/json");
    assert.equal(calls[0].init.headers.has("connection"), false);

    const catalog = JSON.parse(result.body);
    assert.deepEqual(catalog.custom_root, { kept: true });
    assert.deepEqual(catalog.data.map((model) => model.id), ["gpt-enterprise", "claude-duplicate", "claude-added", "claude-picker-default"]);
    assert.equal(catalog.data[1].source, "enterprise", "enterprise duplicate wins without mutation");
    assert.deepEqual(catalog.data[2], added, "the original Claude catalog entry is appended unchanged");
  });
});

test("GET /models is pure enterprise without a valid isolated profile and preserves enterprise errors", async () => {
  const raw = JSON.stringify(enterpriseCatalog([{ id: "gpt-only" }], { untouched: true }));
  let invalidProfileCalls = 0;
  await withRelay({
    claudeMode: "isolated",
    claudeProfile: { valid: false },
    claudeModelRegistry: { models: enterpriseCatalog([
      claudeModel(),
      claudeModel("anthropic-special"),
    ]) },
    fetchImpl: async () => {
      invalidProfileCalls += 1;
      return new Response(raw, { headers: { "Content-Type": "application/json" } });
    },
  }, async (server) => {
    const result = await request(server, `${PM_STUDIO_RELAY_PREFIX}/models`);
    assert.equal(result.body.toString(), raw);

    const rejected = await request(server, `${PM_STUDIO_RELAY_PREFIX}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: { model: "anthropic-special", messages: [] },
    });
    assert.equal(rejected.status, 400);
    assert.equal(JSON.parse(rejected.body).error.code, "model_not_supported");
    assert.equal(invalidProfileCalls, 1, "a known Claude model cannot fall through to enterprise POST");
  });

  const upstreamError = "enterprise authorization rejected verbatim";
  await withRelay({
    fetchImpl: async () => new Response(upstreamError, {
      status: 401,
      headers: { "Content-Type": "text/plain", "X-GitHub-Request-Id": "auth-request" },
    }),
  }, async (server) => {
    const result = await request(server, `${PM_STUDIO_RELAY_PREFIX}/models`);
    assert.equal(result.status, 401);
    assert.equal(result.body.toString(), upstreamError);
    assert.equal(result.headers["x-upstream-request-id"], "auth-request");
  });
});

test("enterprise POST routes use only the inbound bearer, fixed origin and sanitized headers", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = typeof init.body === "string" ? init.body : "";
    calls.push({ url, init, body });
    if (url.endsWith("/models")) return successfulCatalogResponse();
    return new Response(JSON.stringify({ ok: true, path: new URL(url).pathname }), {
      headers: {
        "Content-Type": "application/json",
        "Set-Cookie": "must-not-leak=1",
        Connection: "close",
        "X-GitHub-Request-Id": "post-request",
      },
    });
  };

  await withRelay({ fetchImpl }, async (server) => {
    const payload = { model: "gpt-enterprise", input: "hello", stream: false };
    const result = await request(server, `${PM_STUDIO_RELAY_PREFIX}/responses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Connection: "x-remove",
        "X-Remove": "hop-by-hop",
        "X-PM-Metadata": "kept",
      },
      body: payload,
    });
    assert.equal(result.status, 200);
    assert.equal(result.headers["set-cookie"], undefined);
    assert.equal(result.headers["x-upstream-request-id"], "post-request");
    assert.equal(calls.length, 2);
    assert.deepEqual(calls.map((call) => call.url), [
      "https://api.githubcopilot.com/models",
      "https://api.githubcopilot.com/responses",
    ]);
    const forwarded = calls[1];
    assert.equal(forwarded.init.redirect, "manual");
    assert.equal(forwarded.init.headers.get("authorization"), `Bearer ${ENTERPRISE_TOKEN}`);
    assert.equal(forwarded.init.headers.get("x-pm-metadata"), "kept");
    assert.equal(forwarded.init.headers.has("connection"), false);
    assert.equal(forwarded.init.headers.has("x-remove"), false);
    assert.equal(forwarded.init.headers.get("content-length"), String(Buffer.byteLength(forwarded.body)));
    assert.deepEqual(JSON.parse(forwarded.body), payload);

    const embedding = await request(server, `${PM_STUDIO_RELAY_PREFIX}/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: { model: "embedding-enterprise", input: "hello" },
    });
    assert.equal(embedding.status, 200);
    assert.equal(calls.length, 3, "a cached fingerprint avoids a second validation request");
    assert.equal(calls[2].url, "https://api.githubcopilot.com/embeddings");
  });
});

test("eligible Claude chat uses the isolated client and never forwards inbound Authorization", async () => {
  const enterpriseCalls = [];
  const claudeCalls = [];
  const fetchImpl = async (url, init) => {
    enterpriseCalls.push({ url, init });
    if (url.endsWith("/models")) return successfulCatalogResponse();
    return Response.json({ id: "isolated-claude" });
  };
  const claudeClient = {
    async chatCompletions(body, callOptions) {
      claudeCalls.push({ body, callOptions });
      return callOptions.fetchImpl("https://api.githubcopilot.com/chat/completions", {
        method: "POST",
        headers: { Authorization: "Bearer isolated-claude-secret" },
        body: JSON.stringify(body),
        signal: callOptions.signal,
        redirect: "follow",
      });
    },
  };
  const registry = enterpriseCatalog([
    claudeModel("claude-allowed"),
    { ...claudeModel("claude-disabled"), model_picker_enabled: false },
  ]);

  await withRelay(isolatedOptions({
    fetchImpl,
    claudeClient,
    claudeModelRegistry: { models: registry },
  }), async (server) => {
    const result = await request(server, `${PM_STUDIO_RELAY_PREFIX}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: { model: "claude-allowed", messages: [{ role: "user", content: "hello" }] },
    });
    assert.equal(result.status, 200);
    assert.equal(enterpriseCalls.length, 2);
    assert.equal(enterpriseCalls[0].url, "https://api.githubcopilot.com/models");
    assert.equal(enterpriseCalls[1].url, "https://api.githubcopilot.com/chat/completions");
    assert.equal(enterpriseCalls[1].init.headers.Authorization, "Bearer isolated-claude-secret");
    assert.notEqual(enterpriseCalls[1].init.headers.Authorization, `Bearer ${ENTERPRISE_TOKEN}`);
    assert.equal(enterpriseCalls[1].init.redirect, "manual");
    assert.equal(claudeCalls.length, 1);
    assert.equal(claudeCalls[0].body.model, "claude-allowed");
    assert.equal(JSON.stringify(claudeCalls[0]).includes(ENTERPRISE_TOKEN), false);
    assert.ok(claudeCalls[0].callOptions.signal instanceof AbortSignal);

    for (const [path, model] of [
      ["/chat/completions", "claude-unknown"],
      ["/chat/completions", "claude-disabled"],
      ["/responses", "claude-allowed"],
      ["/embeddings", "claude-allowed"],
    ]) {
      const rejected = await request(server, `${PM_STUDIO_RELAY_PREFIX}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: { model },
      });
      assert.equal(rejected.status, 400, `${path} ${model}`);
      assert.equal(JSON.parse(rejected.body).error.code, "model_not_supported");
    }
    assert.equal(enterpriseCalls.length, 2, "Claude-like IDs must never fall back to enterprise POST");
    assert.equal(claudeCalls.length, 1);
  });
});

test("isolated Claude client cannot redirect the relay to another upstream origin", async () => {
  const urls = [];
  const trustedBase = "https://trusted.example/copilot/v2";
  await withRelay(isolatedOptions({
    fetchImpl: async (url) => {
      urls.push(url);
      return successfulCatalogResponse();
    },
    claudeClient: {
      getApiBase: () => trustedBase,
      async chatCompletions(body, callOptions) {
        return callOptions.fetchImpl(body.targetUrl, {
          method: "POST",
          headers: { Authorization: "Bearer isolated-secret" },
          body: JSON.stringify(body),
        });
      },
    },
  }), async (server) => {
    for (const targetUrl of [
      "https://example.invalid/chat/completions",
      `${trustedBase}/wrong-path`,
      `${trustedBase}/chat/completions?redirect=1`,
      "https://trusted.example/chat/completions",
    ]) {
      const result = await request(server, `${PM_STUDIO_RELAY_PREFIX}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: { model: "claude-personal", messages: [], targetUrl },
      });
      assert.equal(result.status, 502);
      assert.equal(JSON.parse(result.body).error.code, "invalid_upstream");
    }
    assert.deepEqual(urls, ["https://api.githubcopilot.com/models"]);
  });
});

test("enterprise and Claude upstream redirects are rejected instead of relayed to PM Studio", async () => {
  await withRelay({
    fetchImpl: async () => new Response(null, {
      status: 307,
      headers: { Location: "https://example.invalid/collect" },
    }),
  }, async (server) => {
    const result = await request(server, `${PM_STUDIO_RELAY_PREFIX}/models`);
    assert.equal(result.status, 502);
    assert.equal(JSON.parse(result.body).error.code, "upstream_redirect");
    assert.equal(result.headers.location, undefined);
  });

  await withRelay(isolatedOptions({
    fetchImpl: async (url) => url.endsWith("/models")
      ? successfulCatalogResponse()
      : new Response(null, {
        status: 302,
        headers: { Location: "https://example.invalid/collect" },
      }),
    claudeClient: {
      getApiBase: () => "https://regional.example/copilot",
      async chatCompletions(body, callOptions) {
        return callOptions.fetchImpl("https://regional.example/copilot/chat/completions", {
          method: "POST",
          headers: { Authorization: "Bearer isolated-secret" },
          body: JSON.stringify(body),
          signal: callOptions.signal,
        });
      },
    },
  }), async (server) => {
    const result = await request(server, `${PM_STUDIO_RELAY_PREFIX}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: { model: "claude-personal", messages: [] },
    });
    assert.equal(result.status, 502);
    assert.equal(JSON.parse(result.body).error.code, "upstream_redirect");
    assert.equal(result.headers.location, undefined);
  });
});

test("isolated Claude follows only the API base trusted by its Copilot token session", async () => {
  const urls = [];
  const apiBase = "https://personal.enterprise.example/copilot";
  const claudeClient = {
    getApiBase: () => apiBase,
    async chatCompletions(body, callOptions) {
      return callOptions.fetchImpl(`${apiBase}/chat/completions`, {
        method: "POST",
        headers: { Authorization: "Bearer isolated-secret" },
        body: JSON.stringify(body),
      });
    },
  };
  await withRelay(isolatedOptions({
    claudeClient,
    fetchImpl: async (url) => {
      urls.push(url);
      if (url.endsWith("/models")) return successfulCatalogResponse();
      return Response.json({ id: "regional-claude" });
    },
  }), async (server) => {
    const result = await request(server, `${PM_STUDIO_RELAY_PREFIX}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: { model: "claude-personal", messages: [] },
    });
    assert.equal(result.status, 200);
    assert.deepEqual(urls, [
      "https://api.githubcopilot.com/models",
      `${apiBase}/chat/completions`,
    ]);
  });
});

test("PM relay follows the regional path selected by the real isolated Copilot client", async () => {
  const apiBase = "https://regional.enterprise.example/copilot/v2";
  let tokenRefreshes = 0;
  const claudeClient = createCopilotClient({
    profile: "claude",
    allowTokenDiscovery: false,
    readGithubCredentials: async () => ({
      valid: true,
      token: "github-personal-test-token",
      identity: { login: "personal-user", id: 123 },
    }),
    tokenFetchImpl: async (url, init) => {
      assert.equal(String(url), "https://api.github.com/copilot_internal/v2/token");
      assert.equal(new Headers(init.headers).get("authorization"), "token github-personal-test-token");
      tokenRefreshes += 1;
      return Response.json({
        token: "regional-service-token",
        expires_at: Math.floor(Date.now() / 1000) + 1800,
        endpoints: { api: apiBase },
      });
    },
  });
  const calls = [];
  await withRelay(isolatedOptions({
    claudeClient,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), authorization: new Headers(init.headers).get("authorization") });
      if (String(url) === "https://api.githubcopilot.com/models") return successfulCatalogResponse();
      assert.equal(String(url), `${apiBase}/chat/completions`);
      return Response.json({ choices: [{ message: { role: "assistant", content: "regional ok" } }] });
    },
  }), async (server) => {
    const result = await request(server, `${PM_STUDIO_RELAY_PREFIX}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: { model: "claude-personal", messages: [{ role: "user", content: "hello" }] },
    });
    assert.equal(result.status, 200);
    assert.equal(tokenRefreshes, 1);
    assert.equal(claudeClient.getApiBase(), apiBase);
    assert.deepEqual(calls, [
      { url: "https://api.githubcopilot.com/models", authorization: `Bearer ${ENTERPRISE_TOKEN}` },
      { url: `${apiBase}/chat/completions`, authorization: "Bearer regional-service-token" },
    ]);
  });
});

test("bearer validation bounds concurrent model requests from distinct untrusted tokens", async () => {
  let active = 0;
  let maximum = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  await withRelay({
    validationConcurrency: 2,
    validationMaxFlights: 3,
    fetchImpl: async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await gate;
      active -= 1;
      return successfulCatalogResponse();
    },
  }, async (server) => {
    const pending = Array.from({ length: 10 }, (_, index) => request(
      server, `${PM_STUDIO_RELAY_PREFIX}/models`, { token: `random-token-${index}` },
    ));
    await delay(20);
    release();
    const results = await Promise.all(pending);
    assert.equal(maximum, 2);
    assert.equal(results.filter(({ status }) => status === 200).length, 2);
    assert.equal(results.filter(({ status }) => status === 503).length, 8);
    assert.equal(results.every(({ body }) => !body.includes("random-token-")), true);
  });
});

test("bearer validation bounds outstanding distinct-token flights before upstream work", async () => {
  let active = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  await withRelay({
    validationConcurrency: 8,
    validationMaxFlights: 2,
    fetchImpl: async () => {
      active += 1;
      await gate;
      active -= 1;
      return successfulCatalogResponse();
    },
  }, async (server) => {
    const pending = Array.from({ length: 6 }, (_, index) => request(
      server, `${PM_STUDIO_RELAY_PREFIX}/models`, { token: `flight-token-${index}` },
    ));
    await delay(20);
    assert.equal(active, 2);
    release();
    const results = await Promise.all(pending);
    assert.equal(results.filter(({ status }) => status === 200).length, 2);
    assert.equal(results.filter(({ status }) => status === 503).length, 4);
  });
});

test("bearer validation bounds same-token waiters without amplifying upstream requests", async () => {
  let validations = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  await withRelay({
    validationMaxWaiters: 2,
    fetchImpl: async () => {
      validations += 1;
      await gate;
      return successfulCatalogResponse();
    },
  }, async (server) => {
    const pending = Array.from({ length: 6 }, () => request(
      server, `${PM_STUDIO_RELAY_PREFIX}/models`, { token: "shared-pending-token" },
    ));
    await delay(20);
    assert.equal(validations, 1);
    release();
    const results = await Promise.all(pending);
    assert.equal(results.filter(({ status }) => status === 200).length, 2);
    assert.equal(results.filter(({ status }) => status === 503).length, 4);
    assert.equal(validations, 1);
  });
});

test("bearer validation is singleflight and its TTL never exceeds a parseable token exp", async () => {
  let now = 1_000_000;
  const token = `x.${Buffer.from(JSON.stringify({ exp: 1001 })).toString("base64url")}.y`;
  let validations = 0;
  let posts = 0;
  let unblock;
  const gate = new Promise((resolve) => { unblock = resolve; });
  const fetchImpl = async (url) => {
    if (url.endsWith("/models")) {
      validations += 1;
      if (validations === 1) await gate;
      return successfulCatalogResponse();
    }
    posts += 1;
    return Response.json({ ok: true });
  };

  await withRelay({ fetchImpl, now: () => now, validationTtlMs: 60_000 }, async (server) => {
    const send = () => request(server, `${PM_STUDIO_RELAY_PREFIX}/embeddings`, {
      method: "POST",
      token,
      headers: { "Content-Type": "application/json" },
      body: { model: "embedding-enterprise", input: "x" },
    });
    const first = send();
    const second = send();
    await delay(20);
    assert.equal(validations, 1);
    unblock();
    assert.deepEqual((await Promise.all([first, second])).map((item) => item.status), [200, 200]);
    assert.equal(posts, 2);

    assert.equal((await send()).status, 200);
    assert.equal(validations, 1);
    now = 1_001_001;
    assert.equal((await send()).status, 200);
    assert.equal(validations, 2, "the validation cache expires at token exp before the configured TTL");
  });
});

test("bearer validation does not cache a token whose expiry cannot be established", async () => {
  let validations = 0;
  let posts = 0;
  const fetchImpl = async (url) => {
    if (url.endsWith("/models")) {
      validations += 1;
      return successfulCatalogResponse();
    }
    posts += 1;
    return Response.json({ ok: true });
  };

  await withRelay({ fetchImpl, validationTtlMs: 60_000 }, async (server) => {
    const send = () => request(server, `${PM_STUDIO_RELAY_PREFIX}/embeddings`, {
      method: "POST",
      token: "opaque-token-without-expiry",
      headers: { "Content-Type": "application/json" },
      body: { model: "embedding-enterprise", input: "x" },
    });
    assert.equal((await send()).status, 200);
    assert.equal((await send()).status, 200);
    assert.equal(validations, 2);
    assert.equal(posts, 2);
  });
});

test("streaming preserves bytes and backpressure through writeOrDrain", async () => {
  const encoder = new TextEncoder();
  const fetchImpl = async (url) => {
    if (url.endsWith("/models")) return successfulCatalogResponse();
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode("data: first\n\n"));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    }), { headers: { "Content-Type": "text/event-stream", "X-GitHub-Request-Id": "stream-request" } });
  };
  const handler = createPmStudioRelayHandler({ fetchImpl });
  const body = JSON.stringify({ model: "gpt-enterprise", messages: [], stream: true });
  const req = Readable.from([Buffer.from(body)]);
  req.url = `${PM_STUDIO_RELAY_PREFIX}/chat/completions`;
  req.method = "POST";
  req.headers = {
    authorization: `Bearer ${ENTERPRISE_TOKEN}`,
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(body)),
  };
  req.socket = { remoteAddress: "127.0.0.1" };
  const res = new FakeResponse({ backpressure: true });
  const pending = handler(req, res);
  await res.waitForWrite();
  assert.equal(res.writableEnded, false);
  res.emit("drain");
  await pending;
  assert.equal(res.statusCode, 200);
  assert.equal(Buffer.concat(res.chunks).toString(), "data: first\n\ndata: [DONE]\n\n");
});

test("handshake timeout and upstream failures are sanitized without leaking bearer tokens", async () => {
  let actualCalls = 0;
  const fetchImpl = async (url, init) => {
    if (url.endsWith("/models")) return successfulCatalogResponse();
    actualCalls += 1;
    return new Promise((resolve, reject) => {
      init.signal.addEventListener("abort", () => {
        const error = new Error(`secret must not leak: ${ENTERPRISE_TOKEN}`);
        error.name = "AbortError";
        reject(error);
      }, { once: true });
    });
  };
  await withRelay({ fetchImpl, streamHandshakeTimeoutMs: 20 }, async (server) => {
    const result = await request(server, `${PM_STUDIO_RELAY_PREFIX}/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: { model: "gpt-enterprise", input: "x", stream: true },
    });
    assert.equal(actualCalls, 1);
    assert.equal(result.status, 504);
    assert.equal(result.body.includes(ENTERPRISE_TOKEN), false);
    assert.equal(JSON.parse(result.body).error.code, "upstream_timeout");
  });

  await withRelay({
    fetchImpl: async () => { throw new Error(`fetch exploded with ${ENTERPRISE_TOKEN}`); },
  }, async (server) => {
    const result = await request(server, `${PM_STUDIO_RELAY_PREFIX}/models`);
    assert.equal(result.status, 502);
    assert.equal(result.body.includes(ENTERPRISE_TOKEN), false);
  });
});

test("stream idle timeout aborts upstream and terminates the downstream stream", async () => {
  let upstreamAborted = false;
  const encoder = new TextEncoder();
  const fetchImpl = async (url, init) => {
    if (url.endsWith("/models")) return successfulCatalogResponse();
    let controller;
    const stream = new ReadableStream({
      start(value) {
        controller = value;
        value.enqueue(encoder.encode("data: first\n\n"));
      },
    });
    init.signal.addEventListener("abort", () => {
      upstreamAborted = true;
      const error = new Error("idle timeout");
      error.name = "AbortError";
      controller.error(error);
    }, { once: true });
    return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
  };

  await withRelay({ fetchImpl, streamIdleTimeoutMs: 20 }, async (server) => {
    const address = server.address();
    const result = await new Promise((resolve, reject) => {
      const req = http.request({
        host: "127.0.0.1",
        port: address.port,
        path: `${PM_STUDIO_RELAY_PREFIX}/responses`,
        method: "POST",
        headers: { Authorization: `Bearer ${ENTERPRISE_TOKEN}`, "Content-Type": "application/json" },
      }, (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("aborted", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks), aborted: true }));
        res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks), aborted: false }));
        res.on("error", () => {});
      });
      req.on("error", reject);
      req.end(JSON.stringify({ model: "gpt-enterprise", input: "x", stream: true }));
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.toString(), "data: first\n\n");
    assert.equal(result.aborted, true);
    assert.equal(upstreamAborted, true);
  });
});

test("stream idle timeout also releases a downstream backpressure wait", async () => {
  let upstreamAborted = false;
  const encoder = new TextEncoder();
  const fetchImpl = async (url, init) => {
    if (url.endsWith("/models")) return successfulCatalogResponse();
    let controller;
    const stream = new ReadableStream({
      start(value) {
        controller = value;
        value.enqueue(encoder.encode("data: blocked\n\n"));
      },
    });
    init.signal.addEventListener("abort", () => {
      upstreamAborted = true;
      controller.error(new DOMException("idle", "AbortError"));
    }, { once: true });
    return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
  };
  const handler = createPmStudioRelayHandler({ fetchImpl, streamIdleTimeoutMs: 20 });
  const body = JSON.stringify({ model: "gpt-enterprise", messages: [], stream: true });
  const req = Readable.from([Buffer.from(body)]);
  req.url = `${PM_STUDIO_RELAY_PREFIX}/chat/completions`;
  req.method = "POST";
  req.headers = {
    authorization: `Bearer ${ENTERPRISE_TOKEN}`,
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(body)),
  };
  req.socket = { remoteAddress: "127.0.0.1" };
  const res = new FakeResponse({ backpressure: true });
  const pending = handler(req, res);
  await res.waitForWrite();
  await Promise.race([pending, delay(1_000).then(() => { throw new Error("handler remained blocked"); })]);
  assert.equal(upstreamAborted, true);
  assert.equal(res.destroyed, true);
});

test("client abort cancels an open upstream stream", async () => {
  let upstreamAborted = false;
  let resolveAborted;
  const aborted = new Promise((resolve) => { resolveAborted = resolve; });
  const encoder = new TextEncoder();
  const fetchImpl = async (url, init) => {
    if (url.endsWith("/models")) return successfulCatalogResponse();
    let controller;
    const stream = new ReadableStream({
      start(value) {
        controller = value;
        value.enqueue(encoder.encode("data: first\n\n"));
      },
    });
    init.signal.addEventListener("abort", () => {
      upstreamAborted = true;
      const error = new Error("aborted");
      error.name = "AbortError";
      controller.error(error);
      resolveAborted();
    }, { once: true });
    return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
  };

  await withRelay({ fetchImpl, streamIdleTimeoutMs: 5_000 }, async (server) => {
    const address = server.address();
    const req = http.request({
      host: "127.0.0.1",
      port: address.port,
      path: `${PM_STUDIO_RELAY_PREFIX}/chat/completions`,
      method: "POST",
      headers: { Authorization: `Bearer ${ENTERPRISE_TOKEN}`, "Content-Type": "application/json" },
    });
    req.on("error", () => {});
    req.on("response", (res) => {
      res.once("data", () => res.destroy());
      res.on("error", () => {});
    });
    req.end(JSON.stringify({ model: "gpt-enterprise", messages: [], stream: true }));
    await Promise.race([aborted, delay(1_000).then(() => { throw new Error("upstream was not aborted"); })]);
    assert.equal(upstreamAborted, true);
  });
});

class FakeResponse extends EventEmitter {
  constructor({ backpressure = false } = {}) {
    super();
    this.backpressure = backpressure;
    this.chunks = [];
    this.destroyed = false;
    this.headersSent = false;
    this.statusCode = 0;
    this.writableEnded = false;
    this.writableFinished = false;
    this.writeWaiters = [];
  }

  setHeader() {}

  writeHead(statusCode, headers = {}) {
    this.statusCode = statusCode;
    this.headers = headers;
    this.headersSent = true;
  }

  write(chunk) {
    this.chunks.push(Buffer.from(chunk));
    for (const resolve of this.writeWaiters.splice(0)) resolve();
    if (this.backpressure) {
      this.backpressure = false;
      return false;
    }
    return true;
  }

  end(chunk) {
    if (chunk !== undefined) this.chunks.push(Buffer.from(chunk));
    this.writableEnded = true;
    this.writableFinished = true;
    this.emit("finish");
  }

  destroy() {
    this.destroyed = true;
    this.emit("close");
  }

  waitForWrite() {
    if (this.chunks.length) return Promise.resolve();
    return new Promise((resolve) => this.writeWaiters.push(resolve));
  }
}
