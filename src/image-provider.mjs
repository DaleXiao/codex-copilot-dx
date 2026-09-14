import dns from "node:dns/promises";
import https from "node:https";
import net from "node:net";

export const IMAGE_MAX_BYTES = 32 * 1024 * 1024;
export const IMAGE_GENERATION_TIMEOUT_MS = 180_000;
export const IMAGE_DOWNLOAD_TIMEOUT_MS = 60_000;
export const IMAGE_SIZES = new Set(["1024x1024", "1536x1024", "1024x1536"]);

function providerError(message, code = "ccdx_image_provider_error") {
  const error = new Error(message);
  error.code = code;
  return error;
}

function checkedPrompt(value) {
  const prompt = String(value || "").trim();
  if (!prompt) throw providerError("Image prompt is required", "ccdx_image_prompt_required");
  if (prompt.length > 16_000) throw providerError("Image prompt exceeds 16000 characters", "ccdx_image_prompt_too_large");
  return prompt;
}

function checkedSize(value) {
  const size = String(value || "1024x1024").trim().toLowerCase();
  if (!IMAGE_SIZES.has(size)) {
    throw providerError(`Image size must be one of: ${[...IMAGE_SIZES].join(", ")}`, "ccdx_image_size_invalid");
  }
  return size;
}

function generationBody(config, prompt, size) {
  if (config.protocol === "qwen-messages") {
    return {
      model: config.model,
      input: { messages: [{ role: "user", content: [{ text: prompt }] }] },
      parameters: { n: 1, size: size.replace("x", "*"), watermark: false },
    };
  }
  return { model: config.model, prompt, n: 1, size };
}

async function boundedJson(response) {
  const maxBytes = 48 * 1024 * 1024;
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw providerError("Image API response was too large");
  const reader = response.body?.getReader?.();
  let text;
  if (!reader) {
    text = await response.text();
    if (Buffer.byteLength(text) > maxBytes) throw providerError("Image API response was too large");
  } else {
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => {});
          throw providerError("Image API response was too large");
        }
        chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
      }
    } finally {
      reader.releaseLock();
    }
    text = Buffer.concat(chunks, total).toString("utf8");
  }
  try { return JSON.parse(text); } catch { throw providerError("Image API returned invalid JSON"); }
}

function upstreamMessage(body) {
  return String(body?.message || body?.error?.message || body?.error || "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .trim()
    .slice(0, 500);
}

function imageSource(body) {
  const standard = body?.data?.[0];
  if (typeof standard?.b64_json === "string" && standard.b64_json) {
    return { type: "base64", value: standard.b64_json };
  }
  if (typeof standard?.url === "string" && standard.url) return { type: "url", value: standard.url };
  const contents = body?.output?.choices?.[0]?.message?.content;
  if (Array.isArray(contents)) {
    const image = contents.find((part) => typeof part?.image === "string" && part.image);
    if (image) return { type: "url", value: image.image };
  }
  return null;
}

function imageMetadata(bytes) {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return { mimeType: "image/png", width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") {
    return { mimeType: "image/webp" };
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) { offset += 1; continue; }
      const marker = bytes[offset + 1];
      if (marker === 0xd8 || marker === 0xd9) { offset += 2; continue; }
      const length = bytes.readUInt16BE(offset + 2);
      if (length < 2 || offset + 2 + length > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        return { mimeType: "image/jpeg", height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
      }
      offset += 2 + length;
    }
    return { mimeType: "image/jpeg" };
  }
  throw providerError("Image API returned an unsupported image format", "ccdx_image_format_unsupported");
}

function ipv4Public(address) {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b, c] = parts;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && (b === 168 || (b === 0 && [0, 2].includes(c)))) return false;
  if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function publicAddress(address) {
  const family = net.isIP(address);
  if (family === 4) return ipv4Public(address);
  if (family !== 6) return false;
  const lower = address.toLowerCase();
  if (lower === "::" || lower === "::1" || lower.startsWith("fc") || lower.startsWith("fd")
    || /^fe[89ab]/.test(lower) || lower.startsWith("ff") || lower.startsWith("2001:db8:")) return false;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  return mapped ? ipv4Public(mapped[1]) : true;
}

