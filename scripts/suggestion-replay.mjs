// Real Codex/MCP integration using synthetic inference only; no installed-user writes.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { once } from "node:events";
import assert from "node:assert/strict";
import { computeSuggestionMcpConfig } from "../src/suggestion-config.mjs";
import { readSuggestionContext } from "../src/suggestion-context.mjs";

const binary = process.argv[2] === "--codex" ? process.argv[3] : process.env.CCDX_CODEX_BINARY;
assert.ok(binary && path.isAbsolute(binary), "Supply --codex /absolute/path/to/codex");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "ccdx-suggestion-replay-"));
const home = path.join(root,"codex"), settings = path.join(root,"suggestion.json");
let proc, next=0, modelCalls=0, suggestionCalls=0, fixtureError;
const pending=new Map(),events=[];
const server=http.createServer((req,res)=>{void(async()=>{
  const chunks=[];for await(const chunk of req)chunks.push(chunk);
  const body=JSON.parse(Buffer.concat(chunks));assert.equal(req.url,"/v1/responses");
  if(body.model==="gpt-6-luna") {
    suggestionCalls++;assert.ok(suggestionCalls<=1);assert.equal(body.stream,false);assert.equal(body.service_tier,undefined);
    assert.match(body.input[0].content[0].text,/SYNTHETIC/);assert.doesNotMatch(body.input[0].content[0].text,/tool_search_output/);
    res.writeHead(200,{"Content-Type":"application/json"});res.end(JSON.stringify({status:"completed",output:[{type:"message",role:"assistant",content:[{type:"output_text",text:'{"suggestion":"Please explain the test plan."}'}]}]}));return;
  }
  modelCalls++;assert.ok(modelCalls<=3);let item;
  if(modelCalls===1)item={type:"tool_search_call",id:"ts_fixture",call_id:"search_fixture",execution:"client",arguments:{query:"ccdx_suggestion suggest_next_message",limit:1},status:"completed"};
  else if(modelCalls===2){
    const search=body.input.find(item=>item.type==="tool_search_output");assert.ok(search);
    const tools=search.tools.flatMap(t=>t.type==="namespace"?t.tools.map(s=>({...s,namespace:t.name})):[t]);
    const tool=tools.find(t=>t.name.endsWith("suggest_next_message"));assert.ok(tool);
    item={type:"function_call",id:"fc_fixture",call_id:"call_fixture",name:tool.name,...(tool.namespace?{namespace:tool.namespace}:{}),arguments:"{}",status:"completed"};
  } else item={type:"message",id:"msg_fixture",role:"assistant",phase:"final_answer",status:"completed",content:[{type:"output_text",text:"SYNTHETIC FINAL.",annotations:[]}]};
  const response={id:`resp_fixture_${modelCalls}`,object:"response",status:"completed",model:"gpt-5.5",output:[item],usage:{input_tokens:1,output_tokens:1,total_tokens:2}};
  const frames=[{type:"response.created",response:{...response,status:"in_progress",output:[]}},{type:"response.output_item.added",output_index:0,item},{type:"response.output_item.done",output_index:0,item},{type:"response.completed",response}];
  res.writeHead(200,{"Content-Type":"text/event-stream"});res.end(frames.map((e,index)=>`event: ${e.type}\ndata: ${JSON.stringify({...e,sequence_number:index})}\n\n`).join(""));
})().catch(error=>{fixtureError=error;res.writeHead(400);res.end("Synthetic fixture rejected request")})});
function call(method,params={}){return new Promise((resolve,reject)=>{const id=++next,timer=setTimeout(()=>{pending.delete(id);reject(new Error(`${method} timed out`))},15000);pending.set(id,{resolve:r=>{clearTimeout(timer);resolve(r)},reject:e=>{clearTimeout(timer);reject(e)}});proc.stdin.write(JSON.stringify({id,method,params})+"\n")})}
try {
  await fs.mkdir(home);
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  const base=`http://127.0.0.1:${server.address().port}/v1`;
  const config={enabled:true,model:"gpt-6-luna",reasoning_effort:"low",adapter_url:base,codex_binary:binary,codex_home:home};
  await fs.writeFile(settings,JSON.stringify(config));
  await fs.writeFile(path.join(home,"config.toml"),computeSuggestionMcpConfig("",{enabled:true,filePath:settings}).content);
  const overrides={model:"gpt-5.5",model_provider:"fixture","model_providers.fixture.name":"Offline fixture","model_providers.fixture.base_url":base,"model_providers.fixture.wire_api":"responses","model_providers.fixture.requires_openai_auth":false,"model_providers.fixture.supports_websockets":false,"features.plugins":false,"features.shell_snapshot":false,"analytics.enabled":false};
  proc=spawn(binary,[...Object.entries(overrides).flatMap(([key,value])=>["-c",`${key}=${JSON.stringify(value)}`]),"app-server","--stdio"],{cwd:root,env:{CODEX_HOME:home,PATH:[path.dirname(process.execPath),"/usr/bin","/bin"].join(path.delimiter),TMPDIR:root},stdio:["pipe","pipe","ignore"]});
  proc.once("error",error=>{for(const p of pending.values())p.reject(error)});
  proc.once("exit",()=>{for(const p of pending.values())p.reject(new Error("Fixture Codex exited"))});
  readline.createInterface({input:proc.stdout}).on("line",line=>{const message=JSON.parse(line),p=pending.get(message.id);if(p){pending.delete(message.id);message.error?p.reject(new Error(JSON.stringify(message.error))):p.resolve(message.result)}else events.push(message)});
  await call("initialize",{clientInfo:{name:"ccdx-suggestion-test",version:"1"},capabilities:{experimentalApi:true}});proc.stdin.write(JSON.stringify({method:"initialized",params:{}})+"\n");
  const {thread}=await call("thread/start",{cwd:root,model:"gpt-5.5",modelProvider:"fixture",approvalPolicy:"never",sandbox:"read-only",baseInstructions:"Synthetic test. Only use the requested suggestion tool."});
  await call("mcpServerStatus/list",{threadId:thread.id,serverName:"ccdx_suggestion",detail:"full"});
  await call("turn/start",{threadId:thread.id,input:[{type:"text",text:"SYNTHETIC: show a next-message suggestion about this test plan.",text_elements:[]}]});
  const deadline=Date.now()+20000;
  while(!events.some(e=>e.method==="turn/completed"&&e.params.threadId===thread.id)){if(Date.now()>deadline)throw new Error("Synthetic turn timed out");await new Promise(resolve=>setTimeout(resolve,25))}
  if(fixtureError)throw fixtureError;
  const completed=events.find(e=>e.method==="item/completed"&&e.params.item?.type==="mcpToolCall");
  assert.ok(completed);assert.equal(completed.params.item.result?.isError??false,false,JSON.stringify(completed.params.item));
  const candidate=completed.params.item.result.structuredContent;assert.equal(candidate.suggestion,"Please explain the test plan.");
  const draft=await call("mcpServer/tool/call",{threadId:thread.id,server:"ccdx_suggestion",tool:"prepare_suggestion_draft",arguments:{candidate_id:candidate.candidate_id}});
  assert.equal(draft.structuredContent.suggestion,candidate.suggestion);assert.equal(suggestionCalls,1);
  const before=await call("thread/items/list",{threadId:thread.id,limit:24,sortDirection:"desc"});
  await readSuggestionContext(thread.id,config);
  const after=await call("thread/items/list",{threadId:thread.id,limit:24,sortDirection:"desc"});assert.deepEqual(after,before);
  await fs.writeFile(settings,JSON.stringify({...config,enabled:false}));
  const disabled=await call("mcpServer/tool/call",{threadId:thread.id,server:"ccdx_suggestion",tool:"suggest_next_message",arguments:{}});assert.equal(disabled.isError,true);assert.equal(suggestionCalls,1);
  console.log(JSON.stringify({nativeMcpTool:true,paginatedContext:true,draftPrepared:true,threadUnchanged:true,disabledNoInference:true,syntheticPrimaryResponses:modelCalls,syntheticSuggestions:suggestionCalls,externalModelCalls:0}));
} finally {
  for(const p of pending.values())p.reject(new Error("Fixture closed"));pending.clear();
  if(proc&&proc.exitCode===null){const exited=once(proc,"exit");proc.kill("SIGTERM");const timer=setTimeout(()=>proc.kill("SIGKILL"),1000);await exited;clearTimeout(timer)}
  server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  await fs.rm(root,{recursive:true,force:true});
}
