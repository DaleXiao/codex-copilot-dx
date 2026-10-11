import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { parseCliArgs, cliHelp } from "../src/cli-options.mjs";
import { parseCodexToml } from "../src/config-toml.mjs";
import { runSuggestionCommand } from "../src/cli-suggestion.mjs";
import { computeSuggestionMcpConfig, readSuggestionConfig, suggestionConfigPath } from "../src/suggestion-config.mjs";
import { contextMessages, readSuggestionContext, suggestionThreadId } from "../src/suggestion-context.mjs";
import { generateSuggestion, suggestionAdapterUrl } from "../src/suggestion-provider.mjs";
import { createSuggestionMcp, runSuggestionStdio } from "../src/suggestion-mcp.mjs";

const ID = "11111111-2222-4333-8444-555555555555";
const OTHER = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const config = { enabled: true, model: "gpt-6-luna", reasoning_effort: "low", adapter_url: "http://127.0.0.1:2026/v1" };
const tool = (name = "suggest_next_message", args = {}, threadId = ID) => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args, _meta: { threadId } } });
function setup(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-suggestion-test-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env = { CODEX_HOME: path.join(home, "codex") }, output = { write() {} };
  const options = { home, env, output, resolveBinary: () => "/fake/codex", loadCatalog: async () => ({ modelIds: ["gpt-6-luna", "gpt-6.1-sol"], reasoningEfforts: { "gpt-6-luna": ["low"], "gpt-6.1-sol": ["low", "high"] } }) };
  return { home, env, options, settings: suggestionConfigPath({ env, home }), codex: path.join(env.CODEX_HOME,"config.toml") };
}
function write(file, text) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); }

test("suggestion grammar, help and invalid actions are isolated", () => {
  assert.equal(parseCliArgs(["suggestion"]).action, "status");
  for (const action of ["on", "off", "model", "status"]) assert.equal(parseCliArgs(["suggestion",action]).action, action);
  assert.equal(parseCliArgs(["suggestion","model","gpt-6.1-sol"]).model, "gpt-6.1-sol");
  assert.equal(parseCliArgs(["suggestion","--help"]).helpTopic,"suggestion");
  for (const args of [["unknown"],["on","extra"],["model","a","b"]]) assert.throws(() => parseCliArgs(["suggestion",...args]));
  assert.match(cliHelp("ccdx","suggestion"), /disabled by default/);
});

test("suggestions default off: status and off install nothing and do no lookup", async t => {
  const s=setup(t), options={...s.options, loadCatalog:()=>assert.fail("No model lookup"), resolveBinary:()=>assert.fail("No process lookup")};
  assert.equal((await runSuggestionCommand(options)).enabled,false);
  await runSuggestionCommand({...options,action:"off"});
  assert.equal(fs.existsSync(s.settings),false);assert.equal(fs.existsSync(s.codex),false);
});

test("model selection alone remains off and installs no MCP", async t => {
  const s=setup(t);
  await runSuggestionCommand({...s.options,action:"model",model:"gpt-6.1-sol"});
  assert.equal(readSuggestionConfig({filePath:s.settings}).enabled,false);
  assert.equal(readSuggestionConfig({filePath:s.settings}).model,"gpt-6.1-sol");
  assert.equal(fs.existsSync(s.codex),false);
});

test("on is idempotent; off preserves all unrelated Codex settings", async t => {
  const s=setup(t), original='model = "user-model"\n[features]\nlocal_thread_store_compression = false\n[mcp_servers.other]\ncommand = "keep"\n';
  write(s.codex,original);
  await runSuggestionCommand({...s.options,action:"on"});
  const content=fs.readFileSync(s.codex,"utf8"),mtime=fs.statSync(s.codex).mtimeMs;
  const parsed=parseCodexToml(content);assert.equal(parsed.model,"user-model");assert.equal(parsed.mcp_servers.ccdx_suggestion.enabled,true);
  assert.equal(parsed.features.local_thread_store_compression,false);
  const repeated=await runSuggestionCommand({...s.options,action:"on",loadCatalog:()=>assert.fail("Already configured")});
  assert.equal(repeated.changed,false);assert.equal(fs.statSync(s.codex).mtimeMs,mtime);
  await runSuggestionCommand({...s.options,action:"off"});
  assert.equal(readSuggestionConfig({filePath:s.settings}).enabled,false);
  assert.equal(parseCodexToml(fs.readFileSync(s.codex,"utf8")).mcp_servers.ccdx_suggestion.enabled,false);
});

