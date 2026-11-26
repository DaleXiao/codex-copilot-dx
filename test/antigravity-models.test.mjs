import test from "node:test";
import assert from "node:assert/strict";
import {antigravityCopilotModels,antigravityGroupingClient,groupedAntigravityRoutes,mergeAntigravityModels} from "../src/antigravity-models.mjs";
import {antigravityToChat} from "../src/antigravity-chat-bridge.mjs";

const model=(id,levels=["low","medium","high","xhigh"])=>({id,name:id.split("-").map(s=>s[0].toUpperCase()+s.slice(1)).join(" "),model_picker_enabled:true,
  supported_endpoints:["/chat/completions"],capabilities:{type:"chat",supports:{tool_calls:true,streaming:true,vision:true,reasoning_effort:levels},limits:{max_context_window_tokens:1048576,max_output_tokens:65536}}});
test("Antigravity discovers compatible Gemini families and each model's advertised efforts",()=>{
  const catalog={data:[model("gemini-4-hydrogen"),model("gemini-3.8-flash",["low","high"]),model("gemini-5-future",["high","turbo"])]},before=structuredClone(catalog);
  const result=antigravityCopilotModels(catalog);
  assert.deepEqual(result.filter(x=>x.model==="gemini-4-hydrogen").map(x=>x.effort),["low","medium","high","xhigh"]);
  assert.equal(result.find(x=>x.effort==="xhigh").id,"ccdx-copilot-gemini-4-hydrogen-xhigh");
  assert.equal(result.filter(x=>x.model==="gemini-3.8-flash").length,2);assert.ok(result.some(x=>x.effort==="turbo"));
  const target=result.find(x=>x.effort==="turbo");assert.equal(antigravityToChat({contents:[]},{model:target.model,effort:target.effort,reasoningEfforts:[target.effort]}).chat.reasoning_effort,"turbo");
  assert.deepEqual(catalog,before);
});
test("unavailable, image-only and incompatible models are excluded without inventing support",()=>{
  const good=model("gemini-4-hydrogen");
  for(const entry of [{...good,model_picker_enabled:false},{...good,policy:{state:"disabled"}},{...good,policy:{state:"unconfigured"}},
    {...good,supported_endpoints:["/responses"]},{...good,capabilities:{...good.capabilities,type:"image"}},
    {...good,capabilities:{supports:{tool_calls:false}}},{...good,capabilities:{supports:{streaming:false}}},{...good,id:"gpt-other"}])assert.deepEqual(antigravityCopilotModels({data:[entry]}),[]);
  const duplicate={data:[{id:good.id},good]};assert.equal(antigravityCopilotModels(duplicate).length,4);
});
test("models without efforts keep a plain alias and native Google entries remain untouched",()=>{
  const plain=model("gemini-future",[]),native={models:{google:{model:"NATIVE",displayName:"Native Google"}}},before=structuredClone(native);
  const merged=mergeAntigravityModels(native,{data:[plain]});const entry=merged.models["ccdx-copilot-gemini-future"];
  assert.ok(entry);assert.equal(entry.supportsThinking,false);assert.deepEqual(merged.models.google,native.models.google);assert.deepEqual(native,before);
  assert.equal(antigravityCopilotModels([model("gemini-4-carbon",["low"] )])[0].id,"ccdx-copilot-gemini-4-carbon-low");
});
test("native menu groups retain selected variant ids and the preferred default effort",()=>{
  const base="ccdx-copilot-gemini-4-hydrogen",preferred=base+"-xhigh";
  for(const hasNativeGroup of [false,true]){
    const native={models:{google:{model:"GOOGLE"},"google-low":{model:"GOOGLE_LOW"},"google-high":{model:"GOOGLE_HIGH"}},
      defaultAgentModelId:"google",agentModelSorts:[{displayName:"Recommended",groups:[{modelIds:["google"]}]}],
      ...(hasNativeGroup?{groupedModels:{google:{displayName:"Google",defaultThinkingSuffix:"low",
        supportedThinkingLevels:[{thinkingSuffix:"low",thinkingDisplayName:"Low"},{thinkingSuffix:"high",thinkingDisplayName:"High"}]}}}:{})};
    const before=structuredClone(native),merged=mergeAntigravityModels(native,[model("gemini-4-hydrogen")],[base+"-low",preferred],preferred,[],!hasNativeGroup);
    assert.deepEqual(native,before);
    assert.deepEqual(merged.groupedModels.google,native.groupedModels?.google);
    assert.deepEqual(merged.agentModelSorts[0].groups[0].modelIds,["google",base+"-low",preferred]);
    assert.deepEqual(merged.groupedModels[base].supportedThinkingLevels.map(level=>level.thinkingSuffix),["low","xhigh"]);
    assert.equal(merged.groupedModels[base].defaultThinkingSuffix,"xhigh");
    assert.equal(groupedAntigravityRoutes(base,merged.groupedModels[base],merged.models).defaultAlias,preferred);
    assert.equal(merged.defaultAgentModelId,preferred);
    // The picker can only group variants that become client options via a sort.
    const selectable=new Set(merged.agentModelSorts[0].groups[0].modelIds);
    assert.ok(Object.hasOwn(merged.models,base));
    assert.ok(merged.groupedModels[base].supportedThinkingLevels.every(level=>selectable.has(base+"-"+level.thinkingSuffix)));
    assert.equal(Object.hasOwn(merged.models,base+"-medium"),false);
    assert.equal(new Set(Object.values(merged.models).map(item=>item.model)).size,Object.keys(merged.models).length);
  }
});
test("verified Antigravity versions can group a flat Google catalog and old clients keep their flat entries",()=>{
  for(const version of ["2.35.1","2.35.2.0","2.40.0.0"]) assert.equal(antigravityGroupingClient(version),true);
  for(const version of [undefined,"2.34.9","3.0.0","2.35"]) assert.equal(antigravityGroupingClient(version),false);
  const native={models:{google:{model:"GOOGLE"}}};
  const copilot=[model("gemini-4-neon")];
  const base="ccdx-copilot-gemini-4-neon";
  const legacy=mergeAntigravityModels(native,copilot),supported=mergeAntigravityModels(native,copilot,null,null,[],true);
  const variants=["low","medium","high","xhigh"].map(effort=>base+"-"+effort);
  assert.equal(legacy.groupedModels,undefined);
  assert.deepEqual(legacy.agentModelSorts[0].groups[0].modelIds,variants);
  assert.deepEqual(supported.agentModelSorts[0].groups[0].modelIds,variants);
  assert.deepEqual([...groupedAntigravityRoutes(base,supported.groupedModels[base],supported.models).aliases.values()],variants);
});
test("published aliases without explicit effort form a native group when their identifiers match",()=>{
  const modelId="gemini-4-neon",base="ccdx-copilot-"+modelId;
  const variants=["low","high"].map(effort=>({...model(modelId+"-"+effort,[]),base_model_id:modelId,reasoning_effort:effort}));
  const merged=mergeAntigravityModels({models:{}},variants,null,null,[],true);
  assert.deepEqual(merged.agentModelSorts[0].groups[0].modelIds,[base+"-low",base+"-high"]);
  assert.deepEqual([...groupedAntigravityRoutes(base,merged.groupedModels[base],merged.models).aliases.values()],[base+"-low",base+"-high"]);
});
