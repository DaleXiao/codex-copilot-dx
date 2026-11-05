import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { StringDecoder } from "node:string_decoder";

export const IMAGE_HOST_NAMESPACE = "ccdx_images";
export const IMAGE_HOST_TOOL = Object.freeze({
  type: "namespace", name: IMAGE_HOST_NAMESPACE,
  description: "Codex host image generation and editing through CCDX. Generated images appear in the native image gallery.",
  tools: [{ type: "function", name: "imagegen", deferLoading: false,
    description: "Generate an image or edit reference images. Use this host tool for image requests in this chat. Edit defaults to the last generated image when no references are supplied. Results include native image content and a saved local file.",
    inputSchema: { type: "object", additionalProperties: false, required: ["mode", "prompt"], properties: {
      mode: { type: "string", enum: ["generate", "edit"] }, prompt: { type: "string" },
      transparent_background: { type: "boolean" },
      referenced_image_paths: { type: "array", maxItems: 5, items: { type: "string" }, description: "Images within this workspace, attached by the user, or generated in this chat." },
      num_last_images_to_include: { type: "integer", minimum: 0, maximum: 5 },
      quality: { type: "string", enum: ["auto", "low", "medium", "high"] },
      size: { type: "string", enum: ["auto", "1024x1024", "1536x1024", "1024x1536"] },
    } } }],
});

export function addImageHostTool(params) {
  const existing = params.dynamicTools || [];
  if (!Array.isArray(existing) || existing.some(tool => tool?.name === IMAGE_HOST_NAMESPACE)) {
    throw new Error("The CCDX image host namespace is already configured");
  }
  return { ...params, dynamicTools: [...existing, IMAGE_HOST_TOOL] };
}

export function imageHostBaseUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    || url.pathname !== "/v1" || url.username || url.password || url.search || url.hash) {
    throw new Error("Image host requires the local CCDX /v1 endpoint");
  }
  return url.href.replace(/\/$/, "");
}

async function boundedJson(response) {
  let size = 0;const chunks = [];
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 48 * 1024 * 1024) throw new Error("Image backend response exceeds its limit");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function imageType(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return ["png", "image/png"];
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return ["jpg", "image/jpeg"];
  if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return ["webp", "image/webp"];
  throw new Error("The image backend did not return a supported image");
}

const inside = (root, file) => file === root || file.startsWith(root + path.sep);

