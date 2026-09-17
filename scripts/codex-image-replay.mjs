// Optional installed-runtime regression: node scripts/codex-image-replay.mjs --codex /absolute/path/to/codex
// All model responses and generated pixels are synthetic. No installed configuration or credentials are used.
// Optional --live-model MODEL uses the running loopback CCDX for one real model-selection check; pixels stay synthetic.
// Add --edit to verify generation followed by two edits, including the prior image handle and preserved originals.
// Every image turn verifies final chat image Markdown; redisplay must reuse the prior file without an image call.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { computeImageMcpCodexConfig } from "../src/config.mjs";
import { createImageMcpHandler } from "../src/image-mcp.mjs";
import { updateImageSkill } from "../src/image-skill.mjs";
import { parseImageToolArgs } from "../src/image-tool-client.mjs";

const args = process.argv.slice(2);
let codex = process.env.CCDX_CODEX_BINARY;
let liveModel;
let withoutMcp = false;
let editing = false;
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === "--without-mcp") { withoutMcp = true; continue; }
  if (args[index] === "--edit") { editing = true; continue; }
  assert.ok(args[index + 1], `Missing value for ${args[index]}`);
  if (args[index] === "--codex") codex = args[index + 1];
  else if (args[index] === "--live-model") liveModel = args[index + 1];
  else assert.fail(`Unknown argument: ${args[index]}`);
  index += 1;
}
assert.ok(!withoutMcp || liveModel, "--without-mcp requires --live-model");
assert.ok(codex && path.isAbsolute(codex), "Supply --codex /absolute/path/to/codex or CCDX_CODEX_BINARY");
const loopbackFetch = fetch;
globalThis.fetch = async () => { throw new Error("Network fetch is forbidden in this offline replay"); };
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ccdx-image-replay-")));
const home = path.join(root, "codex");
const cwd = path.join(root, "project");
const imageDirectory = path.join(root, "mcp-images");
const codexPath = path.join(home, "config.toml");
const helperPath = path.join(home, "skills", "ccdx-image", "scripts", "generate.mjs");
const imageDimension = liveModel ? 1024 : 64;
const pngs = await Promise.all(["#2060c0", "#c02020", "#209040"].map(async (color) => {
  const pixels = liveModel
    ? sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><rect width="1024" height="1024" fill="white"/><circle cx="512" cy="512" r="300" fill="${color}"/></svg>`))
    : sharp({ create: { width: 64, height: 64, channels: 3, background: color } });
  return (await pixels.png().toBuffer()).toString("base64");
}));
const imageIdPattern = /^ccdx_img_[0-9a-f-]{36}$/;
const syntheticPrompts = ["A synthetic blue square.", "Make the square red; keep everything else unchanged.", "Make the square green; keep everything else unchanged."];
const toolNamespace = "mcp__ccdx_image";
const model = liveModel || "gpt-5.5";
const timeoutMs = liveModel ? 120_000 : 30_000;
let child;
let client;
let stderr = "";
let scenario;
let upstreamCount = 0;
let generationCount = 0;
let editCount = 0;
let fixtureApprovals = 0;
let helperApprovals = 0;
let serverError;
const summaries = [];
const imageCalls = [];
const knownImages = new Map();
const savedImages = new Map();
const deliveredImages = new Map();
let latestImageId;
let latestChatImage;

function runtimeEnv() {
  return {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    TMPDIR: root,
    LANG: process.env.LANG || "en_US.UTF-8",
    CODEX_HOME: home,
  };
}

async function bounded(promise, label, milliseconds = timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds);
      }),
    ]);
  } finally { clearTimeout(timer); }
}

function helperCommandArguments(command, workdir, allowShellWrapper = true) {
  // Accept only a single literal Node invocation: no shell expansion, redirection, or compound commands.
  if (!withoutMcp || typeof command !== "string" || /[\r\n]/.test(command) || path.resolve(workdir || "") !== cwd) return null;
  const words = [];
  let word = "";
  let quote = "";
  let active = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote === "'") {
      if (char === "'") quote = "";
      else word += char;
    } else if (char === "\\") {
      if (++index >= command.length) return null;
      word += command[index];
      active = true;
    } else if (quote === '"') {
      if (char === '"') quote = "";
      else if (char === "$" || char === "`") return null;
      else word += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      active = true;
    } else if (/\s/.test(char)) {
      if (active) { words.push(word); word = ""; active = false; }
    } else {
      if (/[;&|<>(){}\[\]?*~$`#]/.test(char)) return null;
      word += char;
      active = true;
    }
  }
  if (quote) return null;
  if (active) words.push(word);
  if (allowShellWrapper && words.length === 3
    && ["/bin/zsh", "/bin/bash", "/bin/sh"].includes(words[0])
    && ["-lc", "-c"].includes(words[1])) {
    return helperCommandArguments(words[2], workdir, false);
  }
  if (words[0] !== process.execPath || words[1] !== helperPath) return null;
  try {
    const parsed = parseImageToolArgs(words.slice(2));
    if (parsed.help) return null;
    const output = path.resolve(cwd, parsed.out || "output/imagegen");
    if (!output.startsWith(`${cwd}${path.sep}`)) return null;
    return parsed;
  } catch { return null; }
}

function createClient(process) {
  const pending = new Map();
  const events = [];
  const listeners = new Set();
  let nextId = 0;
  let buffer = "";
  const fail = (error) => {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
    for (const listener of listeners) listener.reject(error);
    listeners.clear();
  };
  process.on("error", fail);
  process.on("exit", (code, signal) => fail(new Error(`Codex exited: ${code ?? signal}`)));
  process.stdin.on("error", fail);
  process.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (;;) {
      const delimiter = buffer.indexOf("\n");
      if (delimiter < 0) break;
      const line = buffer.slice(0, delimiter);
      buffer = buffer.slice(delimiter + 1);
      if (!line) continue;
      let event;
      try { event = JSON.parse(line); } catch (error) { fail(error); continue; }
      if (pending.has(event.id)) {
        const request = pending.get(event.id);
        pending.delete(event.id);
        if (event.error) request.reject(new Error(JSON.stringify(event.error)));
        else request.resolve(event.result);
      } else if (event.method) {
        if (event.id !== undefined) {
          const approval = event.params;
          if (scenario?.image && event.method === "mcpServer/elicitation/request"
            && approval.serverName === "ccdx_image"
            && approval._meta?.codex_approval_kind === "mcp_tool_call"
            && approval.message?.includes(scenario?.editStep ? '"edit_image"' : '"generate_image"')
            && typeof approval._meta?.tool_params?.prompt === "string"
            && (liveModel || approval._meta.tool_params.prompt === syntheticPrompts[scenario?.editStep || 0])
            && (scenario?.editStep ? approval._meta.tool_params.image_id === scenario.imageId : approval._meta.tool_params.image_id === undefined)
            && [undefined, "1024x1024", "1536x1024", "1024x1536"].includes(approval._meta.tool_params.size)) {
            fixtureApprovals += 1;
            process.stdin.write(`${JSON.stringify({ id: event.id, result: { action: "accept", content: {} } })}\n`);
          } else if (scenario?.image && event.method === "item/commandExecution/requestApproval"
            && helperCommandArguments(approval.command, approval.cwd)) {
            helperApprovals += 1;
            process.stdin.write(`${JSON.stringify({ id: event.id, result: { decision: "accept" } })}\n`);
          } else fail(new Error(`Unexpected client approval/tool request: ${event.method}`));
          continue;
        }
        events.push(event);
        for (const listener of listeners) {
          if (listener.matches(event)) { listeners.delete(listener); listener.resolve(event); }
        }
      }
    }
  });
  return {
    events,
    notify(method) { process.stdin.write(`${JSON.stringify({ method, params: {} })}\n`); },
    call(method, params) {
      const id = ++nextId;
      return bounded(new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        process.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      }), method).finally(() => pending.delete(id));
    },
    waitFor(matches, label, after = events.length) {
      const existing = events.slice(after).find(matches);
      if (existing) return Promise.resolve(existing);
      let listener;
      return bounded(new Promise((resolve, reject) => {
        listener = { matches, resolve, reject };
        listeners.add(listener);
      }), label).finally(() => listeners.delete(listener));
    },
  };
}

function syntheticResponse(output, id) {
  let sequence = 0;
  const events = [];
  const emit = (type, fields) => events.push(`event: ${type}\ndata: ${JSON.stringify({
    type, sequence_number: sequence++, ...fields,
  })}\n\n`);
  const response = {
    id, object: "response", created_at: 1720000000, status: "completed", model: "gpt-5.5", output,
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  };
  emit("response.created", { response: { ...response, status: "in_progress", output: [] } });
  for (const [index, item] of output.entries()) {
    emit("response.output_item.added", { output_index: index, item: { ...item, status: "in_progress", ...(item.type === "function_call" ? { arguments: "" } : item.type === "message" ? { content: [] } : {}) } });
    if (item.type === "function_call") {
      emit("response.function_call_arguments.delta", { output_index: index, item_id: item.id, delta: item.arguments });
      emit("response.function_call_arguments.done", { output_index: index, item_id: item.id, arguments: item.arguments });
    } else if (item.type === "message") {
      const location = { output_index: index, content_index: 0, item_id: item.id };
      emit("response.content_part.added", { ...location, part: { ...item.content[0], text: "" } });
      emit("response.output_text.delta", { ...location, delta: item.content[0].text });
      emit("response.output_text.done", { ...location, text: item.content[0].text });
      emit("response.content_part.done", { ...location, part: item.content[0] });
    }
    emit("response.output_item.done", { output_index: index, item });
  }
  emit("response.completed", { response });
  return events.join("");
}

function finalMessage(label, imageMarkdown = "") {
  return { id: `msg_${label}`, type: "message", role: "assistant", phase: "final_answer", status: "completed", content: [{ type: "output_text", text: `SYNTHETIC ${label} COMPLETE.${imageMarkdown ? `\n\n${imageMarkdown}` : ""}`, annotations: [] }] };
}

function displayedImagePaths(text) {
  const prose = String(text || "").replace(/```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`/g, "");
  return [...prose.matchAll(/!\[[^\]\r\n]*\]\(\s*(?:<([^>\r\n]+)>|([^\s)]+))\s*\)/g)].map((match) => {
    try { return decodeURIComponent(match[1] || match[2]); } catch { return ""; }
  });
}

const imageMcp = createImageMcpHandler({
  imageDirectory,
  configLoader: () => ({ model: "qwen-image-3.0-pro", protocol: "qwen-messages", api_key: "unused-offline-fixture" }),
  generateImageFn: async (_config, args) => {
    assert.ok(scenario?.image, "Image provider called outside an image turn");
    if (!liveModel) {
      assert.equal(args.prompt, syntheticPrompts[scenario.editStep]);
      assert.equal(args.size, "1024x1024");
    }
    assert.ok(typeof args.prompt === "string" && args.prompt.trim() && args.prompt.length <= 16000);
    assert.equal(scenario.providerCalls++, 0, "Exactly one synthetic provider call is permitted per image turn");
    if (scenario.editStep) {
      assert.equal(args.image, `data:image/png;base64,${knownImages.get(scenario.imageId)}`, "Edit must receive the exact previous image pixels");
      editCount += 1;
    } else assert.equal(args.image, undefined, "Fresh generation must not carry a source image");
    generationCount += 1;
    return { data: pngs[scenario.editStep], mimeType: "image/png", width: imageDimension, height: imageDimension, size: args.size, model: "qwen-image-3.0-pro" };
  },
});
let catalog;
const server = http.createServer((req, res) => {
  (async () => {
    if (req.url === "/mcp/image") {
      if (req.method !== "POST") return imageMcp(req, res);
      const record = {};
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.once("end", () => {
        if (!chunks.length) return;
        record.request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (record.request.method === "tools/call") imageCalls.push(record);
      });
      const end = res.end;
      res.end = function (body, ...rest) {
        if (body) record.response = JSON.parse(String(body));
        return end.call(this, body, ...rest);
      };
      return imageMcp(req, res);
    }
    if (req.method === "GET" && req.url.startsWith("/v1/models")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(catalog));
      return;
    }
    if (req.method === "GET") {
      res.writeHead(404);
      res.end();
      return;
    }
    assert.equal(req.method, "POST");
    assert.equal(req.url, "/v1/responses");
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    upstreamCount += 1;
    assert.ok(scenario, "Unexpected fixture inference request");
    assert.equal(body.model, model);
    assert.equal(body.stream, true);
    if (scenario.requireSkill) {
      assert.ok(JSON.stringify(body.input).includes("ccdx-image"), "Next turn did not discover newly installed ccdx-image before explicit skill/MCP reload");
    }
    const step = scenario.steps++;
    if (liveModel && (scenario.image || scenario.redisplay)) {
      assert.ok(step < 12, "Live replay exceeded its bounded model request budget");
      assert.ok(JSON.stringify(body.input).includes("ccdx-image"), "Managed skill missing from live model context");
      const upstream = await loopbackFetch("http://127.0.0.1:2026/v1/responses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      res.writeHead(upstream.status, { "Content-Type": upstream.headers.get("content-type") || "application/json" });
      for await (const chunk of upstream.body) res.write(chunk);
      res.end();
      return;
    }
    assert.ok(step < (scenario.image ? 3 : 1), "Unexpected model retry or repeated tool invocation");
    let output = [finalMessage(scenario.label, scenario.redisplay ? latestChatImage.markdown : "")];
    const toolName = scenario.editStep ? "edit_image" : "generate_image";
    if (scenario.image && step === 0) {
      assert.ok(body.tools.some((tool) => tool.type === "tool_search"), "Actual Codex must expose discovery for deferred MCP tools");
      assert.ok(JSON.stringify(body.input).includes("ccdx-image"), "CCDX image skill missing from actual Codex input context");
      output = [{ id: `search_${scenario.label}`, type: "tool_search_call", execution: "client", call_id: `search_${scenario.label}`, status: "completed", arguments: { query: `+ccdx_image ${toolName}`, limit: 5 } }];
    } else if (scenario.image && step === 1) {
      const discovery = body.input.find((item) => item.type === "tool_search_output" && item.call_id === `search_${scenario.label}`);
      assert.ok(discovery?.tools.some((tool) => tool.name === toolNamespace && tool.tools?.some((nested) => nested.name === toolName)), "CCDX image tool missing from actual Codex deferred-tool discovery");
      output = [{ id: `fc_${scenario.label}`, type: "function_call", namespace: toolNamespace, name: toolName, call_id: `call_${scenario.label}`, status: "completed", arguments: JSON.stringify({ prompt: syntheticPrompts[scenario.editStep], size: "1024x1024", ...(scenario.editStep ? { image_id: scenario.imageId } : {}) }) }];
    } else if (scenario.image) {
      const result = body.input.find((item) => item.type === "function_call_output" && item.call_id === `call_${scenario.label}`);
      assert.ok(result, "Image MCP call output missing from follow-up model request");
      assert.ok(Array.isArray(result.output), `Native image output was replaced: ${JSON.stringify(result.output).slice(0, 700)}`);
      const image = result.output.find((part) => part.type === "input_image" && part.image_url?.startsWith("data:image/"));
      assert.ok(image, "Generated image not preserved as native image input");
      const metadata = await sharp(Buffer.from(image.image_url.split(",")[1], "base64")).metadata();
      assert.equal(metadata.width, 64);
      assert.equal(metadata.height, 64);
      assert.equal(image.image_url, `data:image/png;base64,${pngs[scenario.editStep]}`, "Model continuation must receive the latest image pixels");
      const returned = imageCalls.at(-1)?.response?.result;
      const text = returned?.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
      const markdown = text?.match(/!\[[^\]\r\n]*\]\(<[^>\r\n]+>\)/)?.[0];
      assert.ok(markdown, "Production image result must supply ready-to-use chat Markdown");
      assert.ok(result.output.some((part) => typeof part.text === "string" && part.text.includes(markdown)), "Image delivery Markdown missing from the model continuation");
      assert.deepEqual(displayedImagePaths(markdown), [returned._meta?.["ccdx/image_path"]]);
      output = [finalMessage(scenario.label, markdown)];
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(syntheticResponse(output, `resp_${scenario.label}_${step}`));
  })().catch((error) => {
    serverError = error;
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
});

async function startClient() {
  stderr = "";
  child = spawn(codex, ["app-server", "--stdio"], { cwd, env: runtimeEnv(), stdio: ["pipe", "pipe", "pipe"] });
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-4000); });
  client = createClient(child);
  await client.call("initialize", { clientInfo: { name: "ccdx-image-replay", version: "1.0" }, capabilities: { experimentalApi: true } });
  client.notify("initialized");
}

async function stopClient() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  try { await bounded(exited, "Codex shutdown", 2_000); } catch {
    child.kill("SIGKILL");
    await bounded(exited, "Codex forced shutdown", 2_000);
  }
}

async function runTurn(threadId, label, image, requireSkill = false, editStep = 0, redisplay = false) {
  const imageId = editStep ? latestImageId : undefined;
  if (editStep) assert.match(imageId, imageIdPattern, "An edit requires the preceding result handle");
  const priorChatImage = latestChatImage;
  if (redisplay) assert.ok(priorChatImage, "Redisplay requires a preceding delivered image");
  scenario = { label, image, requireSkill, steps: 0, providerCalls: 0, editStep, imageId, redisplay };
  const offset = client.events.length;
  const before = generationCount;
  const editsBefore = editCount;
  const callsBefore = imageCalls.length;
  const prompt = liveModel
    ? ["画一张蓝色圆形，纯白背景，正方形，生成图片。", "把刚才蓝色圆形改成红色，其他不变。", "把刚才红色圆形改成绿色，其他不变。"][editStep]
    : ["Generate a synthetic blue square.", "Edit the preceding blue square to red; preserve everything else.", "Edit the preceding red square to green; preserve everything else."][editStep];
  await client.call("turn/start", { threadId, input: [{ type: "text", text: redisplay ? "图呢，请在聊天中展示刚才那张原图。" : image ? prompt : "Save this synthetic pre-image thread.", text_elements: [] }] });
  const completed = await client.waitFor((event) => event.method === "turn/completed" && event.params.threadId === threadId, `${label} turn completion`, offset);
  if (serverError) throw serverError;
  assert.equal(completed.params.turn.status, "completed", JSON.stringify(completed.params.turn.error));
  if (!liveModel || (!image && !redisplay)) assert.equal(scenario.steps, image ? 3 : 1);
  assert.equal(generationCount - before, image ? 1 : 0, JSON.stringify(client.events.slice(offset)
    .filter((event) => event.method === "item/completed" && ["agentMessage", "commandExecution"].includes(event.params.item.type))
    .map((event) => ({ type: event.params.item.type, text: event.params.item.text,
      command: event.params.item.command, exitCode: event.params.item.exitCode,
      output: String(event.params.item.aggregatedOutput || "").slice(0, 1200) }))));
  const toolItems = client.events.slice(offset).filter((event) => event.method === "item/completed" && event.params.item.type === "mcpToolCall");
  let resultImageId;
  let chatImagePath;
  if (image) {
    const calls = imageCalls.slice(callsBefore);
    assert.equal(calls.length, 1, "Exactly one image tool call reaches the local MCP service");
    assert.equal(calls[0].request.params.name, editStep ? "edit_image" : "generate_image");
    assert.equal(calls[0].request.params.arguments.image_id, imageId, "Edit must use the exact preceding result handle");
    assert.equal(calls[0].response.result.isError, undefined, "Image tool returned an error");
    resultImageId = calls[0].response.result._meta?.["ccdx/image_id"];
    assert.match(resultImageId, imageIdPattern, "Production MCP result must return an image handle");
    assert.equal(knownImages.has(resultImageId), false, "Every edit and generation must return a fresh image handle");
    const returned = calls[0].response.result.content.find((part) => part.type === "image");
    assert.equal(returned?.data, pngs[editStep]);
    chatImagePath = calls[0].response.result._meta?.["ccdx/image_path"];
    if (withoutMcp) {
      assert.equal(calls[0].request.params._meta?.["ccdx/client_saves_image"], true, "Helper must declare its single local image save");
      assert.equal(chatImagePath, undefined, "MCP must not return a second delivery path when the helper saves the image");
    } else {
      assert.ok(typeof chatImagePath === "string" && path.isAbsolute(chatImagePath), "Production MCP result must return a saved absolute image path");
      assert.equal(path.dirname(chatImagePath), imageDirectory, "Replay image delivery must stay in its isolated output directory");
      assert.ok((await fs.lstat(chatImagePath)).isFile(), "Chat image must be a regular file");
      assert.equal((await fs.readFile(chatImagePath)).toString("base64"), returned.data, "Chat thumbnail file must contain the original generated image bytes");
      assert.equal(deliveredImages.has(chatImagePath), false, "Generation and edits must preserve earlier delivery files");
      deliveredImages.set(chatImagePath, returned.data);
    }
    knownImages.set(resultImageId, returned.data);
    latestImageId = resultImageId;
  }
  if (image && !withoutMcp) {
    assert.equal(toolItems.length, 1, "Exactly one completed native MCP image item");
    const item = toolItems[0].params.item;
    assert.equal(item.status, "completed");
    assert.ok(JSON.stringify(item.result).includes(pngs[editStep]), "Native image content missing from completed MCP item");
    assert.ok(JSON.stringify(item.result).includes(resultImageId), "Image handle missing from completed native MCP item");
  }
  if (liveModel) {
    const commands = client.events.slice(offset).filter((event) => event.method === "item/started" && event.params.item.type === "commandExecution");
    assert.ok(commands.every((event) => !/\b(?:python\d*|pip\d*|uv|curl|wget)\b|image_gen\.py/i.test(event.params.item.command || "")), "Live model attempted a Python/SDK/alternate HTTP fallback");
    if (image && withoutMcp) {
      assert.equal(toolItems.length, 0, "Missing-MCP scenario must exercise the Node helper");
      const succeeded = client.events.slice(offset).filter((event) => event.method === "item/completed"
        && event.params.item.type === "commandExecution"
        && event.params.item.exitCode === 0
        && helperCommandArguments(event.params.item.command, event.params.item.cwd || cwd));
      assert.equal(succeeded.length, 1, "Exactly one successful literal image-helper execution");
      const helperArgs = helperCommandArguments(succeeded[0].params.item.command, succeeded[0].params.item.cwd || cwd);
      assert.equal(helperArgs.imageId, imageId, "Helper must use --image-id with the exact preceding result handle");
      assert.ok(String(succeeded[0].params.item.aggregatedOutput || "").includes(`CCDX image_id: ${resultImageId}`), "Helper must report the reusable image handle");
      const files = (await fs.readdir(cwd, { recursive: true })).filter((file) => /\.(?:png|jpe?g|webp)$/i.test(file));
      assert.equal(files.length, savedImages.size + 1, "Each turn saves exactly one new image and preserves existing images");
      for (const [file, data] of savedImages) assert.equal((await fs.readFile(file)).toString("base64"), data, "Editing must not change any earlier saved image");
      const reportedPaths = String(succeeded[0].params.item.aggregatedOutput || "").split(/\r?\n/).map((line) => line.trim())
        .filter((line) => path.isAbsolute(line) && /\.(?:png|jpe?g|webp)$/i.test(line));
      assert.equal(reportedPaths.length, 1, "Successful helper output must report its one saved absolute image path");
      const output = reportedPaths[0];
      assert.deepEqual(files.map((file) => path.join(cwd, file)).filter((file) => !savedImages.has(file)), [output], "Helper-reported path must be the only newly saved image");
      assert.ok((await fs.lstat(output)).isFile(), "Helper output must be a regular file");
      const metadata = await sharp(output).metadata();
      assert.equal(metadata.width, 1024);
      assert.equal(metadata.height, 1024);
      const data = (await fs.readFile(output)).toString("base64");
      assert.equal(data, pngs[editStep], "Helper must save the latest returned image");
      savedImages.set(output, data);
      chatImagePath = output;
    }
  }
  if (redisplay) {
    assert.equal(imageCalls.length, callsBefore, "Redisplay must not call generate_image or edit_image");
    assert.equal(editCount, editsBefore, "Redisplay must not dispatch an edit");
    assert.equal(latestImageId, priorChatImage.imageId, "Redisplay must retain the original image handle");
    chatImagePath = priorChatImage.filePath;
  }
  if (image || redisplay) {
    const finalItem = client.events.slice(offset).filter((event) => event.method === "item/completed" && event.params.item.type === "agentMessage").at(-1)?.params.item;
    const finalText = String(finalItem?.text || "");
    assert.ok(displayedImagePaths(finalText).includes(chatImagePath), `Final assistant reply did not embed the actual saved image: ${finalText.slice(0, 1800)}`);
    for (const [file, data] of [...deliveredImages, ...savedImages]) {
      assert.equal((await fs.readFile(file)).toString("base64"), data, "Generation, editing and redisplay must preserve prior image bytes");
    }
    if (withoutMcp) {
      const mcpFiles = await fs.readdir(imageDirectory).catch((error) => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
      assert.equal(mcpFiles.length, 0, "Helper generation and redisplay must not create a duplicate MCP image file");
    } else assert.equal((await fs.readdir(imageDirectory)).length, deliveredImages.size, "Redisplay must not create another image delivery file");
    if (image) {
      const markdown = finalText.match(/!\[[^\]\r\n]*\]\(\s*(?:<[^>\r\n]+>|[^\s)]+)\s*\)/g)?.find((value) => displayedImagePaths(value).includes(chatImagePath));
      latestChatImage = { imageId: resultImageId, filePath: chatImagePath, markdown };
    }
  }
  summaries.push({ scenario: label, modelRequests: scenario.steps, imageCalls: generationCount - before, edit: Boolean(editStep), nativeImageResult: image && !withoutMcp, savedImage: image && withoutMcp, finalChatImage: image || redisplay, ...(redisplay ? { redisplay: true } : {}), ...(image ? { imageId: resultImageId, ...(imageId ? { sourceImageId: imageId } : {}) } : {}) });
  scenario = null;
}

try {
  await fs.mkdir(home);
  await fs.mkdir(cwd);
  const options = { cwd, env: runtimeEnv(), encoding: "utf8", timeout: timeoutMs, stdio: ["ignore", "pipe", "pipe"] };
  const version = execFileSync(codex, ["--version"], options).trim();
  catalog = JSON.parse(execFileSync(codex, ["debug", "models", "--bundled"], { ...options, maxBuffer: 8 * 1024 * 1024 }));
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  const base = `model = ${JSON.stringify(model)}\nmodel_provider = "replay"\ncheck_for_update_on_startup = false\n[model_providers.replay]\nname = "CCDX image replay"\nbase_url = "http://127.0.0.1:${port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\nrequest_max_retries = 0\nstream_max_retries = 0\n[features]\nshell_snapshot = false\n[analytics]\nenabled = false\n[feedback]\nenabled = false\n`;
  await fs.writeFile(codexPath, withoutMcp ? `${base}[sandbox_workspace_write]\nwritable_roots = [${JSON.stringify(cwd)}]\nnetwork_access = false\nexclude_tmpdir_env_var = true\nexclude_slash_tmp = true\n` : base);
  if (liveModel) {
    // Reproduce the installed App skill alongside the CCDX skill without modifying either installed location.
    const builtinImagegen = path.join(os.homedir(), ".codex", "skills", ".system", "imagegen");
    await fs.access(path.join(builtinImagegen, "SKILL.md"));
    await fs.cp(builtinImagegen, path.join(home, "skills", ".system", "imagegen"), { recursive: true });
    if (!withoutMcp) {
      await fs.writeFile(codexPath, computeImageMcpCodexConfig(base, { enabled: true, adapterPort: port }).content);
      await updateImageSkill({ enabled: true, codexPath, adapterPort: port, adapterHost: "127.0.0.1" });
    }
    await startClient();
    const listed = await client.call("skills/list", { cwds: [cwd], forceReload: true });
    const skills = listed.data.flatMap((entry) => entry.skills).filter((skill) => skill.enabled).map((skill) => skill.name);
    assert.equal(skills.includes("ccdx-image"), !withoutMcp, "Managed skill registration must match the setup stage");
    assert.ok(skills.includes("imagegen"), "Live routing check requires coexistence with built-in imagegen skill");
    const fresh = await client.call("thread/start", { cwd, model, modelProvider: "replay", approvalPolicy: "on-request", sandbox: withoutMcp ? "workspace-write" : "read-only" });
    if (withoutMcp) {
      const servers = await client.call("mcpServerStatus/list", { threadId: fresh.thread.id });
      assert.ok(servers.data.every((entry) => entry.name !== "ccdx_image"), "Stale helper scenario must have no image MCP registration");
      await runTurn(fresh.thread.id, "preexisting_thread_without_image", false);
      await updateImageSkill({ enabled: true, codexPath, adapterPort: port, adapterHost: "127.0.0.1" });
    }
    await runTurn(fresh.thread.id, withoutMcp ? "stale_task_without_mcp_live_selection" : "natural_language_live_selection", true, withoutMcp);
    await runTurn(fresh.thread.id, "natural_language_original_redisplay", false, false, 0, true);
    if (editing) {
      await runTurn(fresh.thread.id, "natural_language_first_edit", true, false, 1);
      await runTurn(fresh.thread.id, "natural_language_second_edit", true, false, 2);
      assert.equal(editCount, 2, "Natural-language edit chain must issue exactly two edits");
    }
    console.log(JSON.stringify({ version, liveModel, withoutMcp, editing, localAdapter: "127.0.0.1:2026", syntheticPixels: true, builtinSkillCoexists: true, upstreamCount, generationCount, editCount, fixtureApprovals, helperApprovals, summaries }, null, 2));
    console.log(editing
      ? "PASS: real model delivered and edited CCDX images with final chat Markdown, correct handles, and zero-call original redisplay."
      : "PASS: real model selected CCDX once, embedded its saved image in final chat Markdown, and redisplayed the original without an image call.");
  } else {
  await startClient();
  const started = await client.call("thread/start", { cwd, model: "gpt-5.5", modelProvider: "replay", approvalPolicy: "on-request", sandbox: "read-only", experimentalRawEvents: false });
  const threadId = started.thread.id;
  const disabled = await client.call("mcpServerStatus/list", { threadId });
  assert.equal(disabled.data.some((entry) => entry.name === "ccdx_image"), false);
  await runTurn(threadId, "before_enable", false);

  await fs.writeFile(codexPath, computeImageMcpCodexConfig(base, { enabled: true, adapterPort: port }).content);
  await updateImageSkill({ enabled: true, codexPath, adapterPort: port, adapterHost: "127.0.0.1" });
  await runTurn(threadId, "skill_installed_before_mcp_reload", false, true);
  await client.call("config/mcpServer/reload", {});
  const skills = await client.call("skills/list", { cwds: [cwd], forceReload: true });
  assert.ok(skills.data.flatMap((entry) => entry.skills).some((skill) => skill.name === "ccdx-image" && skill.enabled), "Installed Codex must discover the managed CCDX image skill");
  const enabled = await client.call("mcpServerStatus/list", { threadId });
  const imageServer = enabled.data.find((entry) => entry.name === "ccdx_image");
  assert.ok(imageServer && Object.values(imageServer.tools).some((tool) => tool.name === "generate_image"), "Reloaded Codex must discover production MCP image tool");
  if (editing) assert.ok(Object.values(imageServer.tools).some((tool) => tool.name === "edit_image"), "Reloaded Codex must discover production MCP edit tool for the eligible provider");
  await runTurn(threadId, "same_thread_after_reload", true);
  await runTurn(threadId, "same_thread_original_redisplay", false, false, 0, true);
  if (editing) await runTurn(threadId, "same_thread_first_edit", true, false, 1);

  await stopClient();
  await startClient();
  await client.call("thread/resume", { threadId, cwd, modelProvider: "replay", approvalPolicy: "on-request", sandbox: "read-only" });
  await runTurn(threadId, editing ? "saved_thread_second_edit_after_restart" : "saved_thread_after_restart", true, false, editing ? 2 : 0);
  const read = await client.call("thread/read", { threadId, includeTurns: true });
  assert.equal(read.thread.turns.length, editing ? 6 : 5, "Saved original thread retains every completed turn");
  const fresh = await client.call("thread/start", { cwd, model: "gpt-5.5", modelProvider: "replay", approvalPolicy: "on-request", sandbox: "read-only" });
  await runTurn(fresh.thread.id, "new_thread_enabled", true);
  if (editing) assert.equal(editCount, 2, "Offline edit chain must issue exactly two edits");
  console.log(JSON.stringify({ version, offline: true, editing, skillDiscovered: true, mcpReload: true, upstreamCount, generationCount, editCount, fixtureApprovals, summaries }, null, 2));
  console.log(editing
    ? "PASS: installed Codex generated and edited twice with final chat image Markdown, zero-call redisplay, and preserved handles through saved-task resume."
    : "PASS: installed Codex discovers CCDX images and preserves native output, final chat image Markdown, and zero-call redisplay through task reload/resume.");
  }
} catch (error) {
  throw new Error(`${serverError?.message || error.message}\n${stderr}`, { cause: error });
} finally {
  try { await stopClient(); } finally {
    server.closeAllConnections();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
}
