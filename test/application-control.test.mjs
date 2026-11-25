import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createApplicationControl } from "../src/application-control.mjs";
import { createApplicationEvidence } from "../src/application-evidence.mjs";
import { applicationConnections, processFamily } from "../src/application-process.mjs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { userSettingsPath } from "../src/user-settings.mjs";
import { createAntigravityRuntime } from "../src/antigravity-runtime.mjs";

const running = { status: "running", app: "/Applications/Claude.app", target: "/Applications/Claude.app", identity: "com.anthropic.claudefordesktop", pid: 10, started: "2026-11-17T00:00:00.000Z" };
function fixture() {
  let now = Date.parse("2026-11-17T00:01:00Z"), app = { ...running }, revision = "first", inspections = 0;
  const calls = [];
  const controller = createApplicationControl({ now: () => now, platform: "darwin", env: {},
    inspect: async () => { inspections++;return { apps: { claude_app: { ...app } }, processes: [{ pid: 10, parent: 1 }, { pid: 11, parent: 10 }] }; },
    configuration: () => ({ state: "configured", revision }),
    connections: async () => [{ pid: 11, port: 2026, peerPort: 10000 }],
    control: async (_info, action) => { calls.push(action);if (action === "quit") app.status = "stopped";return "sent"; },
    exec: async (command, args) => { calls.push([command, args]);return { stdout: "" }; },
    providerRuntime: { prepareApplication: async id => calls.push("prepare:" + id) },
    wait: async ms => { now += ms; },
  });
  return { controller, calls, app, advance(ms) { now += ms; }, revision(value) { revision = value; }, inspections: () => inspections };
}
function request(evidence, app = "claude_app", status = 200, scope = "catalog") {
  const req = { socket: { remotePort: 10000, localPort: 2026 } }, res = new EventEmitter();res.statusCode = status;
  evidence.notice(req, res, app, scope);res.emit("finish");
}

test("a live socket alone stays pending; accepted protocol evidence binds the current process", async () => {
  const f = fixture();assert.equal((await f.controller.check("claude_app")).connection, "pending");
  request(f.controller.evidence, "claude_app", 401);assert.equal((await f.controller.check("claude_app")).connection, "pending");
  request(f.controller.evidence);assert.equal((await f.controller.check("claude_app")).connection, "observed");
  assert.equal(f.calls.length, 0);assert.equal(f.inspections(), 1, "A short shared inventory cache avoids repeated process scans");
  f.app.pid = 20;f.app.started = "2026-11-17T00:01:01.000Z";f.advance(4000);
  assert.equal((await f.controller.check("claude_app", true)).connection, "pending", "Old evidence cannot confirm a new process");
});

test("running open only focuses; read-only checks never activate or overwrite configuration", async () => {
  const f = fixture();await f.controller.action({ id: "claude_app", operation: "check" });
  assert.deepEqual(f.calls, []);assert.equal((await f.controller.action({ id: "claude_app", operation: "open" })).status, "focused");
  assert.deepEqual(f.calls, ["focus"]);
  f.revision("changed");await f.controller.check("claude_app", true);
  assert.equal((await f.controller.action({ id: "claude_app", operation: "open" })).status, "needs_app_relaunch");
  assert.deepEqual(f.calls, ["focus"]);await assert.rejects(f.controller.action({ id: "claude_app", operation: "restart" }), /Confirm/);
  assert.deepEqual(f.calls, ["focus"]);
});

test("confirmed reopen is graceful, prepares owned configuration, and does not launch twice", async () => {
  const f = fixture();const result = await f.controller.action({ id: "claude_app", operation: "restart", confirmed: true });
  assert.equal(result.status, "opened");assert.equal(result.app.connection, "pending");
  assert.equal(f.calls[0], "quit");assert.equal(f.calls[1], "prepare:claude_app");
  assert.deepEqual(f.calls[2], ["/usr/bin/open", ["-a", "/Applications/Claude.app"]]);
  assert.equal((await f.controller.action({ id: "claude_app", operation: "open" })).status, "opening");
  assert.equal(f.calls.length, 3);
});

test("unknown, multiple and stopped focus states never create another process", async () => {
  for (const status of ["unknown", "multiple", "not_installed", "unsupported"]) {
    const f = fixture();f.app.status = status;
    assert.equal((await f.controller.action({ id: "claude_app", operation: "open" })).status, status);assert.deepEqual(f.calls, []);
  }
  const f = fixture();f.app.status = "stopped";assert.equal((await f.controller.action({ id: "claude_app", operation: "focus" })).status, "app_not_running");
  assert.deepEqual(f.calls, []);
});

