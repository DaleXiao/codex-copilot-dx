// Runs the installed Codex app-server against the candidate Images routes.
// Models and pixels are synthetic; no installed profile or cloud credential is used.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { createAdapterHandler } from "../src/adapter.mjs";
import { createCopilotClient } from "../src/copilot.mjs";
import { readAuthProfileCredentials } from "../src/auth-profile.mjs";
import { testEnvironment } from "../test/helpers/environment.mjs";

const args = process.argv.slice(2), binary = args[args.indexOf("--codex") + 1];
assert.ok(args.includes("--codex") && path.isAbsolute(binary), "Supply --codex /absolute/path/to/codex");
process.env.CCDX_DISABLE_USAGE = "1";
const live = args.includes("--live-ghc");
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ccdx-image-host-replay-")));
const profile = path.join(root, "profile"), cwd = path.join(root, "project");
await fs.mkdir(profile);await fs.mkdir(cwd);
const pngs = await Promise.all(["blue", "red", "green"].map(async background => (await sharp({ create: { width: 64, height: 64, channels: 3, background } }).png().toBuffer()).toString("base64")));
const calls = [], events = [], pending = new Map(), continuations = [];
let catalog;
const returnedPixels = [];
const credentials = live ? readAuthProfileCredentials("codex") : null;
if (live) assert.ok(credentials.valid && credentials.identity, "Live GHC replay requires the existing bound account");
const ghc = live ? createCopilotClient({ readGithubCredentials: () => credentials, allowTokenDiscovery: false,
  readGithubIdentity: () => credentials.identity, writeGithubIdentity() {} }) : null;
let child, nextId = 0, buffer = "", stderr = "", sequence = 0, imageIndex = 0, step = 0, edit = false, threadId;
const generated=[]; const mcpCalls=[];
const finalMessage = () => ({ id: `msg_${sequence}`, type: "message", role: "assistant", phase: "final_answer", status: "completed", content: [{ type: "output_text", text: "Native image complete.", annotations: [] }] });
const client = {
  getCachedModelEndpoints: () => ["/responses"],
  listModels: async () => ({ status: 200, body: JSON.stringify({ data: [{ id: "gpt-6.1-sol", vendor: "OpenAI", model_picker_enabled: true, policy: { state: "enabled" }, supported_endpoints: ["/responses"], capabilities: { type: "chat", supports: { reasoning_effort: ["low", "high"] } } }, { id: "gpt-image-2.5-flare", name: "GPT Image 2.5 Flare", model_picker_enabled: false, capabilities: { type: "image" }, supported_endpoints: ["/v1/images/generations", "/v1/images/edits"] }] }) }),
  images: async (operation, body) => {
    calls.push({ operation, body });assert.equal(body.model, "gpt-image-2.5-flare");
    if (edit) { assert.equal(operation, "edits");assert.equal(body.images.length, 1);assert.equal(body.images[0].image_url, `data:image/png;base64,${returnedPixels[imageIndex - 1]}`); }
    else assert.equal(operation, "generations");
    if (live) {
      const response = await ghc.images(operation, body, { signal: AbortSignal.timeout(180000) });
      assert.equal(response.status, 200, `Live GHC ${operation} failed`);
      const result = await response.json();returnedPixels.push(result.data[0].b64_json);imageIndex++;
      return Response.json(result);
    }
    returnedPixels.push(pngs[imageIndex]);
    return Response.json({ created: 1, background: "opaque", quality: "low", size: "1024x1024", data: [{ b64_json: pngs[imageIndex++] }] });
  },
  responses: async body => {
    if(step++%2===0){
      const args={prompt:edit?"Make it red":"A blue square",mode:edit?"edit":"generate",quality:"low",size:"1024x1024"};
      assert.ok(JSON.stringify(body).includes("ccdx_images__imagegen"),"Host image tool must be registered");
      return new Response(syntheticResponse([{type:"custom_tool_call",id:`fc_${sequence}`,call_id:`call_${sequence}`,name:"exec",namespace:"functions",input:`const r = await tools.ccdx_images__imagegen(${JSON.stringify(args)}); text(r);`}],`resp_${sequence++}`),{headers:{"content-type":"text/event-stream"}});
    }
    return new Response(syntheticResponse([finalMessage()],`resp_${sequence++}`),{headers:{"content-type":"text/event-stream"}});
  },
};
const handler = createAdapterHandler({ codexClient: client, responsesFn: client.responses, getCachedModelEndpointsFn: client.getCachedModelEndpoints, codexModelCatalog: { load: async () => catalog },
  env: {}, dashboardOptions: { home: root }, imageModels: () => [{ id: "gpt-image-2.5-flare", editing: true }], imagesEnabled: () => true, imagesAllowed: () => true });
