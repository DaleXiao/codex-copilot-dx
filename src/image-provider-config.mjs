import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { atomicWriteFileSync } from "./atomic-file.mjs";

export const IMAGE_PROVIDER_PROTOCOLS = new Set(["openai-images", "qwen-messages"]);
export const IMAGE_PROVIDER_TIMEOUT_MS = 15_000;

export function imageProviderConfigPath({ env = process.env, home = os.homedir() } = {}) {
  const xdgConfigHome = String(env.XDG_CONFIG_HOME || "").trim();
  const configRoot = xdgConfigHome || path.join(home, ".config");
  return path.join(configRoot, "codex-copilot-dx", "image-provider.json");
}

function invalidConfig(filePath, reason) {
  return new Error(`Invalid ccdx image provider at ${filePath}: ${reason}`);
}

export function normalizeImageEndpoint(value) {
  let url;
  try {
    url = new URL(String(value || "").trim());
  } catch {
    throw new Error("Image API endpoint must be a valid HTTPS URL");
  }
  if (url.protocol !== "https:"
    || !url.hostname
    || url.username
    || url.password
    || url.search
    || url.hash) {
    throw new Error("Image API endpoint must be an HTTPS URL without credentials, query, or fragment");
  }
  const pathname = url.pathname.replace(/\/+$/, "");
  if (!pathname.endsWith("/images/generations")) {
    throw new Error("Image API endpoint path must end with /images/generations");
  }
  return `${url.origin}${pathname}`;
}

export function imageModelsEndpoint(endpoint) {
  const normalized = normalizeImageEndpoint(endpoint);
  return normalized.replace(/\/images\/generations$/, "/models");
}

function checkedApiKey(value) {
  const key = String(value || "").trim();
  if (!key) throw new Error("Image API key is required");
  if (key.length > 8192 || /[\u0000-\u001f\u007f-\u009f]/.test(key)) throw new Error("Image API key is invalid");
  return key;
}

export function validateImageProviderConfig(value, { filePath = "image-provider.json" } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidConfig(filePath, "expected a JSON object");
  }
  let endpoint;
  let apiKey;
  try {
    endpoint = normalizeImageEndpoint(value.endpoint);
    apiKey = checkedApiKey(value.api_key);
  } catch (error) {
    throw invalidConfig(filePath, error.message);
  }
  const model = String(value.model || "").trim();
  if (!model || model.length > 256 || /[\u0000-\u001f\u007f-\u009f]/.test(model)) {
    throw invalidConfig(filePath, "model must be a non-empty string");
  }
  const protocol = String(value.protocol || "").trim();
  if (!IMAGE_PROVIDER_PROTOCOLS.has(protocol)) {
    throw invalidConfig(filePath, `protocol must be one of: ${[...IMAGE_PROVIDER_PROTOCOLS].join(", ")}`);
  }
  return { enabled: true, endpoint, api_key: apiKey, model, protocol };
}

export function readImageProviderConfig({ env = process.env, home = os.homedir(), strict = false } = {}) {
  const filePath = imageProviderConfigPath({ env, home });
  try {
    return validateImageProviderConfig(JSON.parse(fs.readFileSync(filePath, "utf8")), { filePath });
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    if (strict) {
      if (String(error?.message || "").startsWith("Invalid ccdx image provider")) throw error;
      throw invalidConfig(filePath, error?.message || String(error));
    }
    return null;
  }
}

export function writeImageProviderConfig(config, { env = process.env, home = os.homedir() } = {}) {
  const filePath = imageProviderConfigPath({ env, home });
  const normalized = validateImageProviderConfig(config, { filePath });
  atomicWriteFileSync(filePath, `${JSON.stringify(normalized, null, 2)}\n`, {
    mode: 0o600,
    preserveMode: false,
  });
  return { filePath, config: normalized };
}

async function limitedText(response, maxBytes = 1024 * 1024) {
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error("Image API response was too large");
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text) > maxBytes) throw new Error("Image API response was too large");
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error("Image API response was too large");
      }
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

function errorMessage(value) {
  if (!value || typeof value !== "object") return "";
  return String(value.message || value.error?.message || value.error || value.reason || "");
}

function imageModelIds(body) {
  if (!body || !Array.isArray(body.data)) return [];
  const candidates = body.data
    .map((model) => ({
      id: String(model?.id || "").trim(),
      imageCapable: /image|dall[-_.]?e/i.test(String(model?.id || ""))
        || [model?.capabilities, model?.supported_generation_methods, model?.output_modalities]
          .flatMap((value) => Array.isArray(value) ? value : [])
          .some((value) => /image/i.test(String(value))),
    }))
    .filter(({ id }) => id
      && id.length <= 256
      && !/[\u0000-\u001f\u007f-\u009f]/.test(id));
  const imageIds = candidates.filter(({ imageCapable }) => imageCapable).map(({ id }) => id);
  return [...new Set(imageIds.length ? imageIds : candidates.length === 1 ? [candidates[0].id] : [])];
}

function detectProtocol(statusCode, body) {
  if (statusCode < 400) return null;
  const text = `${errorMessage(body)} ${JSON.stringify(body)}`.toLowerCase();
  if (text.includes("input.messages")) return "qwen-messages";
  if (/(?:field|required|missing|provide)[^\n]{0,80}\bprompt\b|\bprompt\b[^\n]{0,80}(?:required|missing)/i.test(text)) {
    return "openai-images";
  }
  return null;
}

async function fetchJson(url, init, { fetchImpl, timeoutMs }) {
  const response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const text = await limitedText(response);
  let body;
  try { body = JSON.parse(text); } catch { throw new Error("Image API returned invalid JSON"); }
  return { response, body };
}

export async function inspectImageProvider({
  endpoint,
  apiKey,
  fetchImpl = fetch,
  timeoutMs = IMAGE_PROVIDER_TIMEOUT_MS,
} = {}) {
  const normalizedEndpoint = normalizeImageEndpoint(endpoint);
  const normalizedKey = checkedApiKey(apiKey);
  const headers = { Authorization: `Bearer ${normalizedKey}`, Accept: "application/json" };
  const models = await fetchJson(imageModelsEndpoint(normalizedEndpoint), { headers }, { fetchImpl, timeoutMs });
  if (!models.response.ok) throw new Error(`Image API model lookup failed with HTTP ${models.response.status}`);
  const modelIds = imageModelIds(models.body);
  if (!modelIds.length) throw new Error("Image API model lookup returned no image models");

  const probe = await fetchJson(normalizedEndpoint, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ model: modelIds[0] }),
  }, { fetchImpl, timeoutMs });
  const protocol = detectProtocol(probe.response.status, probe.body);
  if (!protocol) throw new Error("Image API protocol is unsupported or could not be detected safely");
  return { endpoint: normalizedEndpoint, modelIds, protocol };
}
