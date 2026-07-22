import { createHash } from "node:crypto";
import { status } from "./status.mjs";

const DEFAULT_IMG_CONCURRENCY = 2;
const IMG_MAX_CONCURRENCY = 12;
const DEFAULT_IMG_MAX_INPUT_PIXELS = 40 * 1000 * 1000;
const DEFAULT_MAX_UPSTREAM_BODY_BYTES = 30 * 1024 * 1024;
const MAX_OPTIMIZED_IMAGE_DIGESTS = 4096;
const IMG_MAX_DIM = positiveInt(process.env.CCDX_IMG_MAX_DIM, 2048);
const IMG_QUALITY = positiveInt(process.env.CCDX_IMG_QUALITY, 85, 100);
const IMG_MIN_BYTES = nonNegativeInt(process.env.CCDX_IMG_MIN_BYTES, 100000);
const IMG_MAX_INPUT_PIXELS = positiveInt(process.env.CCDX_IMG_MAX_INPUT_PIXELS, DEFAULT_IMG_MAX_INPUT_PIXELS);
const MAX_UPSTREAM_BODY_BYTES = positiveInt(process.env.CCDX_MAX_UPSTREAM_BODY_BYTES, DEFAULT_MAX_UPSTREAM_BODY_BYTES);
const IMG_OPT_DISABLED = process.env.CCDX_DISABLE_IMG_OPT === "1";
const IMG_CONCURRENCY = parseImageConcurrency(process.env.CCDX_IMG_CONCURRENCY);
const OVERSIZE_IMAGE_PROFILES = [
  { maxDim: Math.min(IMG_MAX_DIM, 1600), quality: Math.min(IMG_QUALITY, 75) },
  { maxDim: Math.min(IMG_MAX_DIM, 1280), quality: Math.min(IMG_QUALITY, 65) },
];
const optimizedImageDigests = new Set();
let sharpImport = null;

function positiveInt(value, fallback, max = Number.MAX_SAFE_INTEGER) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : fallback;
}

function nonNegativeInt(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function parseImageConcurrency(value) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, IMG_MAX_CONCURRENCY) : DEFAULT_IMG_CONCURRENCY;
}

function abortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

