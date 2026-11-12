import test from "node:test";
import assert from "node:assert/strict";
import {Readable} from "node:stream";
import {EventEmitter} from "node:events";
import {createAntigravityHandler} from "../src/antigravity-handler.mjs";
import {antigravityCopilotModels,mergeAntigravityModels} from "../src/antigravity-models.mjs";

const catalog={data:["gemini-4-carbon","gemini-4-argon"].map(id=>({id,supported_endpoints:["/chat/completions"],capabilities:{supports:{vision:true,reasoning_effort:["low","medium","high"]},limits:{max_context_window_tokens:1000000,max_output_tokens:64000}}}))};
const alias=antigravityCopilotModels(catalog)[2].id;
const body=(model=alias,requestType="agent")=>({model,requestType,request:{contents:[{role:"user",parts:[{text:"fixture"}]}],generationConfig:{thinkingConfig:{includeThoughts:true,thinkingBudget:4096}}}});
const sse=(content="ok")=>new Response('data: '+JSON.stringify({choices:[{delta:{content},finish_reason:"stop"}]})+'\n\ndata: [DONE]\n\n');
function fixture(options={}){
  const google=[],copilot=[];
  const handler=createAntigravityHandler({enabled:()=>true,models:()=>catalog,
    fetchGoogle:async(url,request)=>{google.push({url,request});return Response.json({native:true})},
    client:{chatCompletions:async(value,options)=>{copilot.push({value,options});return sse()}},...options});
  return {handler,google,copilot};
}
function invoke(handler,value,{url="/antigravity/v1internal:streamGenerateContent?alt=sse",raw,headers={},onWrite}={}){
  const req=Readable.from([Buffer.from(raw??JSON.stringify(value))]);req.method="POST";req.url=url;req.headers={host:"127.0.0.1:2026","content-type":"application/json",authorization:"Bearer GOOGLE_FIXTURE",...headers};req.socket={remoteAddress:"127.0.0.1"};
  const res=new EventEmitter(),chunks=[];Object.assign(res,{destroyed:false,writableEnded:false,headersSent:false,statusCode:200,headers:{},
    writeHead(status,headers){this.statusCode=status;this.headers=headers;this.headersSent=true;return this},
    write(value){chunks.push(Buffer.from(value));onWrite?.(value);return true},end(value){if(value)this.write(value);this.writableEnded=true;this.emit("finish")}});
  const done=handler(req,res).then(()=>({status:res.statusCode,text:Buffer.concat(chunks).toString(),res}));return {done,req,res};
}

