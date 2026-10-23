import fs from "node:fs";
import path from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { accessSettingsPath, CLIENT_IDS, accessError } from "./access-settings.mjs";
import { readBoundedFileSync } from "./bounded-file.mjs";
import { withFileLockSync } from "./lock.mjs";
import { atomicWriteFileSync } from "./atomic-file.mjs";

export function readClientGatewayKeys(options = {}) {
  const file = path.join(path.dirname(accessSettingsPath(options)), "client-gateway-keys.json");
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  return withFileLockSync(`${file}.lock`, () => {
    let value;
    try { value = JSON.parse(readBoundedFileSync(file, { encoding: "utf8", maxBytes: 2048 })); }
    catch (error) {
      if (error.code !== "ENOENT") throw accessError("ccdx_client_keys_invalid", 409);
      value = Object.fromEntries(CLIENT_IDS.map(id => [id, randomBytes(32).toString("hex")]));
      atomicWriteFileSync(file, JSON.stringify(value) + "\n", { mode: 0o600 });
    }
    if (!value || Object.keys(value).length !== CLIENT_IDS.length || CLIENT_IDS.some(id => !/^[a-f0-9]{64}$/.test(value[id]))) throw accessError("ccdx_client_keys_invalid", 409);
    return value;
  });
}
export function gatewayClient(headers, keys) {
  const candidate = typeof headers?.["x-api-key"] === "string" ? headers["x-api-key"] : /^Bearer (.+)$/i.exec(headers?.authorization || "")?.[1];
  if (!candidate || candidate.length !== 64) return null;
  const bytes = Buffer.from(candidate);if (bytes.length !== 64) return null;
  return CLIENT_IDS.find(id => timingSafeEqual(bytes, Buffer.from(keys[id]))) || null;
}
