import { test } from "node:test";
import assert from "node:assert/strict";
import { computeInitiator, computeVision, buildHeaders, parseVSCodeVersion, FALLBACK_VSCODE_VERSION, responsesEndpointPath, optimizeImageDataUrl, optimizeImagesInBody, summarizeReqBody, parseImageConcurrency, runWithConcurrency } from "../src/copilot.mjs";

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

test("responsesEndpointPath: compact uses regular Responses upstream", () => {
  assert.equal(responsesEndpointPath(), "/responses");
});

test("parseImageConcurrency: defaults and caps image optimization concurrency", () => {
  assert.equal(parseImageConcurrency(undefined), 4);
  assert.equal(parseImageConcurrency("0"), 4);
  assert.equal(parseImageConcurrency("bad"), 4);
  assert.equal(parseImageConcurrency("12"), 12);
  assert.equal(parseImageConcurrency("99"), 12);
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
  assert.ok(summary.biggest > 0);
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
