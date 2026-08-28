import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { githubTokenPath } from "../src/auth.mjs";
import { cacheModelEndpoints, chatCompletions, computeInitiator, computeVision, buildHeaders, getCachedModelEndpoints, parseVSCodeVersion, FALLBACK_VSCODE_VERSION, responsesEndpointPath, optimizeImageDataUrl, optimizeImagesInBody, prepareResponsesPayload, summarizeReqBody, createTaskLimiter, parseImageConcurrency, parseUpstreamRetries, parseUpstreamRetryDelayMs, resetModelEndpointCacheForTests, runWithConcurrency, fetchCopilotUpstream, responses, listModels, getCopilotToken, resetCopilotTokenForTests } from "../src/copilot.mjs";
import { fitImageDimensions, imageConstraintsForModel } from "../src/image-optimization.mjs";
import { canonicalInlineImageIdentity, readResponsesImagePart } from "../src/responses-content.mjs";

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

test("imageConstraintsForModel: applies known model pixel limits conservatively", () => {
  assert.deepEqual(imageConstraintsForModel("gpt-4o"), { maxLongEdge: 2048, maxShortEdge: 768 });
  assert.deepEqual(imageConstraintsForModel("gpt-4.1-2025-04-14"), { maxLongEdge: 2048, maxShortEdge: 768 });
  assert.deepEqual(imageConstraintsForModel("gpt-4o-mini"), { maxLongEdge: 2048 });
  assert.deepEqual(imageConstraintsForModel("gpt-5-mini"), { maxLongEdge: 2048, maxShortEdge: 768 });
  assert.deepEqual(imageConstraintsForModel("gpt-5.6-sol"), { maxLongEdge: 2048, maxArea: 2_560_000 });
  assert.deepEqual(imageConstraintsForModel("gemini-2.5-pro", { maxDim: 1600 }), { maxLongEdge: 1600 });
  assert.deepEqual(imageConstraintsForModel("future-model", { maxDim: 1280 }), { maxLongEdge: 1280 });
});

test("fitImageDimensions: preserves aspect ratio within short-edge and area budgets", () => {
  assert.deepEqual(
    fitImageDimensions(2600, 1800, { maxLongEdge: 2048, maxShortEdge: 768 }),
    { width: 1109, height: 768 },
  );
  const square = fitImageDimensions(2400, 2400, { maxLongEdge: 2048, maxArea: 2_560_000 });
  assert.deepEqual(square, { width: 1600, height: 1600 });
  assert.equal(square.width * square.height <= 2_560_000, true);
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

test("createTaskLimiter: caps work across independent callers", async () => {
  const runLimited = createTaskLimiter(2);
  let active = 0;
  let maxActive = 0;
  await Promise.all(Array.from({ length: 8 }, () => runLimited(async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 3));
    active -= 1;
  })));

  assert.equal(maxActive, 2);
});

