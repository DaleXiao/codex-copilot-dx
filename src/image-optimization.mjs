import { createHash } from "node:crypto";
import {
  canonicalInlineImageIdentity,
  readResponsesImagePart,
  readResponsesToolOutputParts,
} from "./responses-content.mjs";
import { status } from "./status.mjs";

const DEFAULT_IMG_CONCURRENCY = 2;
const IMG_MAX_CONCURRENCY = 12;
const DEFAULT_IMG_MAX_INPUT_PIXELS = 40 * 1000 * 1000;
const DEFAULT_MAX_UPSTREAM_BODY_BYTES = 30 * 1024 * 1024;
const MAX_OPTIMIZED_IMAGE_DIGESTS = 4096;
const IMG_MAX_DIM = positiveInt(process.env.CCDX_IMG_MAX_DIM, 2048);
const IMG_QUALITY = positiveInt(process.env.CCDX_IMG_QUALITY, 82, 100);
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

export function imageConstraintsForModel(modelId, { maxDim = IMG_MAX_DIM } = {}) {
  const model = String(modelId || "").trim().toLowerCase();
  const maxLongEdge = Math.min(positiveInt(maxDim, IMG_MAX_DIM), IMG_MAX_DIM, 2048);
  const fullSizeGpt4 = /^(?:gpt-4o|gpt-4\.1)(?:$|-)/.test(model)
    && !/(?:^|-)(?:mini|nano)(?:$|-)/.test(model);
  const gpt5Mini = /^gpt-5-mini(?:$|-)/.test(model);

  if (fullSizeGpt4 || gpt5Mini) {
    return { maxLongEdge, maxShortEdge: Math.min(maxLongEdge, 768) };
  }
  if (/^gpt-5\.(?:4|5|6)(?:$|-)/.test(model)) {
    return { maxLongEdge, maxArea: 2_560_000 };
  }
  return { maxLongEdge };
}