const server = http.createServer((req, res) => {
  if (req.url.startsWith("/api/codex/accounts/check")) { res.writeHead(200, { "Content-Type": "application/json" });res.end(JSON.stringify({ accounts: [{ id: "synthetic-account", name: "Synthetic", plan_type: "free", workspace_backend_origin: "https://chatgpt.com", account_routing_override: "NO_CONSTRAINT" }] }));return; }
  if(req.url==="/_ccdx/settings"){res.writeHead(200,{"Content-Type":"application/json"});res.end(JSON.stringify({features:{image:{enabled:true}}}));return;}
  if(req.url.includes("/mcp")&&req.method==="POST"){
    const chunks=[];req.on("data",c=>chunks.push(c));req.on("end",()=>{const q=JSON.parse(Buffer.concat(chunks));mcpCalls.push(q.method);if(q.id===undefined){res.writeHead(202);res.end();return;}
      const result=q.method==="initialize"?{protocolVersion:q.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:"Apps Fixture",version:"1"}}:q.method==="tools/list"?{tools:[{name:"coexist_ping",connector_id:"connector_fixture",connector_name:"Fixture Apps",connector_description:"Read-only fixture",description:"Read-only fixture",_meta:{_codex_apps:{connector_id:"connector_fixture",connector_name:"Fixture Apps",synthetic_link:false}},inputSchema:{type:"object",properties:{},additionalProperties:false},annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false}}]}:q.method==="tools/call"?{content:[{type:"text",text:"fixture pong"}]}:{};
      res.writeHead(200,{"Content-Type":"application/json"});res.end(JSON.stringify({jsonrpc:"2.0",id:q.id,result}));});return;
  }
  if(req.method==="GET"&&!req.url.startsWith("/v1/")){res.writeHead(200,{"Content-Type":"application/json"});res.end(JSON.stringify({apps:[{id:"connector_fixture",name:"Fixture Apps",description:"Read-only fixture"}],next_token:null}));return;}
  handler(req,res);
});
server.on("upgrade", (_req, socket) => socket.end("HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"));
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}/v1`;
const runtimeEnv = testEnvironment(root, { CODEX_HOME: profile, OPENAI_BASE_URL: base,
  HTTP_PROXY: "http://127.0.0.1:1", HTTPS_PROXY: "http://127.0.0.1:1", NO_PROXY: "127.0.0.1,localhost", CODEX_CONNECTORS_TOKEN: "{{CCDX_12ffaa3c972f75110a330979}}" });
const config = `model = "gpt-6.1-sol"
model_provider = "openai"
openai_base_url = "${base}"
chatgpt_base_url = "http://127.0.0.1:${server.address().port}"
check_for_update_on_startup = false
[features]
shell_snapshot = false
plugins = false
remote_plugin = false
apps = true
skill_search = false
[analytics]
enabled = false
[feedback]
enabled = false
`;
await fs.writeFile(path.join(profile, "config.toml"), config);
const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
const token = `${encode({ alg: "none" })}.${encode({ email: "synthetic@example.test", exp: 4102444800, "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-account", chatgpt_plan_type: "free" } })}.synthetic`;
await fs.writeFile(path.join(profile, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", OPENAI_API_KEY: null, tokens: { id_token: token, access_token: "synthetic-access", refresh_token: "synthetic-refresh", account_id: "synthetic-account" }, last_refresh: new Date().toISOString() }), { mode: 0o600 });

function bounded(promise, label, ms = live ? 180000 : 30000) { let timer;return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(`${label} timed out: ${stderr.slice(-1800)}`)), ms); })]).finally(() => clearTimeout(timer)); }
function call(method, params) { const id = ++nextId;return bounded(new Promise((resolve, reject) => { pending.set(id, { resolve, reject });child.stdin.write(JSON.stringify({ id, method, params }) + "\n"); }), method); }
async function waitFor(method, after) {
  let interval;
  try { return await bounded(new Promise(resolve => { interval = setInterval(() => { const event = events.slice(after).find(e => e.method === method);if (event) resolve(event.params); }, 10); }), method); }
  finally { clearInterval(interval); }
}

function syntheticResponse(output, id) {
  let sequence = 0;
  const events = [];
  const emit = (type, fields) => events.push(`event: ${type}\ndata: ${JSON.stringify({
    type, sequence_number: sequence++, ...fields,
  })}\n\n`);
  const response = {
    id, object: "response", created_at: 1720000000, status: "completed", model: "gpt-5.5", output,
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  };
  emit("response.created", { response: { ...response, status: "in_progress", output: [] } });
  for (const [index, item] of output.entries()) {
    emit("response.output_item.added", { output_index: index, item: { ...item, status: "in_progress", ...(item.type === "function_call" ? { arguments: "" } : item.type === "message" ? { content: [] } : {}) } });
    if (item.type === "function_call") {
      emit("response.function_call_arguments.delta", { output_index: index, item_id: item.id, delta: item.arguments });
      emit("response.function_call_arguments.done", { output_index: index, item_id: item.id, arguments: item.arguments });
    } else if (item.type === "custom_tool_call") {
      emit("response.custom_tool_call_input.delta", { output_index: index, item_id: item.id, delta: item.input });
      emit("response.custom_tool_call_input.done", { output_index: index, item_id: item.id, input: item.input });
    } else if (item.type === "message") {
      const location = { output_index: index, content_index: 0, item_id: item.id };
      emit("response.content_part.added", { ...location, part: { ...item.content[0], text: "" } });
      emit("response.output_text.delta", { ...location, delta: item.content[0].text });
      emit("response.output_text.done", { ...location, text: item.content[0].text });
      emit("response.content_part.done", { ...location, part: item.content[0] });
    }
    emit("response.output_item.done", { output_index: index, item });
  }
  emit("response.completed", { response });
  return events.join("");
}

async function startClient() {
  buffer = "";
  child = spawn(process.execPath, [path.resolve("bin/codex-image-host.mjs"), "--codex", binary, "--base-url", base, "--", "app-server", "--stdio"], { env: runtimeEnv, cwd, stdio: ["pipe", "pipe", "pipe"] });
  child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-8000); });child.stdin.on("error", () => {});
  child.stdout.setEncoding("utf8");child.stdout.on("data", chunk => {
    buffer += chunk;let boundary;
    while ((boundary = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, boundary);buffer = buffer.slice(boundary + 1);if (!line) continue;
      const event=JSON.parse(line),request=pending.get(event.id);
      if(request){pending.delete(event.id);event.error?request.reject(Error(JSON.stringify(event.error))):request.resolve(event.result);}
      else if(event.id!==undefined){child.stdin.write(JSON.stringify({id:event.id,error:{code:-32601,message:"Unexpected client request"}})+"\n");}
      else events.push(event);
    }
  });
  await call("initialize", { clientInfo: { name: "Codex Desktop", version: "1.0" }, capabilities: { experimentalApi: true } });child.stdin.write('{"method":"initialized","params":{}}\n');
}

try {
  const version = execFileSync(binary, ["--version"], { env: runtimeEnv, encoding: "utf8" }).trim();
  catalog = JSON.parse(execFileSync(binary, ["debug", "models", "--bundled"], { env: runtimeEnv, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }));
  await startClient();
  const available = await call("model/list", { includeHidden: false, cursor: null, limit: 100 });
  assert.ok(available.data.some(model => model.id === "gpt-6.1-sol"));
  assert.ok(available.data.every(model => model.id !== "gpt-image-2.5-flare"), "Images must not enter the native conversation picker");
  const thread = await call("thread/start", { cwd, model: "gpt-6.1-sol", modelProvider: "openai", serviceName: "codex_work_desktop", approvalPolicy: "never", sandbox: "workspace-write"});threadId = thread.thread.id;
  const authBytes=await fs.readFile(path.join(profile,"auth.json"));
  const account=await call("account/read",{refreshToken:false});
  const apps=await call("app/list",{threadId,forceRefetch:true,limit:100,cursor:null});
  const appsCall=await call("mcpServer/tool/call",{threadId,server:"codex_apps",tool:"coexist_ping",arguments:{}});
  const allItems=[];
  for(const editing of [false,true,true]){
    if(generated.length===2){
      child.kill("SIGTERM");await bounded(once(child,"exit"),"first host shutdown",3000);
      await startClient();await call("thread/resume",{threadId,cwd,modelProvider:"openai",approvalPolicy:"never",sandbox:"workspace-write"});
    }
    edit=editing;const offset=events.length;
    await call("turn/start",{threadId,input:[{type:"text",text:edit?"Make the last image red":"Generate a blue square",text_elements:[]}]});
    const completed=await waitFor("turn/completed",offset);assert.equal(completed.turn.status,"completed",JSON.stringify(completed));
    const items=events.slice(offset).filter(e=>e.method==="item/completed").map(e=>e.params.item);
    const item=items.find(i=>i.type==="dynamicToolCall"&&i.namespace==="ccdx_images");assert.ok(item,"Native dynamic tool item expected: "+JSON.stringify(items));assert.equal(item.success,true,JSON.stringify(item));
    assert.ok(item.contentItems.some(i=>i.type==="inputImage"));allItems.push(item.type);generated.push(JSON.parse(item.contentItems.find(i=>i.type==="inputText").text).savedPath);
  }
  assert.equal(generated.length,3);assert.equal(calls.length,3);assert.equal((await fs.readFile(generated[0])).toString("base64"),returnedPixels[0]);assert.equal((await fs.readFile(generated[1])).toString("base64"),returnedPixels[1]);
  const history=await call("thread/read",{threadId,includeTurns:true});
  assert.ok(apps.data.some(x=>x.id==="connector_fixture"));assert.ok(mcpCalls.includes("tools/call"));
  console.log(JSON.stringify({version,automaticRegistration:true,resumedEdit:true,plan:account.account?.planType,authFileUnchanged:authBytes.equals(await fs.readFile(path.join(profile,"auth.json"))),appsDirectory:apps.data.map(x=>({id:x.id,isAccessible:x.isAccessible})),appsCalled:mcpCalls.includes("tools/call"),appsResult:appsCall,nativeHostToolCalls:generated.length,imagesApiCalls:calls.length,generatedFilesPreserved:true,historyItemTypes:history.thread.turns.flatMap(t=>t.items).map(i=>i.type),nativeItemTypes:allItems}));

} finally {
  if (child && child.exitCode === null) { child.kill("SIGTERM");await bounded(once(child, "exit"), "shutdown", 3000).catch(() => child.kill("SIGKILL")); }
  server.closeAllConnections();await new Promise(resolve => server.close(resolve));handler.cleanup();await fs.rm(root, { recursive: true, force: true, maxRetries: 3 });
}