test("configuration changes and old protocol events cannot refresh adoption; missing metadata stays pending", () => {
  let now = Date.parse("2026-11-17T00:01:00Z");const evidence = createApplicationEvidence({ now: () => now });
  request(evidence);const sockets = [{ port: 2026, peerPort: 10000 }];
  assert.equal(evidence.inspect("claude_app", running, sockets, "v1").state, "observed");
  now += 10;assert.equal(evidence.inspect("claude_app", running, sockets, "v2", now).state, "pending");
  request(evidence);assert.equal(evidence.inspect("claude_app", running, sockets, "v2", now).state, "observed");
  now += 300001;assert.equal(evidence.inspect("claude_app", running, sockets, "v2").state, "pending");
  assert.equal(evidence.inspect("claude_app", {}, sockets, "v2").state, "pending");
  const json = JSON.stringify(evidence);assert.doesNotMatch(json, /authorization|prompt|api.key/);
});

test("OS connection lookup is scoped to the current family and numeric endpoints only", async () => {
  assert.deepEqual(processFamily([{ pid: 1, parent: 0 }, { pid: 2, parent: 1 }, { pid: 3, parent: 4 }], 1).map(row => row.pid), [1, 2]);
  const calls = [];
  const sockets = await applicationConnections([10, 11], 2026, { platform: "darwin", exec: async (command, args) => {
    calls.push([command, args]);return { stdout: "p11\nn127.0.0.1:10000->127.0.0.1:2026\np99\nn127.0.0.1:20000->127.0.0.1:2026\nn203.0.113.1:100->127.0.0.1:2026\n" };
  } });
  assert.deepEqual(sockets, [{ pid: 11, peerPort: 10000, port: 2026 }]);
  assert.ok(calls[0][1].includes("10,11"));assert.ok(calls[0][1].includes("-nP"));
});

test("legacy and header Antigravity opens share one verified home-folder launch", async t => {
  const home=await fs.mkdtemp(path.join(os.tmpdir(),"ccdx-shared-app-"));t.after(()=>fs.rm(home,{recursive:true,force:true}));
  const env={},file=userSettingsPath({home,env});await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,JSON.stringify({gemini_antigravity_enabled:true}));
  const app=path.join(home,"Applications/Gemini.app"),calls=[];
  const controller=createApplicationControl({home,env,platform:"darwin",connections:async()=>[],configuration:()=>({state:"configured",revision:"same"}),
    inspect:async()=>({apps:{antigravity:{status:"stopped",app,target:app}},processes:[]}),
    inspectGemini:async input=>{calls.push(["verify",input.app]);return{status:"stopped",app:input.app,pids:[]}},
    exec:async(command,args)=>{calls.push([command,args]);return{stdout:""}}});
  const legacy=createAntigravityRuntime({home,env,applicationControl:controller,client:{},models:()=>[]});t.after(()=>legacy.close());
  const results=await Promise.all([controller.action({id:"antigravity",operation:"open"}),legacy.action({action:"open"},"http://127.0.0.1:2026")]);
  assert.equal(results[0].status,"opened");assert.equal(calls.filter(([kind])=>kind==="verify").length,1);assert.equal(calls.filter(([kind])=>kind==="/usr/bin/open").length,1);
  assert.deepEqual(calls[1],["/usr/bin/open",["-a",app,"--env","CLOUD_CODE_URL=http://127.0.0.1:2026/antigravity"]]);
  assert.equal(legacy.snapshot().app.status,"starting");assert.equal(controller.snapshot().antigravity.status,"starting");assert.equal(controller.busy(),false);
});

test("Windows Antigravity shares verified launch between CLI and dashboard control", async t => {
  const home=await fs.mkdtemp(path.join(os.tmpdir(),"ccdx-verified-windows-app-"));t.after(()=>fs.rm(home,{recursive:true,force:true}));
  const env={},file=userSettingsPath({home,env});await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,JSON.stringify({gemini_antigravity_enabled:true}));
  const app=String.raw`C:\Users\fixture\AppData\Local\Programs\Antigravity\Antigravity.exe`,calls=[];
  const controller=createApplicationControl({home,env,platform:"win32",
    inspect:async()=>({apps:{antigravity:{status:"stopped",app,target:app}},processes:[]}),
    configuration:()=>({state:"configured",revision:"fixture"}),
    inspectGemini:async input=>{calls.push({verified:input.app});return {status:"stopped",app,pids:[]};},
    launchWindowsGemini:async plan=>calls.push(plan)});
  const legacy=createAntigravityRuntime({home,env,platform:"win32",applicationControl:controller,client:{},models:()=>[]});t.after(()=>legacy.close());
  const [opened,next]=await Promise.all([legacy.action({action:"open"},"http://127.0.0.1:2026"),controller.action({id:"antigravity",operation:"open"})]);
  assert.equal(opened.last_operation.status,"opened");
  assert.equal(next.status,"opening");
  assert.deepEqual(calls,[{verified:app},{status:"prepared",command:app,args:[],environment:{CLOUD_CODE_URL:"http://127.0.0.1:2026/antigravity"}}]);
});
