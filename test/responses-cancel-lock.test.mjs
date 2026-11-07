import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import { createAdapterHandler } from "../src/adapter.mjs";
import { createConversationSourceGuard } from "../src/conversation-source-guard.mjs";
import { accessSettingsPath } from "../src/access-settings.mjs";

test("cancelled Responses and compact requests stop waiting on a contended source lock", async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ccdx-cancel-lock-")), env = {};
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const lock = path.join(path.dirname(accessSettingsPath({ home, env })), "conversation-sources.json.lock");
  await fs.mkdir(path.dirname(lock), { recursive: true });await fs.writeFile(lock, JSON.stringify({ pid: process.pid, owner: "fixture" }));
  for (const [url, providerId] of [["/v1/responses", "github"], ["/v1/responses/compact", "github"], ["/v1/responses", "api_fixture"]]) {
    let enter, settled, failure, upstream = 0;
    const entered = new Promise(resolve => { enter = resolve; }), finished = new Promise(resolve => { settled = resolve; });
    const guard = createConversationSourceGuard({ home, env });
    const provider = { id: providerId, client: { responses: async () => { upstream++;throw Error("unexpected upstream"); }, getCachedModelEndpoints: () => ["/responses"] } };
    const runtime = { current: () => provider, snapshot: () => null, selection: () => ({ m365: {} }),
      validateConversation(body, headers, source, signal) { enter();return guard("codex", "profile", body, headers, "test-salt", undefined, signal).catch(error => { failure = error;throw error; }).finally(settled); } };
    const handler = createAdapterHandler({ providerRuntime: runtime, env, dashboardOptions: { home, env } });
    const req = Readable.from([Buffer.from(JSON.stringify({ model: "fixture", input: "synthetic", stream: false }))]);
    Object.assign(req, { method: "POST", url, headers: { "content-type": "application/json", session_id: `session-${providerId}-${url}` }, socket: { remoteAddress: "127.0.0.1" } });
    const res = new EventEmitter();Object.assign(res, { destroyed: false, writableEnded: false, headersSent: false });
    res.writeHead = () => { res.headersSent = true; };res.write = () => true;res.end = () => { res.writableEnded = true;res.emit("finish"); };
    const pending = handler(req, res);await entered;await new Promise(resolve => setTimeout(resolve, 30));
    res.destroyed = true;res.emit("close");
    await Promise.race([finished, new Promise((_, reject) => setTimeout(() => reject(Error("cancelled request still waits for the source lock")), 400))]);
    await pending;assert.equal(failure?.name, "AbortError");assert.equal(upstream, 0);
    assert.equal(JSON.parse(await fs.readFile(lock, "utf8")).owner, "fixture");handler.cleanup();
  }
});