export function createImageHostBridge({ baseUrl, codexHome, sendToCodex, fetchImpl = fetch, imageEnabled,
  now = Date.now } = {}) {
  baseUrl = imageHostBaseUrl(baseUrl);
  const requests = new Map(), threads = new Map(), active = new Map();
  let experimental = false, sequence = 0;
  const root = path.join(codexHome, "generated_images", "ccdx");
  const folder = id => path.join(root, createHash("sha256").update(id).digest("hex").slice(0, 32));
  const enabled = imageEnabled || (async () => {
    try {
      const response = await fetchImpl(baseUrl.replace(/\/v1$/, "/_ccdx/ui/settings"), {
        headers: { "X-CCDX-Dashboard": "1" }, signal: AbortSignal.timeout(1000),
      });
      if (!response.ok) return false;
      const settings = await boundedJson(response);return settings.features?.image?.enabled === true;
    } catch { return false; }
  });

  async function readReference(value, context, id) {
    if (value.startsWith("data:image/")) return value;
    let file;
    try {
      file = await fs.realpath(path.resolve(context.cwd, value));
      const own = await fs.realpath(folder(id)).catch(() => folder(id));
      const attached = await Promise.all(context.attachments.filter(v => !v.startsWith("data:")).map(v => fs.realpath(v).catch(() => null)));
      const roots = await Promise.all([context.cwd, ...context.roots].map(v => fs.realpath(v).catch(() => null)));
      const generated = await Promise.all(context.generated.map(v => fs.realpath(v).catch(() => null)));
      if (!inside(own, file) && !generated.includes(file) && !attached.includes(file)
        && !roots.some(v => v && inside(v, file))) throw new Error("scope");
      const stat = await fs.stat(file);
      if (!stat.isFile() || stat.size > 10 * 1024 * 1024) throw new Error("size");
      const bytes = await fs.readFile(file), [, mime] = imageType(bytes);
      return "data:" + mime + ";base64," + bytes.toString("base64");
    } catch { throw new Error("Reference images must be readable images in this workspace, user attachments, or this chat"); }
  }

  async function recentImages(id, context, count) {
    let disk = [];
    try { disk = (await fs.readdir(folder(id))).filter(v => /\.(png|jpg|webp)$/.test(v)).sort().map(v => path.join(folder(id), v)); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    return [...new Set([...disk, ...context.generated])].slice(-count);
  }

  async function runImage(params, signal) {
    const args = params.arguments;
    if (!args || typeof args !== "object" || Array.isArray(args) || !["generate", "edit"].includes(args.mode)
      || typeof args.prompt !== "string" || !args.prompt.trim()) throw new Error("Choose generate or edit and supply an image prompt");
    const id = params.threadId, context = threads.get(id);
    if (!context) throw new Error("Resume this chat through CCDX before using the image host");
    const references = args.referenced_image_paths || [];
    if (!Array.isArray(references) || references.some(v => typeof v !== "string") || references.length > 5) throw new Error("Choose up to five image references");
    const count = args.num_last_images_to_include;
    if (count !== undefined && (!Number.isInteger(count) || count < 0 || count > 5)) throw new Error("Choose zero to five recent images");
    const body = { model: "gpt-image-2", prompt: args.prompt,
      background: args.transparent_background === true ? "transparent" : "auto",
      quality: args.quality || "auto", size: args.size || "auto" };
    if (args.mode === "edit") {
      let selected = references.length ? references : context.attachments;
      if (count !== undefined ? count > 0 : !selected.length) selected = [...selected, ...await recentImages(id, context, count ?? 1)];
      if (!selected.length || selected.length > 5) throw new Error("Editing requires one to five images");
      body.images = await Promise.all(selected.map(async value => ({ image_url: await readReference(value, context, id) })));
    } else if (references.length || count) throw new Error("Use edit mode with image references");
    const response = await fetchImpl(baseUrl + "/images/" + (args.mode === "edit" ? "edits" : "generations"), {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal,
    });
    const result = await boundedJson(response);
    if (!response.ok) throw new Error(result.error?.message || "Image backend returned HTTP " + response.status);
    const pixels = result.data?.[0]?.b64_json;
    if (typeof pixels !== "string") throw new Error("Image backend returned no image");
    const bytes = Buffer.from(pixels, "base64");
    if (!bytes.length || bytes.length > 32 * 1024 * 1024 || bytes.toString("base64") !== pixels) throw new Error("Image backend returned invalid image data");
    const [ext, mime] = imageType(bytes);
    signal.throwIfAborted();
    const directory = folder(id);await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const savedPath = path.join(directory, String(now()).padStart(16, "0") + "-" + String(sequence++).padStart(6, "0") + "-" + randomUUID() + "." + ext);
    await fs.writeFile(savedPath, bytes, { mode: 0o600, flag: "wx" });
    if (signal.aborted) { await fs.unlink(savedPath);signal.throwIfAborted(); }
    context.generated.push(savedPath);
    return { success: true, contentItems: [{ type: "inputImage", imageUrl: "data:" + mime + ";base64," + pixels },
      { type: "inputText", text: JSON.stringify({ savedPath, model: response.headers.get("x-ccdx-image-model") || "selected GitHub image model" }) }] };
  }

  return {
    async client(message) {
      if (message.method === "initialize") experimental = message.params?.capabilities?.experimentalApi === true;
      if (["thread/start", "thread/resume", "thread/fork"].includes(message.method)) {
        requests.set(JSON.stringify(message.id), { method: message.method, params: message.params || {} });
        if (message.method === "thread/start" && experimental && await enabled()) return { ...message, params: addImageHostTool(message.params || {}) };
      }
      if (message.method === "turn/start") {
        const context = threads.get(message.params?.threadId);
        if (context) context.attachments = (message.params.input || []).flatMap(value => value.type === "localImage" ? [path.resolve(context.cwd, value.path)]
          : value.type === "image" && typeof value.url === "string" && value.url.startsWith("data:image/") ? [value.url] : []);
      }
      if (message.method === "turn/interrupt") for (const value of active.values()) if (value.threadId === message.params?.threadId) value.controller.abort(new Error("Image request cancelled"));
      return message;
    },
    codex(message) {
      const pending = requests.get(JSON.stringify(message.id));
      if (pending && !message.method) {
        requests.delete(JSON.stringify(message.id));const thread = message.result?.thread;
        if (thread?.id && thread.cwd) threads.set(thread.id, { cwd: thread.cwd, roots: pending.params.runtimeWorkspaceRoots || [], attachments: [], generated: [] });
      }
      if (message.method === "item/completed" && message.params?.item?.type === "imageGeneration" && message.params.item.savedPath) {
        threads.get(message.params.threadId)?.generated.push(message.params.item.savedPath);
      }
    if (message.id === undefined || message.method !== "item/tool/call" || message.params?.namespace !== IMAGE_HOST_NAMESPACE || message.params?.tool !== "imagegen") return false;
      const controller = new AbortController(), key = JSON.stringify(message.id);
      active.set(key, { controller, threadId: message.params.threadId });
      void runImage(message.params, AbortSignal.any([controller.signal, AbortSignal.timeout(180000)]))
        .then(result => sendToCodex({ id: message.id, result }))
        .catch(error => sendToCodex({ id: message.id, result: { success: false, contentItems: [{ type: "inputText", text: error.message }] } }))
        .finally(() => active.delete(key));
      return true;
    },
    close() { for (const value of active.values()) value.controller.abort(new Error("Image host closed")); },
  };
}

function lines(stream, accept) {
  const decoder = new StringDecoder("utf8");let buffer = "";
  const data = chunk => {
    buffer += decoder.write(chunk);let boundary;
    while ((boundary = buffer.indexOf("\n")) >= 0) { const line = buffer.slice(0, boundary);buffer = buffer.slice(boundary + 1);accept(line); }
  };
  const end = () => { buffer += decoder.end();if (buffer) accept(buffer); };
  stream.on("data", data);stream.on("end", end);
  return () => { stream.removeListener("data", data);stream.removeListener("end", end); };
}

export async function runCodexImageHost({ codex, argv, baseUrl, env = process.env, input = process.stdin, output = process.stdout, error = process.stderr, spawnImpl = spawn } = {}) {
  const args = argv || [], at = args.indexOf("app-server"), rest = args.slice(at + 1);
  const stdio = at >= 0 && !["daemon", "proxy", "generate-ts", "generate-json-schema"].includes(rest[0])
    && !rest.some(value => /^--listen=(?!stdio:\/\/)/.test(value))
    && (rest.indexOf("--listen") < 0 || rest[rest.indexOf("--listen") + 1] === "stdio://");
  const childEnv = { ...env, CODEX_APP_RUNTIME_CLI_PATH: codex };delete childEnv.CODEX_CLI_PATH;
  const child = spawnImpl(codex, args, { env: childEnv, stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.on("error", () => {});child.stderr.pipe(error, { end: false });
  let bridge, queue = Promise.resolve();const cleanups = [];
  const write = message => { if (!child.stdin.destroyed) child.stdin.write(JSON.stringify(message) + "\n"); };
  if (!stdio) { input.pipe(child.stdin);child.stdout.pipe(output, { end: false }); }
  else {
    bridge = createImageHostBridge({ baseUrl, codexHome: path.resolve(env.CODEX_HOME || path.join(env.HOME || process.env.HOME, ".codex")), sendToCodex: write });
    cleanups.push(lines(input, raw => {
      queue = queue.then(async () => {
        let message;try { message = JSON.parse(raw); } catch { child.stdin.write(raw + "\n");return; }
        try { const next = await bridge.client(message);if (next === message) child.stdin.write(raw + "\n");else write(next); }
        catch (failure) { output.write(JSON.stringify({ id: message.id, error: { code: -32602, message: failure.message } }) + "\n"); }
      });
    }));
    cleanups.push(lines(child.stdout, raw => { let value;try { value = JSON.parse(raw); } catch {}if (!value || !bridge.codex(value)) output.write(raw + "\n"); }));
    const end = () => { void queue.finally(() => { bridge.close();child.stdin.end(); }); };
    input.on("end", end);cleanups.push(() => input.removeListener("end", end));
  }
  const stop = signal => { bridge?.close();child.kill(signal); };
  const interrupt = () => stop("SIGINT"), terminate = () => stop("SIGTERM");
  process.once("SIGINT", interrupt);process.once("SIGTERM", terminate);
  try { const [code, signal] = await once(child, "exit");await queue;return code ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1); }
  finally { bridge?.close();for (const cleanup of cleanups) cleanup();input.unpipe(child.stdin);input.pause();process.removeListener("SIGINT", interrupt);process.removeListener("SIGTERM", terminate); }
}