export async function downloadPublicImage(urlValue, {
  lookup = dns.lookup,
  timeoutMs = IMAGE_DOWNLOAD_TIMEOUT_MS,
  maxBytes = IMAGE_MAX_BYTES,
  signal,
} = {}) {
  let url;
  try { url = new URL(urlValue); } catch { throw providerError("Image API returned an invalid image URL"); }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw providerError("Image API returned an unsafe image URL", "ccdx_image_url_unsafe");
  }
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (!Array.isArray(addresses) || !addresses.length || addresses.some(({ address }) => !publicAddress(address))) {
    throw providerError("Image API returned a non-public image URL", "ccdx_image_url_unsafe");
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(value);
    };
    const request = https.get(url, {
      headers: { Accept: "image/*,application/octet-stream;q=0.5" },
      lookup: (_hostname, options, callback) => {
        if (options?.all) callback(null, addresses);
        else callback(null, addresses[0].address, addresses[0].family);
      },
    }, (response) => {
      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        finish(providerError(`Image download failed with HTTP ${response.statusCode}`));
        return;
      }
      const declared = Number(response.headers["content-length"]);
      if (Number.isFinite(declared) && declared > maxBytes) {
        response.destroy();
        finish(providerError("Generated image exceeds the size limit", "ccdx_image_too_large"));
        return;
      }
      const chunks = [];
      let total = 0;
      response.on("data", (chunk) => {
        total += chunk.length;
        if (total > maxBytes) {
          response.destroy();
          finish(providerError("Generated image exceeds the size limit", "ccdx_image_too_large"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => finish(null, Buffer.concat(chunks, total)));
      response.on("error", (error) => finish(error));
    });
    const timer = setTimeout(() => request.destroy(providerError("Image download timed out", "ccdx_image_timeout")), timeoutMs);
    timer.unref?.();
    request.on("close", () => clearTimeout(timer));
    request.on("error", (error) => finish(error));
    const onAbort = () => request.destroy(signal.reason instanceof Error ? signal.reason : providerError("Image request was cancelled"));
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function generateImage(config, {
  prompt,
  size = "1024x1024",
} = {}, {
  fetchImpl = fetch,
  downloadImage = downloadPublicImage,
  signal,
  timeoutMs = IMAGE_GENERATION_TIMEOUT_MS,
} = {}) {
  const normalizedPrompt = checkedPrompt(prompt);
  const normalizedSize = checkedSize(size);
  const timeout = AbortSignal.timeout(timeoutMs);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response;
  try {
    response = await fetchImpl(config.endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.api_key}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(generationBody(config, normalizedPrompt, normalizedSize)),
      signal: requestSignal,
    });
  } catch (error) {
    if (requestSignal.aborted) throw providerError("Image generation timed out or was cancelled", "ccdx_image_timeout");
    throw providerError("Image API could not be reached");
  }
  const body = await boundedJson(response);
  if (!response.ok) {
    const detail = upstreamMessage(body);
    throw providerError(`Image API failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
  }
  const source = imageSource(body);
  if (!source) throw providerError("Image API response did not contain an image");
  let bytes;
  try {
    bytes = source.type === "base64"
      ? Buffer.from(source.value, "base64")
      : await downloadImage(source.value, { signal: requestSignal, maxBytes: IMAGE_MAX_BYTES });
  } catch (error) {
    if (error?.code?.startsWith?.("ccdx_")) throw error;
    const code = String(error?.cause?.code || error?.code || "").replace(/[^A-Z0-9_-]/gi, "").slice(0, 64);
    throw providerError(`Generated image could not be downloaded${code ? ` (${code})` : ""}`);
  }
  if (!bytes.length || bytes.length > IMAGE_MAX_BYTES) {
    throw providerError("Generated image is empty or exceeds the size limit", "ccdx_image_too_large");
  }
  const metadata = imageMetadata(bytes);
  return {
    data: bytes.toString("base64"),
    mimeType: metadata.mimeType,
    width: metadata.width,
    height: metadata.height,
    model: config.model,
    size: normalizedSize,
  };
}