test("catalog merging preserves native models, defaults, and quotas without enum collisions",()=>{
  const native={models:{native:{model:"MODEL_PLACEHOLDER_M500",quotaInfo:{remaining:10}}},defaultAgentModelId:"native",agentModelSorts:[{groups:[{modelIds:["native"]}]}],entitlements:{keep:true}};
  const before=structuredClone(native),result=mergeAntigravityModels(native,catalog);
  assert.deepEqual(native,before);assert.deepEqual(result.models.native,before.models.native);assert.equal(result.defaultAgentModelId,"native");assert.deepEqual(result.entitlements,{keep:true});
  assert.equal(new Set(Object.values(result.models).map(x=>x.model)).size,7);assert.equal(result.agentModelSorts[0].groups[0].modelIds[0],"native");
  assert.ok(antigravityCopilotModels(catalog).every(model=>model.displayName.toLowerCase().includes("gemini")),"Gemini App filters models by their display label");
  assert.equal(result.agentModelSorts[0].groups[0].modelIds.length,7,"Native and Copilot models must share the first group for Gemini App");
  assert.equal(mergeAntigravityModels(native,[]),native);
});
test("Copilot main requests use the advertised model and level without forwarding Google authorization",async()=>{
  const f=fixture(),result=await invoke(f.handler,body()).done;
  assert.equal(result.status,200);assert.equal(f.google.length,0);assert.equal(f.copilot.length,1);
  assert.equal(f.copilot[0].value.model,"gemini-4-carbon");assert.equal(f.copilot[0].value.reasoning_effort,"high");assert.equal(JSON.stringify(f.copilot).includes("GOOGLE_FIXTURE"),false);
  assert.match(result.text,/"finishReason":"STOP"/);assert.equal(f.copilot[0].options.retryOptions.retries,0);
});
test("native Google main requests retain their model and authorization",async()=>{
  const f=fixture();assert.equal((await invoke(f.handler,body("gemini-4-argon")).done).status,200);
  assert.equal(f.copilot.length,0);assert.equal(f.google.length,1);assert.equal(f.google[0].request.headers.authorization,"Bearer GOOGLE_FIXTURE");
  assert.equal(JSON.parse(f.google[0].request.body).model,"gemini-4-argon");
});
test("unattributed background summaries use Copilot even when the requested model is Google",async()=>{
  const f=fixture();const result=await invoke(f.handler,body("gemini-3.8-flash","checkpoint")).done;
  assert.equal(result.status,200);assert.equal(f.google.length,0);assert.equal(f.copilot[0].value.model,"gemini-4-carbon");assert.equal(f.copilot[0].value.reasoning_effort,"low");
});
test("search uses Copilot sources and never Google's inference service",async()=>{
  const queries=[],f=fixture({searchFn:async(value)=>{queries.push(value);return Response.json({output:"Fixture excerpt",results:[{type:"text_result",url:"https://example.test/actual",title:"Fixture"}]})}});
  const result=await invoke(f.handler,body("gemini-3.8-flash","web_search"),{url:"/antigravity/v1internal:generateContent"}).done;
  assert.equal(result.status,200);assert.equal(f.google.length,0);assert.equal(f.copilot.length,0);assert.equal(queries[0].commands.search_query[0].q,"fixture");
  assert.equal(JSON.parse(result.text).response.candidates[0].groundingMetadata.groundingChunks[0].web.uri,"https://example.test/actual");
});
test("unsupported or paused Copilot requests never fall back to Google",async()=>{
  let background=0;
  const f=fixture({models:()=>({data:[]}),searchFn:async()=>{background++},imageFn:async()=>{background++}});
  for(const type of ["agent","checkpoint","web_search","image_gen"])assert.equal((await invoke(f.handler,body(alias,type)).done).status,503);
  assert.equal(f.google.length,0);assert.equal(background,0);
  const unknown=fixture();assert.equal((await invoke(unknown.handler,body(alias,"unknown_activity")).done).status,400);assert.equal(unknown.google.length,0);
});
test("ordinary Gemini endpoints and browser-origin callers cannot enter the Antigravity bridge",async()=>{
  const f=fixture();assert.equal((await invoke(f.handler,body(),{url:"/gemini/chat"}).done).status,404);
  assert.equal((await invoke(f.handler,body(),{headers:{origin:"https://example.test"}}).done).status,403);assert.equal(f.google.length+f.copilot.length,0);
});
test("large tool integers survive the incoming request and outgoing function call",async()=>{
  let seen;const f=fixture({client:{chatCompletions:async value=>{seen=value;return new Response('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call","function":{"name":"read","arguments":"{\\"n\\":9007199254740993}"}}]},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n')}}});
  const value=body();value.request.tools=[{functionDeclarations:[{name:"read",parameters:{type:"OBJECT",properties:{n:{type:"INTEGER"}}}}]}];
  value.request.contents.push({role:"model",parts:[{functionCall:{id:"prior",name:"read",args:{n:1}}}]},{role:"user",parts:[{functionResponse:{id:"prior",name:"read",response:{output:"ok"}}}]});
  const raw=JSON.stringify(value).replace('"n":1','"n":9007199254740993');const result=await invoke(f.handler,value,{raw}).done;
  assert.equal(result.status,200);assert.match(seen.messages.find(x=>x.tool_calls).tool_calls[0].function.arguments,/9007199254740993/);assert.match(result.text,/9007199254740993/);
});
test("a truncated upstream stream reports an error without a successful finish",async()=>{
  const f=fixture({client:{chatCompletions:async()=>new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n')}}),result=await invoke(f.handler,body()).done;
  assert.match(result.text,/partial/);assert.match(result.text,/ended before completion/);assert.doesNotMatch(result.text,/"finishReason":"STOP"/);
});
test("privacy sessions restore split text tokens and release on completion",async()=>{
  const token="{{CCDX_"+"a".repeat(24)+"}}";let released=false,masked=false;
  const f=fixture({privacy:{prepareSession:async value=>{value.messages[0].content=token;masked=true;return {body:value,count:1,restoreText:text=>text.replaceAll(token,"fixture-secret"),restoreValue:value=>value,restoreToolValue:value=>value,release(){released=true}}}},
    client:{chatCompletions:async()=>new Response('data: '+JSON.stringify({choices:[{delta:{content:token.slice(0,12)}}]})+'\n\ndata: '+JSON.stringify({choices:[{delta:{content:token.slice(12)},finish_reason:"stop"}]})+'\n\ndata: [DONE]\n\n')}});
  const result=await invoke(f.handler,body()).done;assert.equal(masked,true);assert.equal(released,true);assert.match(result.text,/fixture-secret/);assert.doesNotMatch(result.text,/CCDX_aaaa/);
});

test("unselected Copilot models are absent from discovery and rejected before either provider receives history",async()=>{
  const native={models:{native:{model:"NATIVE"}},agentModelSorts:[{groups:[{modelIds:["native"]}]}]};
  const merged=mergeAntigravityModels(native,catalog,[alias]);assert.deepEqual(Object.keys(merged.models),["native",alias]);
  assert.deepEqual(mergeAntigravityModels(native,catalog,[]),native);
  const f=fixture({selectedModels:()=>[]});const result=await invoke(f.handler,body()).done;
  assert.equal(result.status,503);assert.equal(f.google.length,0);assert.equal(f.copilot.length,0);
  const background=await invoke(f.handler,body("gemini-3.8-flash","checkpoint")).done;
  assert.equal(background.status,200);assert.equal(f.copilot.length,1);
});
