import { parentPort } from "node:worker_threads";
import { countTokenText } from "./anthropic.mjs";

parentPort.on("message", async ({ id, text }) => {
  try {
    parentPort.postMessage({ id, result: await countTokenText(text) });
  } catch (error) {
    parentPort.postMessage({
      id,
      error: {
        name: typeof error?.name === "string" ? error.name : "Error",
        code: typeof error?.code === "string" ? error.code : "unknown",
      },
    });
  }
});