export function createTaskLimiter(concurrency) {
  const limit = parseImageConcurrency(concurrency);
  const queue = [];
  let active = 0;

  const drain = () => {
    while (active < limit && queue.length) {
      const entry = queue.shift();
      if (entry.cancelled) continue;
      entry.cleanup();
      if (entry.signal?.aborted) {
        entry.reject(abortError(entry.signal));
        continue;
      }
      active += 1;
      entry.resolve();
    }
  };

  const runLimited = async function runLimited(task, { signal } = {}) {
    if (signal?.aborted) throw abortError(signal);
    await new Promise((resolve, reject) => {
      const entry = {
        cancelled: false,
        cleanup: () => signal?.removeEventListener("abort", onAbort),
        reject,
        resolve,
        signal,
      };
      const onAbort = () => {
        entry.cancelled = true;
        entry.cleanup();
        reject(abortError(signal));
        drain();
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      queue.push(entry);
      if (signal?.aborted) onAbort();
      else drain();
    });

    try {
      if (signal?.aborted) throw abortError(signal);
      return await task();
    } finally {
      active -= 1;
      drain();
    }
  };
  runLimited.stats = () => ({
    active,
    queued: queue.reduce((count, entry) => count + (entry.cancelled ? 0 : 1), 0),
    limit,
  });
  return runLimited;
}

const runGlobalImageTask = createTaskLimiter(IMG_CONCURRENCY);

export function imageOptimizationStats() {
  return {
    ...runGlobalImageTask.stats(),
    disabled: IMG_OPT_DISABLED,
    cache_entries: optimizedImageDigests.size,
    sharp_loaded: sharpImport !== null,
  };
}

async function sharp() {
  sharpImport ||= import("sharp");
  const mod = await sharpImport;
  return mod.default || mod;
}

function imageDigest(raw) {
  return createHash("sha256").update(raw).digest("base64url");
}

function touchOptimizedImage(digest) {
  if (!optimizedImageDigests.delete(digest)) return false;
  optimizedImageDigests.add(digest);
  return true;
}

function rememberOptimizedImage(digest) {
  optimizedImageDigests.delete(digest);
  optimizedImageDigests.add(digest);
  if (optimizedImageDigests.size > MAX_OPTIMIZED_IMAGE_DIGESTS) {
    optimizedImageDigests.delete(optimizedImageDigests.values().next().value);
  }
}

export async function optimizeImageDataUrl(dataUrl, {
  maxDim = IMG_MAX_DIM,
  quality = IMG_QUALITY,
  force = false,
  signal,
} = {}) {
  if (IMG_OPT_DISABLED) return dataUrl;
  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:")) return dataUrl;
  const match = /^data:(image\/[a-z+.-]+);base64,(.+)$/i.exec(dataUrl);
  if (!match) return dataUrl;
  const mime = match[1].toLowerCase();
  const encoded = match[2];
  const inputBytes = Buffer.byteLength(encoded, "base64");
  if (inputBytes < IMG_MIN_BYTES || mime.includes("gif")) return dataUrl;

  try {
    return await runGlobalImageTask(async () => {
      const raw = Buffer.from(encoded, "base64");
      if (raw.length < IMG_MIN_BYTES) return dataUrl;
      const digest = imageDigest(raw);
      if (!force && touchOptimizedImage(digest)) return dataUrl;
      const resize = await sharp();
      const image = resize(raw, { failOn: "none", limitInputPixels: IMG_MAX_INPUT_PIXELS });
      const out = await image
        .rotate()
        .resize(positiveInt(maxDim, IMG_MAX_DIM), positiveInt(maxDim, IMG_MAX_DIM), { fit: "inside", withoutEnlargement: true })
        .webp({ quality: positiveInt(quality, IMG_QUALITY, 100), effort: 4 })
        .toBuffer();
      if (signal?.aborted) throw abortError(signal);
      if (out.length >= raw.length) {
        rememberOptimizedImage(digest);
        return dataUrl;
      }
      rememberOptimizedImage(imageDigest(out));
      const ratio = ((out.length / raw.length) * 100).toFixed(1);
      console.log(status("info", `image ${(raw.length / 1024).toFixed(0)}KB ${mime} -> ${(out.length / 1024).toFixed(0)}KB webp (${ratio}%)`));
      return `data:image/webp;base64,${out.toString("base64")}`;
    }, { signal });
  } catch (e) {
    if (signal?.aborted || e?.name === "AbortError") throw e;
    console.warn(status("warn", `image optimize failed (${mime}, ${inputBytes}b): ${e.message}`));
    return dataUrl;
  }
}

export async function runWithConcurrency(taskFns, concurrency) {
  if (!Array.isArray(taskFns) || taskFns.length === 0) return;
  const limit = Math.min(parseImageConcurrency(concurrency), taskFns.length);
  let next = 0;
  await Promise.all(Array.from({ length: limit }, async () => {
    while (next < taskFns.length) {
      const task = taskFns[next++];
      await task();
    }
  }));
}

function visitImageParts(parts, tasks, optimizeImage) {
  if (!Array.isArray(parts)) return;
  for (const part of parts) {
    if (!part) continue;
    if (part.type === "input_image" && typeof part.image_url === "string") {
      tasks.push(async () => { part.image_url = await optimizeImage(part.image_url); });
    } else if (part.type === "image" && part.source?.type === "base64" && part.source?.data) {
      tasks.push(async () => {
        const dataUrl = `data:${part.source.media_type || "image/png"};base64,${part.source.data}`;
        const optimized = await optimizeImage(dataUrl);
        const match = /^data:([^;]+);base64,(.+)$/.exec(optimized);
        if (match) {
          part.source.media_type = match[1];
          part.source.data = match[2];
        }
      });
    }
  }
}

export async function optimizeImagesInBody(reqBody, {
  concurrency = IMG_CONCURRENCY,
  optimizeImage = optimizeImageDataUrl,
  signal,
} = {}) {
  if (IMG_OPT_DISABLED || !Array.isArray(reqBody.input)) return reqBody;
  const tasks = [];
  const finalize = [];
  const optimizedByDataUrl = new Map();
  const optimizeOnce = (dataUrl) => {
    if (!optimizedByDataUrl.has(dataUrl)) {
      optimizedByDataUrl.set(dataUrl, Promise.resolve().then(() => optimizeImage(dataUrl, { signal })));
    }
    return optimizedByDataUrl.get(dataUrl);
  };

  for (const item of reqBody.input) {
    if (!item) continue;
    if (item.type === "message" && Array.isArray(item.content)) {
      visitImageParts(item.content, tasks, optimizeOnce);
    }
    if (item.type === "function_call_output") {
      if (Array.isArray(item.output)) {
        visitImageParts(item.output, tasks, optimizeOnce);
      } else if (typeof item.output === "string") {
        const trimmed = item.output.trim();
        if (trimmed.startsWith("[")) {
          try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) {
              const taskCount = tasks.length;
              visitImageParts(parsed, tasks, optimizeOnce);
              if (tasks.length > taskCount) finalize.push(() => { item.output = JSON.stringify(parsed); });
            }
          } catch {
            // Leave non-JSON tool output untouched.
          }
        }
      }
    }
  }

  if (tasks.length) await runWithConcurrency(tasks, concurrency);
  for (const apply of finalize) apply();
  return reqBody;
}

