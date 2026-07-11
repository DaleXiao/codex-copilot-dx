import { test } from "node:test";
import assert from "node:assert/strict";
import { closeHttpServer } from "../src/shutdown.mjs";

test("closeHttpServer: stops a listening server cleanly", async () => {
  const calls = [];
  const server = {
    listening: true,
    close(callback) {
      calls.push("close");
      this.listening = false;
      queueMicrotask(() => callback());
    },
    closeIdleConnections() { calls.push("closeIdleConnections"); },
  };

  const result = await closeHttpServer(server, { timeoutMs: 100 });
  assert.deepEqual(result, { forced: false });
  assert.equal(server.listening, false);
  assert.deepEqual(calls, ["close", "closeIdleConnections"]);
});

test("closeHttpServer: is idempotent for a stopped server", async () => {
  const result = await closeHttpServer(null);
  assert.deepEqual(result, { forced: false });
});
