import { parentPort } from "node:worker_threads";
import { countTokenText } from "./anthropic.mjs";

parentPort.on("message", async ({ id, text }) => {
  try {
    parentPort.postMessage({ id, result: await countTokenText(text) });
  } catch {
    parentPort.postMessage({ id, error: true });
  }
});