export async function prepareResponsesPayload(reqBody, {
  maxBytes = MAX_UPSTREAM_BODY_BYTES,
  profiles = OVERSIZE_IMAGE_PROFILES,
  signal,
} = {}) {
  await optimizeImagesInBody(reqBody, { signal });
  let bodyText = JSON.stringify(reqBody);
  let bodyBytes = Buffer.byteLength(bodyText);
  const summary = summarizeReqBody(reqBody);
  const targetBytes = positiveInt(maxBytes, MAX_UPSTREAM_BODY_BYTES);
  let adapted = false;

  if (!IMG_OPT_DISABLED && summary.images > 0 && bodyBytes > targetBytes) {
    for (const profile of profiles) {
      const beforeBytes = bodyBytes;
      bodyText = "";
      await optimizeImagesInBody(reqBody, {
        optimizeImage: (dataUrl) => optimizeImageDataUrl(dataUrl, { ...profile, force: true, signal }),
        signal,
      });
      bodyText = JSON.stringify(reqBody);
      bodyBytes = Buffer.byteLength(bodyText);
      adapted ||= bodyBytes < beforeBytes;
      console.warn(status("warn", `responses payload ${beforeBytes}b exceeds ${targetBytes}b; image profile max_dim=${profile.maxDim} quality=${profile.quality} -> ${bodyBytes}b`));
      if (bodyBytes <= targetBytes) break;
    }
  }

  return { bodyText, bodyBytes, summary, adapted };
}

export function summarizeReqBody(reqBody) {
  try {
    const input = reqBody.input;
    if (!Array.isArray(input)) return { items: 0, images: 0 };
    let images = 0;
    const countImages = (parts) => {
      if (!Array.isArray(parts)) return;
      for (const part of parts) {
        if (part?.type === "input_image" || part?.type === "image") images += 1;
      }
    };

    for (const item of input) {
      if (item?.type === "message") countImages(item.content);
      if (item?.type === "function_call_output") {
        if (Array.isArray(item.output)) {
          countImages(item.output);
        } else if (typeof item.output === "string" && item.output.trim().startsWith("[")) {
          try {
            const parsed = JSON.parse(item.output);
            if (Array.isArray(parsed)) countImages(parsed);
          } catch {
            // Ignore non-JSON tool output.
          }
        }
      }
    }

    return { items: input.length, images };
  } catch {
    return { items: -1, images: -1 };
  }
}