export function fitImageDimensions(width, height, constraints = {}) {
  const sourceWidth = Number(width);
  const sourceHeight = Number(height);
  if (!(sourceWidth > 0) || !(sourceHeight > 0)) return null;

  const longEdge = Math.max(sourceWidth, sourceHeight);
  const shortEdge = Math.min(sourceWidth, sourceHeight);
  let scale = 1;
  if (constraints.maxLongEdge > 0) scale = Math.min(scale, constraints.maxLongEdge / longEdge);
  if (constraints.maxShortEdge > 0) scale = Math.min(scale, constraints.maxShortEdge / shortEdge);
  if (constraints.maxArea > 0) scale = Math.min(scale, Math.sqrt(constraints.maxArea / (sourceWidth * sourceHeight)));
  return {
    width: Math.max(1, Math.floor(sourceWidth * scale)),
    height: Math.max(1, Math.floor(sourceHeight * scale)),
  };
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

function imageOptimizationKey(digest, constraints, quality) {
  return [
    digest,
    constraints.maxLongEdge || "",
    constraints.maxShortEdge || "",
    constraints.maxArea || "",
    quality,
  ].join(":");
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
  model,
  signal,
} = {}) {
  if (IMG_OPT_DISABLED) return dataUrl;
  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:")) return dataUrl;
  const match = /^data:(image\/[a-z+.-]+);base64,(.+)$/i.exec(dataUrl);
  if (!match) return dataUrl;
  const mime = match[1].toLowerCase();
  const encoded = match[2];
  const inputBytes = Buffer.byteLength(encoded, "base64");
  if (mime.includes("gif")) return dataUrl;

  try {
    return await runGlobalImageTask(async () => {
      const raw = Buffer.from(encoded, "base64");
      const digest = imageDigest(raw);
      const constraints = imageConstraintsForModel(model, { maxDim });
      const outputQuality = positiveInt(quality, IMG_QUALITY, 100);
      const optimizationKey = imageOptimizationKey(digest, constraints, outputQuality);
      if (!force && touchOptimizedImage(optimizationKey)) return dataUrl;
      const resize = await sharp();
      const image = resize(raw, { failOn: "none", limitInputPixels: IMG_MAX_INPUT_PIXELS });
      const metadata = await image.metadata();
      const orientation = Number(metadata.orientation);
      const rotated = orientation >= 5 && orientation <= 8;
      const sourceWidth = rotated ? metadata.height : metadata.width;
      const sourceHeight = rotated ? metadata.width : metadata.height;
      const target = fitImageDimensions(sourceWidth, sourceHeight, constraints);
      const resizeRequired = target
        && (target.width < sourceWidth || target.height < sourceHeight);
      if (raw.length < IMG_MIN_BYTES && !resizeRequired) {
        rememberOptimizedImage(optimizationKey);
        return dataUrl;
      }
      const resizeOptions = target
        ? { ...target, fit: "inside", withoutEnlargement: true }
        : {
            width: constraints.maxLongEdge,
            height: constraints.maxLongEdge,
            fit: "inside",
            withoutEnlargement: true,
          };
      const out = await image
        .rotate()
        .resize(resizeOptions)
        .webp({ quality: outputQuality, effort: 4 })
        .toBuffer();
      if (signal?.aborted) throw abortError(signal);
      if (out.length >= raw.length) {
        rememberOptimizedImage(optimizationKey);
        return dataUrl;
      }
      rememberOptimizedImage(imageOptimizationKey(imageDigest(out), constraints, outputQuality));
      const ratio = ((out.length / raw.length) * 100).toFixed(1);
      console.log(status("info", `image ${(raw.length / 1024).toFixed(0)}KB ${mime} -> ${(out.length / 1024).toFixed(0)}KB webp (${ratio}%)`));
      return `data:image/webp;base64,${out.toString("base64")}`;
    }, { signal });
  } catch (e) {
    if (signal?.aborted || e?.name === "AbortError") throw e;
    if (inputBytes >= IMG_MIN_BYTES) {
      console.warn(status("warn", `image optimize failed (${mime}, ${inputBytes}b): ${e.message}`));
    }
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

function visitImageParts(parts, references, commit = null) {
  if (!Array.isArray(parts)) return;
  for (const part of parts) {
    const image = readResponsesImagePart(part);
    if (!image?.identity) continue;
    references.push({
      commit,
      get: () => image.dataUrl,
      set: (value) => image.setDataUrl(value),
    });
  }
}

function collectImageReferences(reqBody) {
  const references = [];
  const dirtyCommits = new Set();
  if (!Array.isArray(reqBody?.input)) {
    return { references, markDirty() {}, commitDirty() {} };
  }

  for (const item of reqBody.input) {
    if (!item) continue;
    visitImageParts([item], references);
    if (item.type === "message" && Array.isArray(item.content)) {
      visitImageParts(item.content, references);
    }
    const toolOutput = readResponsesToolOutputParts(item);
    if (toolOutput) {
      visitImageParts(toolOutput.parts, references, toolOutput.commit);
    }
  }

  return {
    references,
    markDirty(changedReferences) {
      for (const reference of changedReferences) {
        if (reference.commit) dirtyCommits.add(reference.commit);
      }
    },
    commitDirty() {
      for (const apply of dirtyCommits) apply();
      dirtyCommits.clear();
    },
  };
}

async function optimizeImageReferences(collection, {
  concurrency,
  model,
  optimizeImage,
  signal,
}) {
  const optimizedByDataUrl = new Map();
  const optimizeOnce = (dataUrl) => {
    const identity = canonicalInlineImageIdentity(dataUrl) || dataUrl;
    if (!optimizedByDataUrl.has(identity)) {
      optimizedByDataUrl.set(identity, Promise.resolve().then(() => optimizeImage(dataUrl, { model, signal })));
    }
    return optimizedByDataUrl.get(identity);
  };
  const tasks = collection.references.map((reference) => async () => {
    if (reference.set(await optimizeOnce(reference.get()))) collection.markDirty([reference]);
  });
  if (tasks.length) await runWithConcurrency(tasks, concurrency);
  collection.commitDirty();
}

function imageInputBytes(dataUrl) {
  if (typeof dataUrl !== "string") return 0;
  const match = /^data:image\/[a-z+.-]+;base64,(.+)$/i.exec(dataUrl);
  return match ? Buffer.byteLength(match[1], "base64") : 0;
}

function uniqueOriginalImages(references) {
  const unique = new Map();
  for (const reference of references) {
    const dataUrl = reference.get();
    const identity = canonicalInlineImageIdentity(dataUrl);
    if (!identity) continue;
    const inputBytes = imageInputBytes(dataUrl);
    if (inputBytes <= 0) continue;
    let image = unique.get(identity);
    if (!image) {
      image = { dataUrl, inputBytes, references: [] };
      unique.set(identity, image);
    }
    image.references.push(reference);
  }
  return [...unique.values()];
}

function currentImageWireBytes(image) {
  return image.references.reduce(
    (total, reference) => total + Buffer.byteLength(reference.get()),
    0,
  );
}

function orderImagesByCurrentWireBytes(images) {
  return [...images].sort((left, right) => (
    currentImageWireBytes(right) - currentImageWireBytes(left)
      || right.inputBytes - left.inputBytes
  ));
}

function applyImageCandidate(collection, image, candidate, bodyBytes) {
  if (!canonicalInlineImageIdentity(candidate)) {
    return { bodyBytes, changed: false };
  }
  const previous = image.references.map((reference) => reference.get());
  if (previous.every((value) => value === candidate)) return { bodyBytes, changed: false };
  // Base64 data URLs need no JSON escaping, so their byte delta also applies to the serialized body.
  const candidateBytes = Buffer.byteLength(candidate);
  const byteDelta = previous.reduce(
    (delta, value) => delta + candidateBytes - Buffer.byteLength(value),
    0,
  );
  if (byteDelta >= 0) return { bodyBytes, changed: false };
  const changedReferences = [];
  for (const reference of image.references) {
    if (reference.set(candidate)) changedReferences.push(reference);
  }
  collection.markDirty(changedReferences);
  return { bodyBytes: bodyBytes + byteDelta, changed: true };
}

function normalizeCurrentInputStart(value, reqBody) {
  const parsed = Number.parseInt(value, 10);
  const itemCount = Array.isArray(reqBody?.input) ? reqBody.input.length : 0;
  return Number.isFinite(parsed) && parsed >= 0 ? Math.min(parsed, itemCount) : 0;
}

export async function optimizeImagesInBody(reqBody, {
  concurrency = IMG_CONCURRENCY,
  optimizeImage = optimizeImageDataUrl,
  signal,
} = {}) {
  if (IMG_OPT_DISABLED || !Array.isArray(reqBody.input)) return reqBody;
  const collection = collectImageReferences(reqBody);
  await optimizeImageReferences(collection, {
    concurrency,
    model: reqBody.model,
    optimizeImage,
    signal,
  });
  return reqBody;
}

export async function prepareResponsesPayload(reqBody, {
  currentInputStart = 0,
  maxBytes = MAX_UPSTREAM_BODY_BYTES,
  optimizeImage = optimizeImageDataUrl,
  profiles = OVERSIZE_IMAGE_PROFILES,
  skipInitialOptimization = false,
  signal,
} = {}) {
  const shouldOptimizeImages = !IMG_OPT_DISABLED && !skipInitialOptimization;
  const collection = shouldOptimizeImages ? collectImageReferences(reqBody) : null;
  const originalImages = collection ? uniqueOriginalImages(collection.references) : [];
  if (collection) {
    await optimizeImageReferences(collection, {
      concurrency: IMG_CONCURRENCY,
      model: reqBody.model,
      optimizeImage: (dataUrl, options) => optimizeImage(dataUrl, { ...options, quality: IMG_QUALITY }),
      signal,
    });
  }
  let bodyText = JSON.stringify(reqBody);
  let bodyBytes = Buffer.byteLength(bodyText);
  const summary = summarizeReqBody(reqBody);
  const targetBytes = positiveInt(maxBytes, MAX_UPSTREAM_BODY_BYTES);
  let adapted = false;
  let stage = skipInitialOptimization ? "preoptimized" : `q${IMG_QUALITY}`;

  if (collection && originalImages.length > 0 && bodyBytes > targetBytes) {
    const batchSize = Math.max(1, IMG_CONCURRENCY);
    for (const profile of Array.isArray(profiles) ? profiles : []) {
      const beforeBytes = bodyBytes;
      let processed = 0;
      stage = `q${positiveInt(profile.quality, IMG_QUALITY, 100)}`;
      const orderedImages = orderImagesByCurrentWireBytes(originalImages);
      for (let index = 0; index < orderedImages.length && bodyBytes > targetBytes; index += batchSize) {
        const batch = orderedImages.slice(index, index + batchSize);
        const candidates = await Promise.all(batch.map((image) => optimizeImage(image.dataUrl, {
          ...profile,
          force: true,
          model: reqBody.model,
          signal,
        })));
        for (let offset = 0; offset < batch.length && bodyBytes > targetBytes; offset += 1) {
          processed += 1;
          const applied = applyImageCandidate(collection, batch[offset], candidates[offset], bodyBytes);
          bodyBytes = applied.bodyBytes;
          adapted ||= applied.changed;
          if (bodyBytes <= targetBytes) {
            collection.commitDirty();
            bodyText = JSON.stringify(reqBody);
            bodyBytes = Buffer.byteLength(bodyText);
          }
        }
      }
      collection.commitDirty();
      bodyText = JSON.stringify(reqBody);
      bodyBytes = Buffer.byteLength(bodyText);
      console.warn(status("warn", `responses payload ${beforeBytes}b exceeds ${targetBytes}b; image profile max_dim=${profile.maxDim} quality=${profile.quality} processed=${processed}/${orderedImages.length} -> ${bodyBytes}b`));
      if (bodyBytes <= targetBytes) break;
    }
  }

  return {
    bodyText,
    bodyBytes,
    summary,
    adapted,
    stage,
    targetBytes,
    overBudget: bodyBytes > targetBytes,
    currentInputStart: normalizeCurrentInputStart(currentInputStart, reqBody),
  };
}

export function summarizeReqBody(reqBody) {
  try {
    const input = reqBody.input;
    if (!Array.isArray(input)) return { items: 0, images: 0 };
    let images = 0;
    const countImages = (parts) => {
      if (!Array.isArray(parts)) return;
      for (const part of parts) {
        if (["input_image", "image", "image_url"].includes(part?.type)) images += 1;
      }
    };

    for (const item of input) {
      if (["input_image", "image", "image_url"].includes(item?.type)) countImages([item]);
      if (item?.type === "message") countImages(item.content);
      const toolOutput = readResponsesToolOutputParts(item);
      if (toolOutput) countImages(toolOutput.parts);
    }

    return { items: input.length, images };
  } catch {
    return { items: -1, images: -1 };
  }
}
