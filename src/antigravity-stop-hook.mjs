import path from "node:path";
import { atomicWriteFileSync } from "./atomic-file.mjs";
import { userSettingsPath } from "./user-settings.mjs";

export const ANTIGRAVITY_STOP_SIGNAL = "antigravity-stop.signal";
const MAX_HOOK_BYTES = 1024 * 1024;
const CONVERSATION_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export async function signalAntigravityStop(input, options) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of input) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += data.length;
    if (bytes > MAX_HOOK_BYTES) return false;
    chunks.push(data);
  }
  const event = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (event?.terminationReason !== "model_stop" || event.fullyIdle !== true || event.error
    || !Number.isSafeInteger(event.executionNum) || event.executionNum < 0
    || typeof event.conversationId !== "string" || !CONVERSATION_ID.test(event.conversationId)) return false;
  // The marker only wakes the Bark reader. No payload from the hook is persisted.
  const folder = path.dirname(userSettingsPath(options));
  atomicWriteFileSync(path.join(folder, ANTIGRAVITY_STOP_SIGNAL), "", { mode: 0o600 });
  return true;
}