test("existing foreign, inline and dotted MCP declarations are never taken over", async t => {
  const s=setup(t);
  for (const text of ['[mcp_servers.ccdx_suggestion]\ncommand="user"\n','mcp_servers = { ccdx_suggestion = { command = "user" } }\n','mcp_servers.ccdx_suggestion.command="user"\n','[profiles.custom.mcp_servers.ccdx_suggestion]\ncommand="user"\n']) {
    write(s.codex,text);
    assert.equal((await runSuggestionCommand({...s.options,action:"on",loadCatalog:()=>assert.fail("No lookup for owned config")})).skipped,true);
    assert.equal(fs.readFileSync(s.codex,"utf8"),text);assert.equal(fs.existsSync(s.settings),false);
  }
});

test("invalid settings/TOML and unavailable models fail without partial writes", async t => {
  const s=setup(t);
  write(s.codex,'key = "unterminated');
  await assert.rejects(runSuggestionCommand({...s.options,action:"on"}),/valid TOML/);
  fs.unlinkSync(s.codex);
  await assert.rejects(runSuggestionCommand({...s.options,action:"model",model:"missing"}),/not available/);
  assert.equal(fs.existsSync(s.settings),false);assert.equal(fs.existsSync(s.codex),false);
  write(s.settings,'{"enabled":"yes","model":"gpt-6-luna"}');
  await assert.rejects(runSuggestionCommand({...s.options,action:"on"}),/Invalid suggestion/);
});

test("numeric model picker supports cancellation and keeps feature disabled", async t => {
  const s=setup(t);
  assert.equal((await runSuggestionCommand({...s.options,action:"model",prompt:async()=>"q"})).cancelled,true);
  assert.equal(fs.existsSync(s.settings),false);
  const answers=["bad","2"];
  await runSuggestionCommand({...s.options,action:"model",prompt:async()=>answers.shift()});
  assert.equal(readSuggestionConfig({filePath:s.settings}).model,"gpt-6.1-sol");
  assert.equal(readSuggestionConfig({filePath:s.settings}).enabled,false);
});

test("model lookup preserves concurrently added unrelated configuration", async t => {
  const s=setup(t), load=s.options.loadCatalog;
  await runSuggestionCommand({...s.options,action:"on",loadCatalog:async()=>{
    write(s.codex,'model="concurrent"\n');write(s.settings,JSON.stringify({enabled:false,model:"gpt-6-luna",extra:"keep"}));return load();
  }});
  assert.equal(parseCodexToml(fs.readFileSync(s.codex,"utf8")).model,"concurrent");
  assert.equal(readSuggestionConfig({filePath:s.settings}).extra,"keep");
});

test("context identity is host-supplied, not guessed, and mismatches fail closed", () => {
  assert.equal(suggestionThreadId({threadId:ID}),ID);
  for(const meta of [{},{threadId:"../../secret"},{threadId:ID,"x-codex-turn-metadata":{thread_id:OTHER}}])assert.throws(()=>suggestionThreadId(meta));
});

test("context keeps bounded recent text only, chronological, without tools/reasoning/images", () => {
  const entries=[{item:{type:"reasoning",text:"SECRET REASONING"}},{item:{type:"mcpToolCall",result:"SECRET TOOL"}},
    {item:{type:"agentMessage",text:"answer"}},{item:{type:"userMessage",content:[{type:"image",url:"SECRET IMAGE"},{type:"text",text:"question"}]}}];
  assert.deepEqual(contextMessages(entries),[{role:"user",content:"question"},{role:"assistant",content:"answer"}]);
  const bounded=contextMessages(Array.from({length:100},()=>({item:{type:"agentMessage",text:"x".repeat(10000)}})));
  assert.ok(bounded.reduce((sum,m)=>sum+m.content.length,0)<=16000);
});

