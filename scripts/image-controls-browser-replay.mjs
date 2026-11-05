// Real browser controls against a local, synthetic GHC catalog and image backend.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { parse } from "smol-toml";
import { createProviderRuntime } from "../src/provider-runtime.mjs";
import { createServiceControl } from "../src/service-control.mjs";
import { createAdapterHandler } from "../src/adapter.mjs";
import { authProfilePaths } from "../src/auth-profile.mjs";
import { readAccessSettings } from "../src/access-settings.mjs";
const args = new Map();for (let i=2;i<process.argv.length;i+=2) args.set(process.argv[i],process.argv[i+1]);
const module = await import(args.get("--playwright")), browsers = module.default || module, loopbackFetch = fetch;
process.env.CCDX_DISABLE_USAGE = "1";globalThis.fetch = async () => { throw Error("Cloud requests are forbidden"); };
const report = [];
for (const engine of (args.get("--engines") || "chromium,webkit").split(",")) {
  const browser = await browsers[engine].launch({ headless: true });
  try { for (const language of ["en", "zh"]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-image-controls-")), env = { CCDX_M365: "0" };
    const token = authProfilePaths("codex", { home: root }).tokenPath;fs.mkdirSync(path.dirname(token), { recursive: true });fs.writeFileSync(token, "synthetic-only");
    const config = path.join(root, ".codex/config.toml");fs.mkdirSync(path.dirname(config), { recursive: true });fs.writeFileSync(config, 'model = "gpt-conversation"\n');
    const image = id => ({ id, name: id === "render-one" ? "Render One" : "Render Two", model_picker_enabled: false, capabilities: { type: "image" }, supported_endpoints: ["/v1/images/generations", "/v1/images/edits"] });
    const chat = { id: "gpt-conversation", name: "Conversation", model_picker_enabled: true, capabilities: { type: "chat" }, supported_endpoints: ["/responses"] };
    const registry = { models: { data: [chat, image("render-one"), image("render-two")] } };
    let handler, dispatches = 0, selectedRequest;
    const server = http.createServer((req,res)=>handler(req,res));await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
    const base = `http://127.0.0.1:${server.address().port}`, client = { runtimeStatus: () => ({}), images: async (_op,body) => { dispatches++;selectedRequest=body.model;return Response.json({ error: { message: "synthetic quota" } }, { status: 429 }); } };
    const runtime = createProviderRuntime({ home: root, env, platform: "linux", corePort: server.address().port, githubClient: client, githubRegistry: registry,
      refreshGithubCatalog: async()=>registry.models, inspectDesktop: async()=>false, secretStore: { get: async()=>null,close(){} },restoreClaude:()=>({preserved:0}) });
    let dockSaved = false;const dockCalls = [];
    const dockSnapshot = () => ({ supported: true, saved: dockSaved, state: dockSaved ? "pending_reopen" : "disabled", tool_registration: "unconfirmed" });
    const controls = createServiceControl({ home:root,env,providerRuntime:runtime, imageDock: { snapshot: dockSnapshot,
      async action(operation) { dockCalls.push(operation);if (operation === "enable") dockSaved = true;if (operation === "disable") dockSaved = false;return dockSnapshot(); } } });
    handler=createAdapterHandler({ codexClient:client,providerRuntime:runtime,dashboardOptions:{home:root,env,serviceControl:controls,authStatusFn:()=>({profiles:{codex:{configured:true,valid:true}}}),updateStatusFn:async()=>({status:"unavailable"})} });
    const context=await browser.newContext({viewport:{width:language==="zh"?360:1280,height:1000}});
    await context.addInitScript(language=>{localStorage.setItem("ccdx.dashboard.language",language);localStorage.setItem("ccdx.dashboard.autoRefresh","off");},language);
    const page=await context.newPage(),errors=[];page.on("pageerror",e=>errors.push(e.message));page.setDefaultTimeout(10000);
    const open=async selector=>page.locator(selector).evaluate(node=>{for(let p=node;p;p=p.parentElement)if(p.tagName==="DETAILS")p.open=true;});
    const post=predicate=>page.waitForResponse(r=>r.request().method()==="POST" && predicate(r));
    try {
      await page.goto(base+"/#codex");await page.locator('#image-models input[value="render-one"]:checked').waitFor({state:"attached"});await open("#image-models");
      assert.equal(await page.locator("#setting-image_enabled").isChecked(),true);assert.equal(await page.locator("#image-setup-form").count(),0);
      page.once("dialog", dialog => dialog.accept());
      let dockReply = post(r => r.url().includes("/_ccdx/ui/settings"));await page.locator("#image-dock-enabled").check();assert.equal((await dockReply).status(),200);
      await page.waitForFunction(() => document.getElementById("image-dock-status").textContent.includes("unconfirmed") || document.getElementById("image-dock-status").textContent.includes("未确认"));
      dockReply = post(r => r.url().includes("/_ccdx/ui/settings"));await page.locator("#image-dock-check").click();assert.equal((await dockReply).status(),200);
      dockReply = post(r => r.url().includes("/_ccdx/ui/settings"));await page.locator("#image-dock-repair").click();assert.equal((await dockReply).status(),200);
      dockReply = post(r => r.url().includes("/_ccdx/ui/settings"));await page.locator("#image-dock-enabled").uncheck();assert.equal((await dockReply).status(),200);
      assert.deepEqual(dockCalls,["enable","status","repair","disable"]);
      assert.equal(await page.locator('#image-models input[type="radio"]').count(),2);
      await open("#connection-bindings");
      const conversation = page.locator('#connection-bindings input[name="binding-model"][value*="gpt-conversation"]');await conversation.uncheck();await conversation.check();
      await page.route("**/_ccdx/ui/settings", route => route.request().method() === "POST" && JSON.parse(route.request().postData()).action === "image"
        ? route.fulfill({ status:409, contentType:"application/json", body:JSON.stringify({error:"Image model save refused"}) }) : route.continue());
      await page.locator('#image-models input[value="render-two"]').click();
      await page.waitForFunction(()=>document.getElementById("effect-image_enabled").textContent.includes("Image model save refused") && document.querySelector('#image-models input[value="render-one"]').checked);
      assert.equal(runtime.imageModels().selected_model,"render-one");await page.unroute("**/_ccdx/ui/settings");
      let reply=post(r=>r.url().includes("/_ccdx/ui/settings"));await page.locator('#image-models input[value="render-two"]').check();assert.equal((await reply).status(),200);
      assert.equal(readAccessSettings({home:root,env}).clients.codex.image_model,"render-two");
      await page.locator('#connection-bindings input[name="binding-image-model"][value="render-two"]:checked').waitFor({state:"attached"});await open("#connection-bindings");
      assert.equal(await page.locator('#connection-bindings input[name="binding-model"][value*="render-"]').count(),0);
      const before=runtime.connections().clients.find(c=>c.id==="codex");
      await page.locator('#connection-bindings input[name="binding-image-model"][value="render-one"]').check();
      reply=post(r=>r.url().includes("/_ccdx/ui/connections"));await page.locator('#connection-client-form button[type="submit"]').click();assert.equal((await reply).status(),200);
      const after=runtime.connections().clients.find(c=>c.id==="codex");
      for(const key of ["enabled","source","deployments","default_model","history_isolation"])assert.deepEqual(after[key],before[key],key);
      assert.equal(readAccessSettings({home:root,env}).clients.codex.image_model,"render-one");
      assert.equal(parse(fs.readFileSync(config,"utf8")).model,"gpt-conversation");assert.equal(parse(fs.readFileSync(config,"utf8")).image_model,undefined);
      await page.locator('#image-models input[value="render-one"]:checked').waitFor({state:"attached"});
      reply=post(r=>r.url().includes("/_ccdx/ui/settings"));await page.locator("#setting-image_enabled").uncheck();assert.equal((await reply).status(),200);
      await page.waitForFunction(()=>!document.getElementById("setting-image_enabled").hasAttribute("aria-busy"));
      await page.reload();await open("#image-models");await page.locator('#image-models input[value="render-one"]:checked').waitFor({state:"attached"});assert.equal(await page.locator("#setting-image_enabled").isChecked(),false);
      reply=post(r=>r.url().includes("/_ccdx/ui/settings"));await page.locator("#setting-image_enabled").check();assert.equal((await reply).status(),200);
      const body={model:"gpt-image-2",prompt:"A circle"};let response=await loopbackFetch(base+"/v1/images/generations",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});assert.equal(response.status,429);assert.equal(selectedRequest,"render-one");
      await page.locator('[data-route="models"]').click();await page.locator("#model-provider-github").click();await page.locator("#live-models-body tr").filter({hasText:"Render Two"}).waitFor();
      assert.match(await page.locator("#live-models-body").innerText(),/Render One/);
      registry.models={data:[chat,image("render-two")]};
      await page.locator('[data-route="codex"]').click();await page.locator("#refresh").click();await page.locator("#image-model-note").waitFor({state:"visible"});
      response=await loopbackFetch(base+"/v1/images/generations",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});assert.equal(response.status,503);assert.equal(dispatches,1);
      assert.equal(readAccessSettings({home:root,env}).clients.codex.image_model,"render-one");
      assert.deepEqual(errors,[]);report.push({engine,language,defaultOn:true,multipleSingleChoice:true,sourceCatalog:true,codexModelConfig:true,selectionPersisted:true,conversationUnchanged:true,staleModelFailsClosed:true,failedSaveRestored:true,cloudCalls:0});
    } finally { await context.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));handler.cleanup();await runtime.close();fs.rmSync(root,{recursive:true,force:true}); }
  } } finally { await browser.close(); }
}
console.log(JSON.stringify({cases:report}));
