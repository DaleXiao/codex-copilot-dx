import { status } from "./status.mjs";

const IMG_MAX_DIM = Number.parseInt(process.env.CCDX_IMG_MAX_DIM || "2048", 10);
const IMG_QUALITY = Number.parseInt(process.env.CCDX_IMG_QUALITY || "85", 10);
const IMG_MIN_BYTES = Number.parseInt(process.env.CCDX_IMG_MIN_BYTES || "100000", 10);
const DEFAULT_IMG_CONCURRENCY = 4;
const IMG_MAX_CONCURRENCY = 12;
const IMG_OPT_DISABLED = process.env.CCDX_DISABLE_IMG_OPT === "1";
const IMG_CONCURRENCY = parseImageConcurrency(process.env.CCDX_IMG_CONCURRENCY);
let sharpImport = null;

export function parseImageConcurrency(value) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, IMG_MAX_CONCURRENCY) : DEFAULT_IMG_CONCURRENCY;
}

async function sharp() {
  sharpImport ||= import("sharp");
  const mod = await sharpImport;
  return mod.default || mod;
}

export async function optimizeImageDataUrl(dataUrl) {
  if (IMG_OPT_DISABLED) return dataUrl;
  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:")) return dataUrl;
  const match = /^data:(image\/[a-z+.-]+);base64,(.+)$/i.exec(dataUrl);
  if (!match) return dataUrl;
  const mime = match[1].toLowerCase();
  const raw = Buffer.from(match[2], "base64");
  if (raw.length < IMG_MIN_BYTES || mime.includes("gif")) return dataUrl;

  try {
    const resize = await sharp();
    const out = await resize(raw, { failOn: "none" })
      .rotate()
      .resize(IMG_MAX_DIM, IMG_MAX_DIM, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: IMG_QUALITY, effort: 4 })
      .toBuffer();
    const ratio = ((out.length / raw.length) * 100).toFixed(1);
    console.log(status("info", `image ${(raw.length / 1024).toFixed(0)}KB ${mime} -> ${(out.length / 1024).toFixed(0)}KB webp (${ratio}%)`));
    return `data:image/webp;base64,${out.toString("base64")}`;
  } catch (e) {
    console.warn(status("warn", `image optimize failed (${mime}, ${raw.length}b): ${e.message}`));
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

function visitImageParts(parts, tasks) {
  if (!Array.isArray(parts)) return;
  for (const part of parts) {
    if (!part) continue;
    if (part.type === "input_image" && typeof part.image_url === "string") {
      tasks.push(async () => { part.image_url = await optimizeImageDataUrl(part.image_url); });
    } else if (part.type === "image" && part.source?.type === "base64" && part.source?.data) {
      tasks.push(async () => {
        const dataUrl = `data:${part.source.media_type || "image/png"};base64,${part.source.data}`;
        const optimized = await optimizeImageDataUrl(dataUrl);
        const match = /^data:([^;]+);base64,(.+)$/.exec(optimized);
        if (match) {
          part.source.media_type = match[1];
          part.source.data = match[2];
        }
      });
    }
  }
}

export async function optimizeImagesInBody(reqBody) {
  if (IMG_OPT_DISABLED || !Array.isArray(reqBody.input)) return reqBody;
  const tasks = [];

  for (const item of reqBody.input) {
    if (!item) continue;
    if (item.type === "message" && Array.isArray(item.content)) {
      visitImageParts(item.content, tasks);
    }
    if (item.type === "function_call_output") {
      if (Array.isArray(item.output)) {
        visitImageParts(item.output, tasks);
      } else if (typeof item.output === "string") {
        const trimmed = item.output.trim();
        if (trimmed.startsWith("[")) {
          try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) {
              const localTasks = [];
              visitImageParts(parsed, localTasks);
              if (localTasks.length) {
                tasks.push(async () => {
                  await runWithConcurrency(localTasks, IMG_CONCURRENCY);
                  item.output = JSON.stringify(parsed);
                });
              }
            }
          } catch {
            // Leave non-JSON tool output untouched.
          }
        }
      }
    }
  }

  if (tasks.length) await runWithConcurrency(tasks, IMG_CONCURRENCY);
  return reqBody;
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