function readerProcess(page, chunks = false) {
  const proc=new EventEmitter();proc.stdout=new PassThrough();proc.stdin=new PassThrough();proc.exitCode=null;
  proc.kill=()=>{proc.exitCode=0;queueMicrotask(()=>proc.emit("exit",0));return true};
  proc.stdin.on("data",buffer=>{for(const line of buffer.toString().trim().split("\n")){
    const q=JSON.parse(line);if(!q.id)continue;
    assert.ok(["initialize","thread/items/list"].includes(q.method));
    if(q.id===2){assert.equal(q.params.limit,24);assert.equal(q.params.sortDirection,"desc");assert.equal(q.params.threadId,ID)}
    const bytes=Buffer.from(JSON.stringify({id:q.id,result:q.id===1?{}:page})+"\n");
    queueMicrotask(()=>{if(chunks)for(const byte of bytes)proc.stdout.write(Buffer.from([byte]));else proc.stdout.write(bytes)});
  }});return proc;
}
test("official reader handles split UTF-8 and only uses bounded read RPCs", async () => {
  let options;
  const messages=await readSuggestionContext(ID,{codex_binary:"/fake/codex",codex_home:"/fake/home"},{spawnFn:(binary,args,opts)=>{
    options=opts;assert.ok(args.includes("--stdio"));return readerProcess({data:[{item:{type:"agentMessage",text:"中文回复"}}]},true);
  }});
  assert.equal(messages[0].content,"中文回复");assert.equal(options.env.OPENAI_API_KEY,undefined);
});

test("provider enforces loopback, exact terminal state, output bounds and one request", async () => {
  for(const url of ["https://api.example/v1","http://evil.example/v1","http://user@127.0.0.1/v1","http://127.0.0.1/v1?token=x"])assert.throws(()=>suggestionAdapterUrl(url));
  let calls=0;
  const output=await generateSuggestion([{role:"user",content:"hello"}],config,{fetchImpl:async(url,options)=>{
    calls++;assert.equal(url,"http://127.0.0.1:2026/v1/responses");const body=JSON.parse(options.body);
    assert.equal(body.model,config.model);assert.equal(body.stream,false);assert.equal(body.service_tier,undefined);assert.equal(body.tools,undefined);assert.equal(body.store,false);assert.equal(body.reasoning.effort,"low");assert.equal(options.redirect,"error");
    return Response.json({status:"completed",output:[{type:"message",role:"assistant",content:[{type:"output_text",text:'{"suggestion":"What next?"}'}]}]});
  }});
  assert.equal(output,"What next?");assert.equal(calls,1);
  for(const status of ["incomplete","failed","cancelled"])await assert.rejects(generateSuggestion([],config,{fetchImpl:async()=>Response.json({status,output:[]})}),/did not complete/);
  await assert.rejects(generateSuggestion([],config,{fetchImpl:async()=>new Response("PRIVATE ERROR",{status:429})}),/HTTP 429/);
});

test("provider allows null, rejects invalid text and aborts stalled response bodies", async () => {
  const response=text=>Response.json({status:"completed",output:[{type:"message",role:"assistant",content:[{type:"output_text",text}]}]});
  assert.equal(await generateSuggestion([],config,{fetchImpl:async()=>response('{"suggestion":null}')}),null);
  for(const text of ["bad",'{"suggestion":""}',JSON.stringify({suggestion:"x".repeat(301)}),JSON.stringify({suggestion:"two\nlines"})])await assert.rejects(generateSuggestion([],config,{fetchImpl:async()=>response(text)}));
  const abort=new AbortController();const pending=generateSuggestion([],config,{signal:abort.signal,fetchImpl:async()=>new Response(new ReadableStream({start(){}}))});
  abort.abort(new Error("cancelled"));await assert.rejects(pending,/cancelled/);
});

test("disabled MCP performs no reads or generation; only the panel tool is model-facing", async () => {
  const handle=createSuggestionMcp({loadConfig:()=>({...config,enabled:false}),readContext:()=>assert.fail("disabled"),generate:()=>assert.fail("disabled")});
  assert.deepEqual(await handle({method:"tools/list"}),{tools:[]});await assert.rejects(handle(tool()),/disabled/);
  const enabled=createSuggestionMcp({loadConfig:()=>config});const list=await enabled({method:"tools/list"});
  assert.deepEqual(list.tools[1]._meta.ui.visibility,["app"]);
});

