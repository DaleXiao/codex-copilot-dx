import { flushUsageWritesForTests, recordUsage } from "../../src/usage.mjs";

const model = process.argv[2];

process.send?.("ready");
process.once("message", async (message) => {
  if (message !== "write") return;
  try {
    await recordUsage({
      ts: "2026-01-01T00:00:00.000Z",
      model,
      usage: { total_tokens: 1 },
    });
    await flushUsageWritesForTests();
    process.send?.("done");
    process.disconnect?.();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
    process.disconnect?.();
  }
});
