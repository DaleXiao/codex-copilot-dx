import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { githubTokenPath } from "../src/auth.mjs";
import { cacheModelEndpoints, computeInitiator, computeVision, buildHeaders, getCachedModelEndpoints, parseVSCodeVersion, FALLBACK_VSCODE_VERSION, responsesEndpointPath, optimizeImageDataUrl, optimizeImagesInBody, prepareResponsesPayload, summarizeReqBody, parseImageConcurrency, parseUpstreamRetries, parseUpstreamRetryDelayMs, resetModelEndpointCacheForTests, runWithConcurrency, fetchCopilotUpstream, responses, getCopilotToken, resetCopilotTokenForTests } from "../src/copilot.mjs";

function jsonResp(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function writeText(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function writeJson(filePath, data) {
  writeText(filePath, JSON.stringify(data, null, 2));
}

function writeLocalCopilotAuth(home, token) {
  writeJson(path.join(home, "Library", "Application Support", "some-copilot-client", "profiles", "dingxiao_microsoft", "auth.json"), {
    ghcAuth: {
      gitHubTokens: {
        access_token: token,
      },
    },
  });
}

test("computeInitiator: user-only messages return user", () => {
  const msgs = [{ role: "user", content: "hi" }];
  assert.equal(computeInitiator(msgs), "user");
});

test("computeInitiator: assistant messages return agent", () => {
  const msgs = [{ role: "user", content: "hi" }, { role: "assistant", content: "yo" }];
  assert.equal(computeInitiator(msgs), "agent");
});

test("computeInitiator: tool messages return agent", () => {
  const msgs = [{ role: "tool", content: "result" }];
  assert.equal(computeInitiator(msgs), "agent");
});

test("computeVision: plain text returns false", () => {
  assert.equal(computeVision([{ role: "user", content: "hi" }]), false);
});

test("computeVision: image_url content returns true", () => {
  const msgs = [{ role: "user", content: [{ type: "image_url", image_url: { url: "x" } }] }];
  assert.equal(computeVision(msgs), true);
});

test("buildHeaders: includes fingerprint headers and Bearer token", () => {
  const h = buildHeaders({ token: "tok", version: "1.122.1", initiator: "agent", vision: true });
  assert.equal(h["Authorization"], "Bearer tok");
  assert.equal(h["Editor-Version"], "vscode/1.122.1");
  assert.equal(h["Editor-Plugin-Version"], "copilot-chat/0.26.7");
  assert.equal(h["User-Agent"], "GitHubCopilotChat/0.26.7");
  assert.equal(h["Openai-Intent"], "conversation-panel");
  assert.equal(h["X-Github-Api-Version"], "2025-04-01");
  assert.equal(h["Copilot-Integration-Id"], "vscode-chat");
  assert.equal(h["X-Vscode-User-Agent-Library-Version"], "electron-fetch");
  assert.equal(h["X-Initiator"], "agent");
  assert.equal(h["Copilot-Vision-Request"], "true");
  assert.ok(h["X-Request-Id"] && h["X-Request-Id"].length > 0);
});

test("buildHeaders: omits Copilot-Vision-Request when vision is false", () => {
  const h = buildHeaders({ token: "tok", version: "1.122.1", initiator: "user", vision: false });
  assert.equal(h["Copilot-Vision-Request"], undefined);
  assert.equal(h["X-Initiator"], "user");
});

test("parseVSCodeVersion: reads productVersion", () => {
  assert.equal(parseVSCodeVersion({ productVersion: "1.122.1" }), "1.122.1");
});

test("parseVSCodeVersion: missing productVersion falls back", () => {
  assert.equal(parseVSCodeVersion({}), FALLBACK_VSCODE_VERSION);
});

test("parseVSCodeVersion: null falls back", () => {
  assert.equal(parseVSCodeVersion(null), FALLBACK_VSCODE_VERSION);
});

test("FALLBACK_VSCODE_VERSION stays current enough", () => {
  assert.equal(FALLBACK_VSCODE_VERSION, "1.122.1");
});

test("parseVSCodeVersion: empty string falls back", () => {
  assert.equal(parseVSCodeVersion({ productVersion: "" }), FALLBACK_VSCODE_VERSION);
});

import { parseApiBase, DEFAULT_API_BASE } from "../src/copilot.mjs";

test("parseApiBase: reads endpoints.api", () => {
  assert.equal(parseApiBase({ endpoints: { api: "https://api.enterprise.githubcopilot.com" } }),
    "https://api.enterprise.githubcopilot.com");
});

test("parseApiBase: missing endpoints falls back", () => {
  assert.equal(parseApiBase({}), DEFAULT_API_BASE);
});

test("parseApiBase: endpoints without api falls back", () => {
  assert.equal(parseApiBase({ endpoints: {} }), DEFAULT_API_BASE);
});

test("DEFAULT_API_BASE is the public Copilot host", () => {
  assert.equal(DEFAULT_API_BASE, "https://api.githubcopilot.com");
});

test("cacheModelEndpoints: atomically replaces valid endpoint metadata", () => {
  resetModelEndpointCacheForTests();
  assert.equal(cacheModelEndpoints({ data: [
    { id: "old", supported_endpoints: ["/chat/completions"] },
  ] }), true);
  assert.deepEqual(getCachedModelEndpoints("old"), ["/chat/completions"]);

  assert.equal(cacheModelEndpoints({ data: [
    { id: "new", supported_endpoints: ["/responses"] },
  ] }), true);
  assert.equal(getCachedModelEndpoints("old"), null);
  assert.deepEqual(getCachedModelEndpoints("new"), ["/responses"]);

  assert.equal(cacheModelEndpoints({ data: [{ id: "malformed" }] }), false);
  assert.deepEqual(getCachedModelEndpoints("new"), ["/responses"]);
  resetModelEndpointCacheForTests();
});

test("responsesEndpointPath: compact uses regular Responses upstream", () => {
  assert.equal(responsesEndpointPath(), "/responses");
});

test("parseImageConcurrency: defaults and caps image optimization concurrency", () => {
  assert.equal(parseImageConcurrency(undefined), 2);
  assert.equal(parseImageConcurrency("0"), 2);
  assert.equal(parseImageConcurrency("bad"), 2);
  assert.equal(parseImageConcurrency("12"), 12);
  assert.equal(parseImageConcurrency("99"), 12);
});

test("parseUpstreamRetries: defaults and caps upstream retries", () => {
  assert.equal(parseUpstreamRetries(undefined), 2);
  assert.equal(parseUpstreamRetries("bad"), 2);
  assert.equal(parseUpstreamRetries("-1"), 2);
  assert.equal(parseUpstreamRetries("0"), 0);
  assert.equal(parseUpstreamRetries("99"), 5);
});

test("parseUpstreamRetryDelayMs: defaults and caps upstream retry delay", () => {
  assert.equal(parseUpstreamRetryDelayMs(undefined), 300);
  assert.equal(parseUpstreamRetryDelayMs("0"), 300);
  assert.equal(parseUpstreamRetryDelayMs("bad"), 300);
  assert.equal(parseUpstreamRetryDelayMs("1200"), 1200);
  assert.equal(parseUpstreamRetryDelayMs("99999"), 5000);
});

test("runWithConcurrency: caps simultaneously running tasks", async () => {
  let active = 0;
  let maxActive = 0;
  let completed = 0;
  const tasks = Array.from({ length: 10 }, () => async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    completed += 1;
  });

  await runWithConcurrency(tasks, 3);

  assert.equal(completed, 10);
  assert.ok(maxActive <= 3);
});

test("optimizeImagesInBody: applies one concurrency limit across nested tool outputs", async () => {
  let active = 0;
  let maxActive = 0;
  let calls = 0;
  const reqBody = {
    input: Array.from({ length: 4 }, (_, group) => ({
      type: "function_call_output",
      output: JSON.stringify(Array.from({ length: 4 }, (_, image) => ({
        type: "input_image",
        image_url: `data:image/png;base64,${group}${image}`,
      }))),
    })),
  };

  await optimizeImagesInBody(reqBody, {
    concurrency: 2,
    optimizeImage: async (value) => {
      calls += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      return value;
    },
  });

  assert.equal(calls, 16);
  assert.ok(maxActive <= 2);
});

test("summarizeReqBody: counts direct and stringified tool images", () => {
  const reqBody = {
    input: [
      { type: "message", content: [{ type: "input_text", text: "hi" }, { type: "input_image", image_url: "data:image/png;base64,AAAA" }] },
      { type: "function_call_output", output: JSON.stringify([{ type: "input_image", image_url: "data:image/png;base64,BBBB" }]) },
    ],
  };
  const summary = summarizeReqBody(reqBody);
  assert.equal(summary.items, 2);
  assert.equal(summary.images, 2);
});

test("optimizeImagesInBody: preserves small images and rewrites parsed tool output", async () => {
  const reqBody = {
    input: [
      { type: "function_call_output", output: JSON.stringify([{ type: "input_image", image_url: "data:image/png;base64,AAAA" }]) },
    ],
  };
  await optimizeImagesInBody(reqBody);
  assert.equal(reqBody.input[0].output, JSON.stringify([{ type: "input_image", image_url: "data:image/png;base64,AAAA" }]));
});

test("optimizeImageDataUrl: downscales large images to webp", async () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="2600" height="1800"><rect width="2600" height="1800" fill="white"/><text x="40" y="80">large screenshot</text><!-- ${"padding ".repeat(15000)} --></svg>`;
  const input = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
  const log = console.log;
  console.log = () => {};
  let output;
  try {
    output = await optimizeImageDataUrl(input);
  } finally {
    console.log = log;
  }

  assert.match(output, /^data:image\/webp;base64,/);
  assert.ok(Buffer.byteLength(output) < Buffer.byteLength(input));
});

test("optimizeImageDataUrl: compresses an unknown webp once and remembers the result", async () => {
  const pixels = Buffer.alloc(512 * 512 * 3);
  let seed = 0x12345678;
  for (let index = 0; index < pixels.length; index += 1) {
    seed = ((seed * 1664525) + 1013904223) >>> 0;
    pixels[index] = seed >>> 24;
  }
  const webp = await sharp(pixels, { raw: { width: 512, height: 512, channels: 3 } })
    .webp({ quality: 100 })
    .toBuffer();
  assert.ok(webp.length > 100000);
  const input = `data:image/webp;base64,${webp.toString("base64")}`;

  const originalLog = console.log;
  console.log = () => {};
  let output;
  let repeated;
  try {
    output = await optimizeImageDataUrl(input);
    repeated = await optimizeImageDataUrl(output);
  } finally {
    console.log = originalLog;
  }

  assert.notEqual(output, input);
  assert.ok(Buffer.byteLength(output) < Buffer.byteLength(input));
  assert.equal(repeated, output);
});

test("prepareResponsesPayload: applies stronger image compression only above the payload budget", async () => {
  const pixels = Buffer.alloc(512 * 512 * 3);
  let seed = 0x87654321;
  for (let index = 0; index < pixels.length; index += 1) {
    seed = ((seed * 1664525) + 1013904223) >>> 0;
    pixels[index] = seed >>> 24;
  }
  const webp = await sharp(pixels, { raw: { width: 512, height: 512, channels: 3 } })
    .webp({ quality: 100 })
    .toBuffer();
  const reqBody = {
    input: [{
      type: "message",
      content: [{ type: "input_image", image_url: `data:image/webp;base64,${webp.toString("base64")}` }],
    }],
  };
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = () => {};
  console.warn = () => {};
  let standardPayload;
  let payload;
  try {
    standardPayload = await prepareResponsesPayload(reqBody, {
      maxBytes: 1000000,
      profiles: [{ maxDim: 128, quality: 50 }],
    });
    payload = await prepareResponsesPayload(reqBody, {
      maxBytes: 100000,
      profiles: [{ maxDim: 128, quality: 50 }],
    });
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
  }

  assert.equal(standardPayload.adapted, false);
  assert.ok(standardPayload.bodyBytes < 1000000);
  assert.equal(payload.adapted, true);
  assert.ok(payload.bodyBytes <= 100000);
  assert.equal(payload.bodyBytes, Buffer.byteLength(payload.bodyText));
  const optimized = Buffer.from(reqBody.input[0].content[0].image_url.split(",", 2)[1], "base64");
  const metadata = await sharp(optimized).metadata();
  assert.ok(metadata.width <= 128);
  assert.ok(metadata.height <= 128);
});

test("fetchCopilotUpstream: retries transient network errors", async () => {
  let calls = 0;
  const originalWarn = console.warn;
  console.warn = () => {};

  try {
    const resp = await fetchCopilotUpstream("https://api.enterprise.githubcopilot.com/responses", {
      method: "POST",
      body: Buffer.from("{}"),
    }, {
      retries: 1,
      retryDelayMs: 1,
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) {
          const err = new TypeError("fetch failed");
          err.cause = { code: "UND_ERR_CONNECT_TIMEOUT", message: "Connect Timeout Error" };
          throw err;
        }
        return new Response("{}", { status: 200 });
      },
    });

    assert.equal(resp.status, 200);
    assert.equal(calls, 2);
  } finally {
    console.warn = originalWarn;
  }
});

test("fetchCopilotUpstream: retries transient safe-method statuses only", async () => {
  const originalWarn = console.warn;
  console.warn = () => {};

  try {
    let getCalls = 0;
    const getResp = await fetchCopilotUpstream("https://api.enterprise.githubcopilot.com/models", {}, {
      retries: 1,
      retryDelayMs: 1,
      fetchImpl: async () => {
        getCalls += 1;
        return new Response("{}", { status: getCalls === 1 ? 503 : 200 });
      },
    });
    assert.equal(getResp.status, 200);
    assert.equal(getCalls, 2);

    let postCalls = 0;
    const postResp = await fetchCopilotUpstream("https://api.enterprise.githubcopilot.com/responses", { method: "POST" }, {
      retries: 1,
      retryDelayMs: 1,
      fetchImpl: async () => {
        postCalls += 1;
        return new Response("{}", { status: 503 });
      },
    });
    assert.equal(postResp.status, 503);
    assert.equal(postCalls, 1);
  } finally {
    console.warn = originalWarn;
  }
});

test("responses: retries a Copilot connect timeout before returning upstream response", async () => {
  resetCopilotTokenForTests();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-copilot-response-retry-"));
  writeText(githubTokenPath(home), "ghu_saved");
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = () => {};
  console.warn = () => {};

  try {
    await getCopilotToken({
      home,
      fetchImpl: async () => jsonResp(200, {
        token: "copilot_short",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        endpoints: { api: "https://api.enterprise.githubcopilot.com" },
      }),
    });

    let calls = 0;
    const resp = await responses({ model: "gpt-5.5", input: [] }, {
      retryOptions: { retries: 1, retryDelayMs: 1 },
      fetchImpl: async (url, options) => {
        assert.equal(url, "https://api.enterprise.githubcopilot.com/responses");
        assert.equal(options.method, "POST");
        assert.equal(typeof options.body, "string");
        assert.equal(options.headers["Content-Length"], String(Buffer.byteLength(options.body)));
        calls += 1;
        if (calls === 1) {
          const err = new TypeError("fetch failed");
          err.cause = { code: "UND_ERR_CONNECT_TIMEOUT", message: "Connect Timeout Error" };
          throw err;
        }
        return new Response(JSON.stringify({ id: "resp_retry", output: [] }), { status: 200 });
      },
    });

    assert.equal(resp.status, 200);
    assert.equal(calls, 2);
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    resetCopilotTokenForTests();
  }
});

test("getCopilotToken: imports a valid local token after saved token is rejected", async () => {
  resetCopilotTokenForTests();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-copilot-recover-"));
  writeText(githubTokenPath(home), "ghu_old");
  writeLocalCopilotAuth(home, "ghu_local");
  const calls = [];
  const originalLog = console.log;
  console.log = () => {};

  try {
    const token = await getCopilotToken({
      home,
      env: {},
      fetchImpl: async (url, options) => {
        const authorization = options.headers.Authorization;
        calls.push([url, authorization]);
        if (url.endsWith("/copilot_internal/v2/token") && authorization === "token ghu_old") {
          return jsonResp(401, {});
        }
        if (url.endsWith("/user") && authorization === "token ghu_local") {
          return jsonResp(200, { login: "dingxiao_microsoft" });
        }
        if (url.endsWith("/copilot_internal/v2/token") && authorization === "token ghu_local") {
          return jsonResp(200, {
            token: "copilot_recovered",
            expires_at: Math.floor(Date.now() / 1000) + 3600,
            endpoints: { api: "https://api.enterprise.githubcopilot.com" },
          });
        }
        throw new Error(`unexpected request ${url} ${authorization}`);
      },
    });

    assert.equal(token, "copilot_recovered");
    assert.equal(fs.readFileSync(githubTokenPath(home), "utf8"), "ghu_local");
    assert.deepEqual(calls.map((call) => call[1]), [
      "token ghu_old",
      "token ghu_local",
      "token ghu_local",
    ]);
  } finally {
    console.log = originalLog;
    resetCopilotTokenForTests();
  }
});

test("getCopilotToken: shares one in-flight refresh across concurrent callers", async () => {
  resetCopilotTokenForTests();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-copilot-singleflight-"));
  writeText(githubTokenPath(home), "ghu_saved");
  let calls = 0;
  let releaseRefresh;
  const originalLog = console.log;
  console.log = () => {};

  try {
    const fetchImpl = async (url, options) => {
      assert.equal(url, "https://api.github.com/copilot_internal/v2/token");
      assert.equal(options.headers.Authorization, "token ghu_saved");
      calls += 1;
      await new Promise((resolve) => { releaseRefresh = resolve; });
      return jsonResp(200, {
        token: "copilot_singleflight",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      });
    };

    const first = getCopilotToken({ home, fetchImpl });
    const second = getCopilotToken({ home, fetchImpl });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(calls, 1);
    releaseRefresh();

    assert.deepEqual(await Promise.all([first, second]), ["copilot_singleflight", "copilot_singleflight"]);
    assert.equal(calls, 1);
  } finally {
    console.log = originalLog;
    resetCopilotTokenForTests();
  }
});
