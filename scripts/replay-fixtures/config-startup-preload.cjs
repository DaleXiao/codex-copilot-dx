// Isolated startup replay only: fake profile and upstream, no external requests.
const os = require("node:os");
const http = require("node:http");
const { syncBuiltinESMExports } = require("node:module");
if (!process.env.CCDX_TEST_HOME) throw new Error("Startup replay requires an isolated profile");
os.homedir = () => process.env.CCDX_TEST_HOME;
const emit = http.Server.prototype.emit;
http.Server.prototype.emit = function (event, ...args) {
  if (event === "request" && args[0]?.url?.split("?", 1)[0] === "/mcp/image") console.log("Image fixture MCP request received");
  return emit.call(this, event, ...args);
};
if (process.env.CCDX_TEST_IMAGE_WRITE_FAILURE === "1") {
  const fs = require("node:fs");
  const path = require("node:path");
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (to === path.join(process.env.CCDX_TEST_HOME, ".codex", "config.toml")) {
      throw Object.assign(new Error("synthetic optional config write failure"), { code: "EACCES" });
    }
    return rename(from, to);
  };
}
syncBuiltinESMExports();
const localFetch = globalThis.fetch;
let finishImage;
let finishUpdate;
process.on("message", message => {
  if (message === "release-image-fixture") finishImage?.();
  if (message === "release-update-fixture") finishUpdate?.();
});
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  if (url.hostname === "registry.npmjs.org") console.log("Registry fixture request blocked");
  if (url.href === "https://api.github.com/repos/DaleXiao/codex-copilot-dx/releases/latest" && process.env.CCDX_TEST_UPDATE_MODE) {
    console.log("Update fixture request received");
    if (init.headers.Authorization || init.headers.authorization) throw new Error("Update checks must be anonymous");
    const mode = process.env.CCDX_TEST_UPDATE_MODE;
    if (mode === "offline") throw new Error("synthetic offline release check");
    if (mode === "malformed") return Response.json({ tag_name: "main", draft: false, prerelease: false });
    if (mode === "current") return Response.json({ tag_name: `v${require("../../package.json").version}`, draft: false, prerelease: false });
    return new Promise((resolve, reject) => {
      const clean = () => { finishUpdate = undefined; init.signal.removeEventListener("abort", onAbort); };
      const onAbort = () => { clean(); console.log("Update fixture cancelled"); reject(new Error("synthetic release timeout")); };
      finishUpdate = () => { clean(); resolve(Response.json({ tag_name: "v99.0.0", draft: false, prerelease: false })); };
      init.signal.addEventListener("abort", onAbort, { once: true });
      if (init.signal.aborted) onAbort();
    });
  }
  if (url.origin === "https://images.example") console.log("Image fixture outbound request");
  if (url.origin === `http://127.0.0.1:${process.env.ADAPTER_PORT}`) return localFetch(input, init);
  if (url.href === "https://api.github.com/user") return Response.json({ login: "startup-fixture", id: 1 });
  if (url.href === "https://api.github.com/copilot_internal/v2/token") {
    return Response.json({ token: "synthetic-copilot-token", expires_at: Math.floor(Date.now() / 1000) + 3600, endpoints: { api: "https://startup-replay.example" } });
  }
  if (url.href === "https://startup-replay.example/models") {
    return Response.json({ data: [{ id: "gpt-5.5", supported_endpoints: ["/responses", "/chat/completions"] }] });
  }
  if (url.href === "https://startup-replay.example/responses") {
    return Response.json({ id: "resp_startup_fixture", object: "response", status: "completed", model: "gpt-5.5", output: [{ id: "msg_startup_fixture", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "startup fixture response", annotations: [] }] }] });
  }
  if (url.href === "https://startup-replay.example/chat/completions") {
    return Response.json({ id: "chatcmpl_startup_fixture", object: "chat.completion", model: "gpt-5.5", choices: [{ index: 0, message: { role: "assistant", content: "startup fixture response" }, finish_reason: "stop" }] });
  }
  if (url.href === "https://images.example/v1/images/generations" && process.env.CCDX_TEST_PENDING_IMAGE === "1") {
    console.log("Image fixture request pending");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { finishImage = undefined; reject(new Error("Image fixture release timed out")); }, 5000);
      finishImage = () => {
        clearTimeout(timer);
        finishImage = undefined;
        resolve(Response.json({ error: { message: "Synthetic image provider failure" } }, { status: 503 }));
      };
    });
  }
  throw new Error(`External network is disabled in startup replay: ${url.origin}${url.pathname}`);
};