test("MCP candidates bind to thread/model, expire, and never write/send", async () => {
  let now=1,selected={...config},calls=0;
  const handle=createSuggestionMcp({loadConfig:()=>selected,now:()=>now,readContext:async id=>{assert.equal(id,ID);return[]},generate:async()=>{calls++;return "Next?"}});
  const generated=(await handle(tool())).structuredContent;
  assert.equal(calls,1);
  const valid=await handle(tool("prepare_suggestion_draft",{candidate_id:generated.candidate_id}));assert.equal(valid.structuredContent.suggestion,"Next?");assert.equal(calls,1);
  await assert.rejects(handle(tool("prepare_suggestion_draft",{candidate_id:generated.candidate_id},OTHER)),/conversation changed/);
  selected={...config,model:"gpt-6.1-sol"};await assert.rejects(handle(tool("prepare_suggestion_draft",{candidate_id:generated.candidate_id})),/expired/);
  selected={...config};now+=600001;await assert.rejects(handle(tool("prepare_suggestion_draft",{candidate_id:generated.candidate_id})),/expired/);
});

test("MCP bounds parallel work and disabling between context/read prevents inference", async () => {
  let finish,reads=0,enabled=true;
  const wait=new Promise(resolve=>finish=resolve);
  const handle=createSuggestionMcp({loadConfig:()=>({...config,enabled}),readContext:async()=>{reads++;await wait;return[]},generate:()=>assert.fail("disabled before inference")});
  const a=handle(tool()),b=handle(tool());await assert.rejects(handle(tool()),/busy/);assert.equal(reads,2);
  enabled=false;finish();await assert.rejects(a,/settings changed/);await assert.rejects(b,/settings changed/);
});

test("review: empty model lists fail before prompting and concurrent model edits are preserved", async t => {
  const s=setup(t);
  await assert.rejects(runSuggestionCommand({...s.options,action:"model",loadCatalog:async()=>({modelIds:[]}),prompt:()=>assert.fail("No empty picker")}),/No selectable/);
  const load=s.options.loadCatalog;
  await runSuggestionCommand({...s.options,action:"on",loadCatalog:async()=>{write(s.settings,JSON.stringify({enabled:false,model:"gpt-6.1-sol"}));return load()}});
  assert.equal(readSuggestionConfig({filePath:s.settings}).model,"gpt-6.1-sol");
});

test("review: disabling known registration works even if the preference file was removed", async t => {
  const s=setup(t);await runSuggestionCommand({...s.options,action:"on"});fs.unlinkSync(s.settings);
  await runSuggestionCommand({...s.options,action:"off"});
  assert.equal(parseCodexToml(fs.readFileSync(s.codex,"utf8")).mcp_servers.ccdx_suggestion.enabled,false);
});

test("review: provider errors never echo a malformed raw upstream body", async () => {
  await assert.rejects(generateSuggestion([],config,{fetchImpl:async()=>new Response("PRIVATE RESPONSE")}),error=>!error.message.includes("PRIVATE")&&/invalid suggestion/.test(error.message));
  for(const body of [null,{status:"completed",output:{}},{status:"completed",output:[null]}])await assert.rejects(generateSuggestion([],config,{fetchImpl:async()=>Response.json(body)}));
});

test("review: malformed arguments and cancelled work cannot produce a candidate", async () => {
  const handle=createSuggestionMcp({loadConfig:()=>config,readContext:async()=>[],generate:async()=>"Next?"});
  await assert.rejects(handle(tool("suggest_next_message",[])),/Invalid/);
  const controller=new AbortController();controller.abort();await assert.rejects(handle(tool(),{signal:controller.signal}),/cancelled/);
});

test("stdio supports initialization, rejects bad JSON, and cancels pending calls", async () => {
  const input=new PassThrough(),output=new PassThrough();let data="",cancelled=false;
  output.on("data",chunk=>data+=chunk);
  runSuggestionStdio({input,output,handle:async(q,{signal})=>q.method==="initialize"?{}:new Promise((resolve,reject)=>signal.addEventListener("abort",()=>{cancelled=true;reject(new Error("Cancelled"))},{once:true}))});
  input.write('not-json\n');input.write(JSON.stringify({jsonrpc:"2.0",id:1,method:"initialize"})+"\n");
  input.write(JSON.stringify({jsonrpc:"2.0",id:2,method:"tools/call"})+"\n");await new Promise(resolve=>setImmediate(resolve));
  input.write(JSON.stringify({jsonrpc:"2.0",method:"notifications/cancelled",params:{requestId:2}})+"\n");await new Promise(resolve=>setImmediate(resolve));
  assert.equal(cancelled,true);const replies=data.trim().split("\n").map(JSON.parse);assert.equal(replies[0].error.code,-32700);assert.ok(replies.find(r=>r.id===1).result);input.end();
});
