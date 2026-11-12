import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import {createAntigravityImages} from "../src/antigravity-images.mjs";

const png=(await sharp({create:{width:16,height:16,channels:3,background:"blue"}}).png().toBuffer()).toString("base64");
const models=()=>[{id:"gpt-image-2.5-flare",capabilities:{type:"image"},supported_endpoints:["/v1/images/generations","/v1/images/edits"]}];
const request=parts=>({contents:[{role:"user",parts}]});

test("native image generation and editing preserve validated pixels and apply prompt privacy",async()=>{
  const calls=[];let released=0;
  const generate=createAntigravityImages({models,client:{images:async(operation,body)=>{calls.push({operation,body});return Response.json({data:[{b64_json:png}]})}},
    privacy:{prepareSession:async()=>({body:{input:"MASKED"},release(){released++}})}});
  for(const parts of [[{text:"fixture"}],[{text:"fixture"},{inlineData:{mimeType:"image/png",data:png}}]]){
    const result=await generate(request(parts));assert.equal(result.candidates[0].finishReason,"STOP");
    assert.deepEqual(result.candidates[0].content.parts,[{inlineData:{mimeType:"image/png",data:png}}]);
    assert.equal(calls.at(-1).body.prompt,"MASKED");assert.equal(calls.at(-1).body.model,"gpt-image-2.5-flare");
  }
  assert.deepEqual(calls.map(x=>x.operation),["generations","edits"]);assert.equal(released,2);
});
test("unsupported inputs and paused image models cannot dispatch",async()=>{
  let calls=0;const client={images:async()=>{calls++}};
  const generate=createAntigravityImages({models,client});
  for(const parts of [[],[{text:" "}],[{fileData:{fileUri:"https://example.test/x"}}],[{text:"fixture"},{inlineData:{mimeType:"application/pdf",data:"AA=="}}],[{text:"fixture"},{inlineData:{mimeType:"image/png",data:"AA=="}}]])await assert.rejects(generate(request(parts)));
  await assert.rejects(createAntigravityImages({models:()=>[],client})(request([{text:"fixture"}])));
  assert.equal(calls,0);
});
test("image errors and malformed pixels fail without retries and always release privacy state",async()=>{
  for(const response of [()=>new Response(null,{status:429}),()=>Response.json({data:[{b64_json:"AA=="}]}),()=>new Response("broken")]){
    let calls=0,released=0;
    const generate=createAntigravityImages({models,client:{images:async()=>{calls++;return response()}},privacy:{prepareSession:async body=>({body,release(){released++}})}});
    await assert.rejects(generate(request([{text:"fixture"}])));assert.equal(calls,1);assert.equal(released,1);
  }
});
