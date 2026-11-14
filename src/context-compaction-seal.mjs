import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export const CCDX_COMPACTION_PREFIX = "ccdx-compaction-v1:";
export const CCDX_NATIVE_COMPACTION_PREFIX = "ccdx-native-compaction-v1:";
const MAX_TEXT_BYTES = 512 * 1024, MAX_MAPPING_BYTES = 8 * 1024 * 1024;
const fail = () => Object.assign(new Error("The CCDX compression state is invalid or belongs to another connection; the original conversation was kept."), { code: "ccdx_compaction_state_invalid", statusCode: 409 });
const keyFor = key => {
  if (typeof key !== "string" || key.length < 32) throw fail();
  return createHash("sha256").update("ccdx-context-compaction-v1\0").update(key).digest();
};

export function sealContextCompaction(text, { key, scope, maxBytes = MAX_TEXT_BYTES } = {}) {
  if (typeof text !== "string" || !text.trim() || Buffer.byteLength(text) > Math.min(maxBytes, MAX_MAPPING_BYTES) || typeof scope !== "string" || !scope) throw fail();
  const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", keyFor(key), nonce);cipher.setAAD(Buffer.from(scope));
  const encoded = Buffer.concat([nonce, cipher.update(text, "utf8"), cipher.final(), cipher.getAuthTag()]);
  return CCDX_COMPACTION_PREFIX + encoded.toString("base64url");
}

export function openContextCompaction(value, { key, scope, maxBytes = MAX_TEXT_BYTES } = {}) {
  try {
    if (typeof value !== "string" || !value.startsWith(CCDX_COMPACTION_PREFIX) || value.length > (Math.min(maxBytes, MAX_MAPPING_BYTES) + 28) * 4 / 3 + CCDX_COMPACTION_PREFIX.length + 4
      || typeof scope !== "string" || !scope) throw fail();
    const payload = value.slice(CCDX_COMPACTION_PREFIX.length);
    if (!/^[\w-]+$/.test(payload)) throw fail();
    const encoded = Buffer.from(payload, "base64url");if (encoded.length <= 28 || encoded.toString("base64url") !== payload) throw fail();
    const decipher = createDecipheriv("aes-256-gcm", keyFor(key), encoded.subarray(0, 12));decipher.setAAD(Buffer.from(scope));decipher.setAuthTag(encoded.subarray(-16));
    const text = Buffer.concat([decipher.update(encoded.subarray(12, -16)), decipher.final()]).toString("utf8");if (!text.trim()) throw fail();return text;
  } catch { throw fail(); }
}

function checkedMappings(mappings) {
  if (!Array.isArray(mappings) || mappings.length > 8192) throw fail();
  const seen = new Map();let bytes = 0;
  for (const entry of mappings) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string" || !/^\{\{CCDX_[a-f0-9]{24}\}\}$/.test(entry[0]) || typeof entry[1] !== "string"
      || seen.has(entry[0]) && seen.get(entry[0]) !== entry[1]) throw fail();
    bytes += Buffer.byteLength(entry[1]);if (bytes > 4 * 1024 * 1024) throw fail();seen.set(...entry);
  }
  return mappings;
}

export function sealNativeCompaction(encryptedContent, mappings, options) {
  if (typeof encryptedContent !== "string" || !encryptedContent || encryptedContent.length > 100 * 1024 * 1024) throw fail();checkedMappings(mappings);
  const digest = createHash("sha256").update(encryptedContent).digest("hex"), scope = options.scope + "\0native\0" + digest;
  const sealed = sealContextCompaction(JSON.stringify(mappings), { ...options, scope, maxBytes: MAX_MAPPING_BYTES }).slice(CCDX_COMPACTION_PREFIX.length);
  const result = CCDX_NATIVE_COMPACTION_PREFIX + sealed + ":" + encryptedContent;
  if (result.length > 100 * 1024 * 1024) throw fail();return result;
}

export function openNativeCompaction(value, options) {
  if (typeof value !== "string" || !value.startsWith(CCDX_NATIVE_COMPACTION_PREFIX) || value.length > 100 * 1024 * 1024) throw fail();
  const separator = value.indexOf(":", CCDX_NATIVE_COMPACTION_PREFIX.length);if (separator < 0) throw fail();
  const encrypted_content = value.slice(separator + 1), digest = createHash("sha256").update(encrypted_content).digest("hex");
  const text = openContextCompaction(CCDX_COMPACTION_PREFIX + value.slice(CCDX_NATIVE_COMPACTION_PREFIX.length, separator), { ...options, scope: options.scope + "\0native\0" + digest, maxBytes: MAX_MAPPING_BYTES });
  let mappings;try { mappings = JSON.parse(text); } catch { throw fail(); }return { encrypted_content, mappings: checkedMappings(mappings) };
}