test("createTaskLimiter: removes aborted waiters and releases failed tasks", async () => {
  const runLimited = createTaskLimiter(1);
  let releaseFirst;
  let secondRan = false;
  const first = runLimited(() => new Promise((resolve) => { releaseFirst = resolve; }));
  await new Promise((resolve) => setTimeout(resolve, 0));

  const controller = new AbortController();
  const second = runLimited(async () => { secondRan = true; }, { signal: controller.signal });
  controller.abort();
  await assert.rejects(second, { name: "AbortError" });
  assert.equal(secondRan, false);

  releaseFirst();
  await first;
  await assert.rejects(runLimited(async () => { throw new Error("failed"); }), /failed/);
  assert.equal(await runLimited(async () => "next"), "next");
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

test("optimizeImagesInBody: deduplicates identical images within one pass", async () => {
  const original = "data:image/png;base64,QUJDRA==";
  const optimized = "data:image/webp;base64,RUZHSA==";
  const reqBody = {
    input: [
      { type: "message", content: [
        { type: "input_image", image_url: original },
        { type: "input_image", image_url: original },
      ] },
      { type: "function_call_output", output: JSON.stringify([
        { type: "input_image", image_url: original },
        { type: "input_image", image_url: original },
      ]) },
      { type: "custom_tool_call_output", output: [
        { type: "input_image", image_url: original },
      ] },
      { type: "input_image", image_url: original },
    ],
  };
  let calls = 0;

  await optimizeImagesInBody(reqBody, {
    concurrency: 4,
    optimizeImage: async () => {
      calls += 1;
      return optimized;
    },
  });

  assert.equal(calls, 1);
  assert.deepEqual(reqBody.input[0].content.map((part) => part.image_url), [optimized, optimized]);
  assert.deepEqual(JSON.parse(reqBody.input[1].output).map((part) => part.image_url), [optimized, optimized]);
  assert.equal(reqBody.input[2].output[0].image_url, optimized);
  assert.equal(reqBody.input[3].image_url, optimized);
});

test("optimizeImagesInBody: shares one inline identity across Responses, object URL, and Anthropic image parts", async () => {
  const original = "data:image/PNG;base64,QUJDRA==";
  const optimized = "data:image/webp;base64,RUZHSA==";
  const objectUrl = { url: original, detail: "high" };
  const parts = [
    { type: "input_image", image_url: original },
    { type: "input_image", image_url: objectUrl },
    { type: "image_url", image_url: { url: original, detail: "low" } },
    { type: "image", source: { type: "base64", media_type: "image/png", data: "QUJDRA==" } },
  ];
  const reqBody = { input: [{ type: "message", content: parts }] };
  let calls = 0;

  assert.equal(canonicalInlineImageIdentity(original), "data:image/png;base64,QUJDRA==");
  assert.equal(readResponsesImagePart(parts[3]).identity, "data:image/png;base64,QUJDRA==");
  await optimizeImagesInBody(reqBody, {
    optimizeImage: async () => {
      calls += 1;
      return optimized;
    },
  });

  assert.equal(calls, 1);
  assert.equal(parts[0].image_url, optimized);
  assert.equal(parts[1].image_url.url, optimized);
  assert.equal(parts[1].image_url.detail, "high");
  assert.equal(parts[2].image_url.url, optimized);
  assert.equal(parts[2].image_url.detail, "low");
  assert.deepEqual(parts[3].source, { type: "base64", media_type: "image/webp", data: "RUZHSA==" });
});

test("summarizeReqBody: counts direct and stringified tool images", () => {
  const reqBody = {
    input: [
      { type: "message", content: [{ type: "input_text", text: "hi" }, { type: "input_image", image_url: "data:image/png;base64,AAAA" }] },
      { type: "function_call_output", output: JSON.stringify([{ type: "input_image", image_url: "data:image/png;base64,BBBB" }]) },
      { type: "custom_tool_call_output", output: [{ type: "input_image", image_url: "data:image/png;base64,CCCC" }] },
      { type: "input_image", image_url: "data:image/png;base64,DDDD" },
    ],
  };
  const summary = summarizeReqBody(reqBody);
  assert.equal(summary.items, 4);
  assert.equal(summary.images, 4);
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

test("optimizeImageDataUrl: applies the model-aware size cap and converts to webp", async () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="2600" height="1800"><rect width="2600" height="1800" fill="white"/><text x="40" y="80">large screenshot</text><!-- ${"padding ".repeat(15000)} --></svg>`;
  const input = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
  const log = console.log;
  console.log = () => {};
  let output;
  try {
    output = await optimizeImageDataUrl(input, { model: "gpt-4o" });
  } finally {
    console.log = log;
  }

  assert.match(output, /^data:image\/webp;base64,/);
  assert.ok(Buffer.byteLength(output) < Buffer.byteLength(input));
  const metadata = await sharp(Buffer.from(output.split(",", 2)[1], "base64")).metadata();
  assert.ok(Math.max(metadata.width, metadata.height) <= 2048);
  assert.ok(Math.min(metadata.width, metadata.height) <= 768);
});

test("optimizeImageDataUrl: inspects a sub-100KB image and resizes it when dimensions exceed the model cap", async () => {
  const png = await sharp({
    create: { width: 4096, height: 4096, channels: 3, background: "white" },
  }).png().toBuffer();
  assert.ok(png.length < 100000);
  const input = `data:image/png;base64,${png.toString("base64")}`;
  const originalLog = console.log;
  console.log = () => {};
  let output;
  try {
    output = await optimizeImageDataUrl(input, { model: "gpt-4o" });
  } finally {
    console.log = originalLog;
  }

  assert.match(output, /^data:image\/webp;base64,/);
  const metadata = await sharp(Buffer.from(output.split(",", 2)[1], "base64")).metadata();
  assert.ok(Math.max(metadata.width, metadata.height) <= 2048);
  assert.ok(Math.min(metadata.width, metadata.height) <= 768);
});

test("optimizeImageDataUrl: rejects an aborted queued image operation", async () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="2600" height="1800"><rect width="2600" height="1800" fill="white"/><!-- ${"cancel ".repeat(18000)} --></svg>`;
  const input = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(optimizeImageDataUrl(input, { signal: controller.signal }), { name: "AbortError" });
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

function sizedImageDataUrl(size, byte) {
  return `data:image/png;base64,${Buffer.alloc(size, byte).toString("base64")}`;
}

function budgetTestBody() {
  const small = sizedImageDataUrl(1000, 1);
  const large = sizedImageDataUrl(3000, 2);
  const medium = sizedImageDataUrl(2000, 3);
  return {
    model: "gpt-5.6-sol",
    input: [{
      type: "message",
      content: [small, large, medium, large].map((image_url) => ({ type: "input_image", image_url })),
    }],
  };
}

function budgetTestOptimizer(calls) {
  return async (dataUrl, options) => {
    const raw = Buffer.from(dataUrl.split(",", 2)[1], "base64");
    calls.push({ inputBytes: raw.length, ...options });
    const ratio = options.quality === 82 ? 0.8 : options.quality === 75 ? 0.6 : 0.1;
    const output = Buffer.alloc(Math.max(1, Math.floor(raw.length * ratio)), raw[0]);
    return `data:image/webp;base64,${output.toString("base64")}`;
  };
}

function requestImageBytes(reqBody) {
  return reqBody.input[0].content.map((part) => Buffer.byteLength(part.image_url.split(",", 2)[1], "base64"));
}

test("prepareResponsesPayload: defaults to q82 then lowers the largest unique original to q75", async () => {
  const baselineCalls = [];
  const baseline = await prepareResponsesPayload(budgetTestBody(), {
    maxBytes: 1,
    optimizeImage: budgetTestOptimizer(baselineCalls),
    profiles: [],
  });
  assert.equal(baseline.stage, "q82");
  assert.equal(baseline.overBudget, true);
  assert.deepEqual(baselineCalls.map((call) => call.quality), [82, 82, 82]);

  const reqBody = budgetTestBody();
  const calls = [];
  const originalWarn = console.warn;
  console.warn = () => {};
  let payload;
  try {
    payload = await prepareResponsesPayload(reqBody, {
      maxBytes: baseline.bodyBytes - 500,
      optimizeImage: budgetTestOptimizer(calls),
      profiles: [{ maxDim: 1600, quality: 75 }],
    });
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(payload.stage, "q75");
  assert.equal(payload.overBudget, false);
  assert.equal(payload.adapted, true);
  assert.equal(payload.bodyBytes, Buffer.byteLength(payload.bodyText));
  assert.equal(calls.find((call) => call.force)?.inputBytes, 3000);
  assert.deepEqual(requestImageBytes(reqBody), [800, 1800, 1600, 1800]);
});

test("prepareResponsesPayload: retries originals at q65 and stops once within budget", async () => {
  const q75Body = budgetTestBody();
  const originalWarn = console.warn;
  console.warn = () => {};
  let q75Only;
  try {
    q75Only = await prepareResponsesPayload(q75Body, {
      maxBytes: 1,
      optimizeImage: budgetTestOptimizer([]),
      profiles: [{ maxDim: 1600, quality: 75 }],
    });
  } finally {
    console.warn = originalWarn;
  }

  const reqBody = budgetTestBody();
  const calls = [];
  console.warn = () => {};
  let payload;
  try {
    payload = await prepareResponsesPayload(reqBody, {
      maxBytes: q75Only.bodyBytes - 1000,
      optimizeImage: budgetTestOptimizer(calls),
      profiles: [
        { maxDim: 1600, quality: 75 },
        { maxDim: 1280, quality: 65 },
      ],
    });
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(payload.stage, "q65");
  assert.equal(payload.overBudget, false);
  assert.deepEqual(calls.filter((call) => call.quality === 75).map((call) => call.inputBytes), [3000, 2000, 1000]);
  assert.equal(calls.find((call) => call.quality === 65)?.inputBytes, 3000);
  assert.deepEqual(requestImageBytes(reqBody), [600, 300, 1200, 300]);
});

test("prepareResponsesPayload: orders oversize work by current repeated wire contribution", async () => {
  const largeOriginal = sizedImageDataUrl(3000, 1);
  const repeatedOriginal = sizedImageDataUrl(1000, 2);
  const makeBody = () => ({
    model: "gpt-5.6-sol",
    input: [{
      type: "message",
      content: [largeOriginal, repeatedOriginal, repeatedOriginal, repeatedOriginal]
        .map((image_url) => ({ type: "input_image", image_url })),
    }],
  });
  const calls = [];
  const optimizer = async (dataUrl, options) => {
    const raw = Buffer.from(dataUrl.split(",", 2)[1], "base64");
    calls.push({ inputBytes: raw.length, ...options });
    const outputBytes = options.quality === 82
      ? (raw[0] === 1 ? 100 : 900)
      : (raw[0] === 1 ? 50 : 100);
    return sizedImageDataUrl(outputBytes, raw[0]).replace("image/png", "image/webp");
  };
  const baseline = await prepareResponsesPayload(makeBody(), {
    maxBytes: 1,
    optimizeImage: optimizer,
    profiles: [],
  });
  calls.length = 0;
  const reqBody = makeBody();
  const originalWarn = console.warn;
  console.warn = () => {};
  let payload;
  try {
    payload = await prepareResponsesPayload(reqBody, {
      maxBytes: baseline.bodyBytes - 500,
      optimizeImage: optimizer,
      profiles: [{ maxDim: 1600, quality: 75 }],
    });
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(payload.overBudget, false);
  assert.equal(calls.find((call) => call.force)?.inputBytes, 1000);
  assert.deepEqual(requestImageBytes(reqBody), [100, 100, 100, 100]);
});

test("prepareResponsesPayload: commits each stringified tool container once per image profile", async () => {
  const imageCount = 8;
  let output = JSON.stringify(Array.from({ length: imageCount }, (_, index) => ({
    type: "input_image",
    image_url: sizedImageDataUrl(1000 + index, index + 1),
  })));
  let commits = 0;
  const toolOutput = { type: "custom_tool_call_output", call_id: "custom_many_images" };
  Object.defineProperty(toolOutput, "output", {
    configurable: true,
    enumerable: true,
    get: () => output,
    set: (value) => {
      commits += 1;
      output = value;
    },
  });
  const reqBody = { model: "gpt-5.6-sol", input: [toolOutput] };
  const calls = [];
  const originalWarn = console.warn;
  console.warn = () => {};
  let payload;
  try {
    payload = await prepareResponsesPayload(reqBody, {
      maxBytes: 1,
      optimizeImage: budgetTestOptimizer(calls),
      profiles: [
        { maxDim: 1600, quality: 75 },
        { maxDim: 1280, quality: 65 },
      ],
    });
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(commits, 3);
  assert.equal(calls.length, imageCount * 3);
  assert.equal(JSON.parse(toolOutput.output).length, imageCount);
  assert.equal(payload.bodyBytes, Buffer.byteLength(payload.bodyText));
  assert.equal(payload.bodyBytes, Buffer.byteLength(JSON.stringify(reqBody)));
});

test("prepareResponsesPayload: skipInitialOptimization bypasses all image profiles without rewriting input", async () => {
  const reqBody = budgetTestBody();
  const before = JSON.stringify(reqBody);
  let calls = 0;
  const payload = await prepareResponsesPayload(reqBody, {
    maxBytes: 1,
    optimizeImage: async (dataUrl) => {
      calls += 1;
      return dataUrl;
    },
    skipInitialOptimization: true,
  });

  assert.equal(calls, 0);
  assert.equal(payload.stage, "preoptimized");
  assert.equal(payload.overBudget, true);
  assert.equal(payload.bodyText, before);
  assert.equal(payload.bodyBytes, Buffer.byteLength(before));
  assert.equal(JSON.stringify(reqBody), before);
});

test("prepareResponsesPayload: reports an explicit over-budget result without dropping current input", async () => {
  const payload = await prepareResponsesPayload({
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "x".repeat(200) }] }],
  }, {
    currentInputStart: 99,
    maxBytes: 64,
    profiles: [],
  });

  assert.equal(payload.overBudget, true);
  assert.equal(payload.targetBytes, 64);
  assert.equal(payload.stage, "q82");
  assert.equal(payload.currentInputStart, 1);
  assert.equal(payload.bodyBytes, Buffer.byteLength(payload.bodyText));
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

test("fetchCopilotUpstream: retries a pre-connect POST failure", async () => {
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

test("fetchCopilotUpstream: does not retry ambiguous POST network failures", async () => {
  for (const code of ["UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "ETIMEDOUT", "ECONNRESET", "EPIPE"]) {
    let calls = 0;
    await assert.rejects(fetchCopilotUpstream("https://api.enterprise.githubcopilot.com/responses", {
      method: "POST",
      body: "{}",
    }, {
      retries: 2,
      retryDelayMs: 1,
      fetchImpl: async () => {
        calls += 1;
        const error = new TypeError("fetch failed");
        error.cause = { code };
        throw error;
      },
    }), /fetch failed/);
    assert.equal(calls, 1, code);
  }
});

test("fetchCopilotUpstream: retries a POST socket error explicitly attributed to connect", async () => {
  let calls = 0;
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const response = await fetchCopilotUpstream("https://api.enterprise.githubcopilot.com/responses", {
      method: "POST",
      body: "{}",
    }, {
      retries: 1,
      retryDelayMs: 1,
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) {
          const error = new TypeError("fetch failed");
          error.cause = { code: "ETIMEDOUT", syscall: "connect" };
          throw error;
        }
        return new Response("{}", { status: 200 });
      },
    });
    assert.equal(response.status, 200);
    assert.equal(calls, 2);
  } finally {
    console.warn = originalWarn;
  }
});

test("fetchCopilotUpstream: retains transient network retries for GET", async () => {
  let calls = 0;
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const response = await fetchCopilotUpstream("https://api.enterprise.githubcopilot.com/models", {}, {
      retries: 1,
      retryDelayMs: 1,
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) {
          const error = new TypeError("fetch failed");
          error.cause = { code: "ECONNRESET" };
          throw error;
        }
        return new Response("{}", { status: 200 });
      },
    });
    assert.equal(response.status, 200);
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

    let oversizedCalls = 0;
    let oversizedCancelled = false;
    const oversizedResp = await fetchCopilotUpstream("https://api.enterprise.githubcopilot.com/models", {}, {
      retries: 1,
      retryDelayMs: 1,
      fetchImpl: async () => {
        oversizedCalls += 1;
        if (oversizedCalls > 1) return new Response("{}", { status: 200 });
        return new Response(new ReadableStream({
          start(controller) { controller.enqueue(Buffer.alloc((64 * 1024) + 1)); },
          cancel() { oversizedCancelled = true; },
        }), { status: 503 });
      },
    });
    assert.equal(oversizedResp.status, 200);
    assert.equal(oversizedCalls, 2);
    assert.equal(oversizedCancelled, true);

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

test("chatCompletions: reuses prepared body text with the exact UTF-8 content length", async () => {
  resetCopilotTokenForTests();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-copilot-chat-length-"));
  writeText(githubTokenPath(home), "ghu_saved");
  try {
    await getCopilotToken({
      home,
      fetchImpl: async () => jsonResp(200, {
        token: "copilot_chat_length",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        endpoints: { api: "https://api.enterprise.githubcopilot.com" },
      }),
    });

    const request = { model: "gpt-4o", messages: [{ role: "user", content: "你好" }], stream: false };
    const bodyText = JSON.stringify(request, null, 2);
    const response = await chatCompletions(request, {
      bodyText,
      fetchImpl: async (url, options) => {
        assert.equal(url, "https://api.enterprise.githubcopilot.com/chat/completions");
        assert.equal(options.body, bodyText);
        assert.equal(options.headers["Content-Length"], String(Buffer.byteLength(options.body)));
        assert.deepEqual(JSON.parse(options.body), request);
        return new Response("{}", { status: 200 });
      },
    });

    assert.equal(response.status, 200);
  } finally {
    resetCopilotTokenForTests();
  }
});

test("responses: rejects an irreducible oversized body locally before upstream fetch", async () => {
  resetCopilotTokenForTests();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-copilot-response-budget-"));
  writeText(githubTokenPath(home), "ghu_saved");
  try {
    await getCopilotToken({
      home,
      fetchImpl: async () => jsonResp(200, {
        token: "copilot_budget",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      }),
    });

    let upstreamCalls = 0;
    await assert.rejects(responses({
      model: "gpt-5.6-sol",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "x".repeat(1000) }] }],
    }, {
      currentInputStart: 0,
      payloadOptions: { maxBytes: 128, profiles: [] },
      fetchImpl: async () => {
        upstreamCalls += 1;
        return new Response("{}", { status: 200 });
      },
    }), (error) => {
      assert.equal(error.statusCode, 413);
      assert.equal(error.code, "ccdx_request_body_too_large");
      assert.equal(error.jsonBody.error.limit_bytes, 128);
      assert.equal(error.jsonBody.error.stage, "q82");
      return true;
    });
    assert.equal(upstreamCalls, 0);
  } finally {
    resetCopilotTokenForTests();
  }
});

test("listModels: shares one in-flight request across concurrent callers", async () => {
  resetCopilotTokenForTests();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-models-singleflight-"));
  writeText(githubTokenPath(home), "ghu_saved");
  const originalLog = console.log;
  console.log = () => {};

  try {
    await getCopilotToken({
      home,
      fetchImpl: async () => jsonResp(200, {
        token: "copilot_models",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      }),
    });

    let calls = 0;
    let release;
    const fetchImpl = async () => {
      calls += 1;
      await new Promise((resolve) => { release = resolve; });
      return new Response(JSON.stringify({ data: [{ id: "gpt-5.6-sol", supported_endpoints: ["/responses"] }] }), { status: 200 });
    };

    const first = listModels({ fetchImpl });
    const second = listModels({ fetchImpl });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(calls, 1);
    release();

    const results = await Promise.all([first, second]);
    assert.deepEqual(results[0], results[1]);
    assert.equal(calls, 1);
  } finally {
    console.log = originalLog;
    resetCopilotTokenForTests();
  }
});

test("listModels: one caller abort does not cancel other waiters", async () => {
  resetCopilotTokenForTests();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-models-abort-"));
  writeText(githubTokenPath(home), "ghu_saved");
  const originalLog = console.log;
  console.log = () => {};

  try {
    await getCopilotToken({
      home,
      fetchImpl: async () => jsonResp(200, {
        token: "copilot_models_abort",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      }),
    });

    let calls = 0;
    let release;
    let upstreamSignal;
    const fetchImpl = async (_url, options) => {
      calls += 1;
      upstreamSignal = options.signal;
      await new Promise((resolve) => { release = resolve; });
      return new Response(JSON.stringify({ data: [{ id: "gpt-5.6-sol", supported_endpoints: ["/responses"] }] }), { status: 200 });
    };
    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = listModels({ signal: firstController.signal, fetchImpl });
    const second = listModels({ signal: secondController.signal, fetchImpl });
    await new Promise((resolve) => setTimeout(resolve, 10));

    firstController.abort();
    await assert.rejects(first, { name: "AbortError" });
    assert.equal(upstreamSignal.aborted, false);
    release();

    const result = await second;
    assert.equal(result.status, 200);
    assert.equal(calls, 1);
  } finally {
    console.log = originalLog;
    resetCopilotTokenForTests();
  }
});

test("listModels: aborts an orphaned flight and allows the next request", async () => {
  resetCopilotTokenForTests();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-models-orphan-"));
  writeText(githubTokenPath(home), "ghu_saved");
  const originalLog = console.log;
  console.log = () => {};

  try {
    await getCopilotToken({
      home,
      fetchImpl: async () => jsonResp(200, {
        token: "copilot_models_orphan",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      }),
    });

    let calls = 0;
    let firstUpstreamSignal;
    const fetchImpl = async (_url, options) => {
      calls += 1;
      if (calls > 1) {
        return new Response(JSON.stringify({ data: [{ id: "gpt-5.6-sol", supported_endpoints: ["/responses"] }] }), { status: 200 });
      }
      firstUpstreamSignal = options.signal;
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
      });
    };
    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = listModels({ signal: firstController.signal, fetchImpl });
    const second = listModels({ signal: secondController.signal, fetchImpl });
    await new Promise((resolve) => setTimeout(resolve, 10));

    firstController.abort();
    secondController.abort();
    await Promise.all([
      assert.rejects(first, { name: "AbortError" }),
      assert.rejects(second, { name: "AbortError" }),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(firstUpstreamSignal.aborted, true);

    const next = await listModels({ fetchImpl });
    assert.equal(next.status, 200);
    assert.equal(calls, 2);
  } finally {
    console.log = originalLog;
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

test("getCopilotToken: retries transient token responses during cold start", async () => {
  resetCopilotTokenForTests();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-copilot-cold-retry-"));
  writeText(githubTokenPath(home), "ghu_saved");
  let tokenCalls = 0;
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = () => {};
  console.warn = () => {};

  try {
    const token = await getCopilotToken({
      home,
      tokenRetryOptions: { retries: 2, retryDelayMs: 1 },
      fetchImpl: async (url) => {
        if (url.endsWith("/user")) return jsonResp(200, { login: "dale", id: 42 });
        tokenCalls += 1;
        if (tokenCalls === 1) return jsonResp(502, {});
        if (tokenCalls === 2) return jsonResp(504, {});
        return jsonResp(200, {
          token: "copilot_after_retry",
          expires_at: Math.floor(Date.now() / 1000) + 3600,
        });
      },
    });

    assert.equal(token, "copilot_after_retry");
    assert.equal(tokenCalls, 3);
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    resetCopilotTokenForTests();
  }
});

test("getCopilotToken: stops a cold-start retry when its only caller aborts", async () => {
  resetCopilotTokenForTests();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-copilot-cold-retry-abort-"));
  writeText(githubTokenPath(home), "ghu_saved");
  const controller = new AbortController();
  let tokenCalls = 0;
  const originalWarn = console.warn;
  console.warn = () => {};

  try {
    const token = getCopilotToken({
      home,
      signal: controller.signal,
      tokenRetryOptions: { retries: 2, retryDelayMs: 1000 },
      fetchImpl: async () => {
        tokenCalls += 1;
        queueMicrotask(() => controller.abort());
        return jsonResp(502, {});
      },
    });

    await assert.rejects(token, { name: "AbortError" });
    assert.equal(tokenCalls, 1);
  } finally {
    console.warn = originalWarn;
    resetCopilotTokenForTests();
  }
});

test("getCopilotToken: one caller abort does not cancel another refresh waiter", async () => {
  resetCopilotTokenForTests();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-copilot-waiter-abort-"));
  writeText(githubTokenPath(home), "ghu_saved");
  let tokenCalls = 0;
  let releaseRefresh;
  let upstreamSignal;
  const originalLog = console.log;
  console.log = () => {};

  try {
    const fetchImpl = async (url, options) => {
      if (url.endsWith("/user")) return jsonResp(200, { login: "dale", id: 42 });
      tokenCalls += 1;
      upstreamSignal = options.signal;
      await new Promise((resolve) => { releaseRefresh = resolve; });
      return jsonResp(200, {
        token: "copilot_waiter",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      });
    };
    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = getCopilotToken({ home, fetchImpl, signal: firstController.signal });
    const second = getCopilotToken({ home, fetchImpl, signal: secondController.signal });
    await new Promise((resolve) => setTimeout(resolve, 10));

    firstController.abort();
    await assert.rejects(first, { name: "AbortError" });
    assert.equal(upstreamSignal.aborted, false);
    releaseRefresh();

    assert.equal(await second, "copilot_waiter");
    assert.equal(tokenCalls, 1);
  } finally {
    console.log = originalLog;
    resetCopilotTokenForTests();
  }
});

test("getCopilotToken: aborts an orphaned refresh and allows the next request", async () => {
  resetCopilotTokenForTests();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-copilot-orphan-"));
  writeText(githubTokenPath(home), "ghu_saved");
  let tokenCalls = 0;
  let firstUpstreamSignal;
  const originalLog = console.log;
  console.log = () => {};

  try {
    const fetchImpl = async (url, options) => {
      if (url.endsWith("/user")) return jsonResp(200, { login: "dale", id: 42 });
      tokenCalls += 1;
      if (tokenCalls > 1) {
        return jsonResp(200, {
          token: "copilot_next",
          expires_at: Math.floor(Date.now() / 1000) + 3600,
        });
      }
      firstUpstreamSignal = options.signal;
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
      });
    };
    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = getCopilotToken({ home, fetchImpl, signal: firstController.signal });
    const second = getCopilotToken({ home, fetchImpl, signal: secondController.signal });
    await new Promise((resolve) => setTimeout(resolve, 10));

    firstController.abort();
    secondController.abort();
    await Promise.all([
      assert.rejects(first, { name: "AbortError" }),
      assert.rejects(second, { name: "AbortError" }),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(firstUpstreamSignal.aborted, true);

    assert.equal(await getCopilotToken({ home, fetchImpl }), "copilot_next");
    assert.equal(tokenCalls, 2);
  } finally {
    console.log = originalLog;
    resetCopilotTokenForTests();
  }
});

test("getCopilotToken: uses an unexpired token after a transient refresh failure", async () => {
  resetCopilotTokenForTests();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-copilot-stale-valid-"));
  writeText(githubTokenPath(home), "ghu_saved");
  let tokenCalls = 0;
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = () => {};
  console.warn = () => {};

  try {
    const fetchImpl = async (url) => {
      if (url.endsWith("/user")) return jsonResp(200, { login: "dale", id: 42 });
      tokenCalls += 1;
      if (tokenCalls === 1) {
        return jsonResp(200, {
          token: "copilot_still_valid",
          expires_at: Math.floor(Date.now() / 1000) + 30,
        });
      }
      return jsonResp(503, {});
    };

    assert.equal(await getCopilotToken({ home, fetchImpl }), "copilot_still_valid");
    assert.equal(await getCopilotToken({ home, fetchImpl }), "copilot_still_valid");
    assert.equal(await getCopilotToken({ home, fetchImpl }), "copilot_still_valid");
    assert.equal(tokenCalls, 2);
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    resetCopilotTokenForTests();
  }
});

test("getCopilotToken: does not hide 401 with an unexpired Copilot token", async () => {
  resetCopilotTokenForTests();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-copilot-no-auth-fallback-"));
  writeText(githubTokenPath(home), "ghu_saved");
  let tokenCalls = 0;
  const originalLog = console.log;
  console.log = () => {};

  try {
    const fetchImpl = async (url) => {
      if (url.endsWith("/user")) return jsonResp(200, { login: "dale", id: 42 });
      tokenCalls += 1;
      if (tokenCalls === 1) {
        return jsonResp(200, {
          token: "copilot_still_valid",
          expires_at: Math.floor(Date.now() / 1000) + 30,
        });
      }
      return jsonResp(401, {});
    };

    assert.equal(await getCopilotToken({ home, env: { CCDX_DISABLE_TOKEN_DISCOVERY: "1" }, fetchImpl }), "copilot_still_valid");
    await assert.rejects(
      getCopilotToken({ home, env: { CCDX_DISABLE_TOKEN_DISCOVERY: "1" }, fetchImpl }),
      /Failed to get Copilot token: 401/,
    );
    assert.equal(tokenCalls, 2);
  } finally {
    console.log = originalLog;
    resetCopilotTokenForTests();
  }
});

test("getCopilotToken: allows same-account GitHub token rotation", async () => {
  resetCopilotTokenForTests();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-copilot-same-account-"));
  writeText(githubTokenPath(home), "ghu_first");
  const originalLog = console.log;
  console.log = () => {};

  try {
    const fetchImpl = async (url, options) => {
      const authorization = options.headers.Authorization;
      if (url.endsWith("/user")) return jsonResp(200, { login: "dale", id: 42 });
      return jsonResp(200, {
        token: authorization === "token ghu_first" ? "copilot_first" : "copilot_rotated",
        expires_at: Math.floor(Date.now() / 1000) + 30,
      });
    };

    assert.equal(await getCopilotToken({ home, fetchImpl }), "copilot_first");
    writeText(githubTokenPath(home), "ghu_second");
    assert.equal(await getCopilotToken({ home, fetchImpl }), "copilot_rotated");
  } finally {
    console.log = originalLog;
    resetCopilotTokenForTests();
  }
});

test("getCopilotToken: refuses a silent account switch after the GitHub token changes", async () => {
  resetCopilotTokenForTests();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-copilot-account-switch-"));
  writeText(githubTokenPath(home), "ghu_first");
  const originalLog = console.log;
  console.log = () => {};

  try {
    const fetchImpl = async (url, options) => {
      const authorization = options.headers.Authorization;
      if (url.endsWith("/user")) {
        return authorization === "token ghu_first"
          ? jsonResp(200, { login: "dale", id: 42 })
          : jsonResp(200, { login: "other", id: 99 });
      }
      return jsonResp(200, {
        token: authorization === "token ghu_first" ? "copilot_first" : "copilot_other",
        expires_at: Math.floor(Date.now() / 1000) + 30,
      });
    };

    assert.equal(await getCopilotToken({ home, fetchImpl }), "copilot_first");
    writeText(githubTokenPath(home), "ghu_other");
    await assert.rejects(
      getCopilotToken({ home, fetchImpl }),
      /Refusing to switch GitHub Copilot account from dale to other/,
    );
  } finally {
    console.log = originalLog;
    resetCopilotTokenForTests();
  }
});
