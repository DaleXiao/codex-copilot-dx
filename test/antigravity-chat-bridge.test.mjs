import test from "node:test";
import assert from "node:assert/strict";
import { antigravityToChat, chatStreamToAntigravity, chatToAntigravity, parseAntigravityJSON } from "../src/antigravity-chat-bridge.mjs";
import { createAntigravityOpaqueReasoning } from "../src/antigravity-opaque-reasoning.mjs";

test("chunked Chat content projects thinking and visible text in order", async () => {
  const content = [{ type: "thinking", thinking: [{ type: "text", text: "fixture thought" }] },
    { type: "text", text: "fixture answer" }];
  const expected = [{ text: "fixture thought", thought: true }, { text: "fixture answer" }];
  assert.deepEqual(chatToAntigravity({ choices: [{ message: { content }, finish_reason: "stop" }] }, new Map()).candidates[0].content.parts, expected);
  const wire = "data: " + JSON.stringify({ choices: [{ delta: { content }, finish_reason: "stop" }] }) + "\n\ndata: [DONE]\n\n";
  const parts = [];
  for await (const event of chatStreamToAntigravity(new Response(wire), new Map())) parts.push(...(event.response?.candidates?.[0]?.content?.parts || []));
  assert.deepEqual(parts, expected);
});

test("native zero-argument object schemas retain the explicit properties required by Copilot", () => {
  const parameters = { type: "OBJECT", properties: { options: { type: "OBJECT" }, name: { type: "STRING" } } };
  const request = { contents: [{ role: "user", parts: [{ text: "fixture" }] }], tools: [{ functionDeclarations: [
    { name: "list_plugin_accounts", parameters: { type: "OBJECT" } },
    { name: "configure", parameters },
  ] }] };
  const before = structuredClone(request), { chat } = antigravityToChat(request, { model: "gemini-4-carbon", effort: "high" });
  assert.deepEqual(chat.tools[0].function.parameters, { type: "object", properties: {} });
  assert.deepEqual(chat.tools[1].function.parameters.properties.options, { type: "object", properties: {} });
  assert.deepEqual(chat.tools[1].function.parameters.properties.name, { type: "string" });
  assert.deepEqual(request, before);
});

const declaration = { name: "view_file", description: "Read a file", parameters: { type: "OBJECT", properties: {
  AbsolutePath: { type: "STRING" }, offset: { type: "INTEGER" }, mode: { type: "STRING", enum: ["UPPER", "lower"] },
}, required: ["AbsolutePath"] } };

test("Antigravity keeps thought and answer fragments from the same upstream chunk", async () => {
  const events = [{ choices: [{ delta: { reasoning_content: "working", content: "19" } }] },
    { choices: [{ delta: { content: " items" }, finish_reason: "stop" }] }, { choices: [], usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 } }];
  const response = new Response(events.map(event => "data: " + JSON.stringify(event) + "\n\n").join("") + "data: [DONE]\n\n");
  const parts = [];let usage;
  for await (const event of chatStreamToAntigravity(response, new Map(), { onUsage: value => { if (value.usage) usage = value.usage; } })) parts.push(...(event.response?.candidates?.[0]?.content?.parts || []));
  assert.equal(parts.filter(part => !part.thought).map(part => part.text).join(""), "19 items");
  assert.equal(parts.filter(part => part.thought).map(part => part.text).join(""), "working");assert.equal(usage.total_tokens, 8);
});

test("Gemini history retains tool IDs, large integers, images, and declared schema", () => {
  const request = parseAntigravityJSON(`{"systemInstruction":{"role":"user","parts":[{"text":"system"}]},"contents":[
    {"role":"user","parts":[{"text":"inspect"},{"inlineData":{"mimeType":"image/png","data":"aGVsbG8="}}]},
    {"role":"model","parts":[{"functionCall":{"id":"call-one","name":"view_file","args":{"AbsolutePath":"/tmp/a","offset":9007199254740993}}}]},
    {"role":"model","parts":[{"functionResponse":{"id":"call-one","name":"view_file","response":{"output":"ok","size":9007199254740993}}}]}
  ],"generationConfig":{"maxOutputTokens":64000,"thinkingConfig":{"includeThoughts":true,"thinkingBudget":0}}}`);
  request.tools = [{ functionDeclarations: [declaration] }];
  const { chat } = antigravityToChat(request, { model: "gemini-4-carbon", effort: "high" });
  assert.equal(chat.messages[0].content, "system");
  assert.deepEqual(chat.messages[1].content, [{ type: "text", text: "inspect" }, { type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } }]);
  assert.equal(chat.messages[2].tool_calls[0].id, "call-one");
  assert.match(chat.messages[2].tool_calls[0].function.arguments, /9007199254740993/);
  assert.match(chat.messages[3].content, /9007199254740993/);
  assert.equal(chat.messages[3].tool_call_id, "call-one");
  assert.equal(chat.tools[0].function.parameters.type, "object");
  assert.deepEqual(chat.tools[0].function.parameters.properties.mode.enum, ["UPPER", "lower"]);
  assert.equal(chat.max_completion_tokens, 64000);
  assert.equal(chat.reasoning_effort, "high");
});

test("Chat tool calls restore their original names and exact arguments", () => {
  const tool = { name: "plugin.example/read", parameters: { type: "OBJECT", properties: {} } };
  const { chat, originalNames } = antigravityToChat({ contents: [{ role: "user", parts: [{ text: "read" }] }], tools: [{ functionDeclarations: [tool] }] }, { model: "gemini-4-argon", stream: false });
  const alias = chat.tools[0].function.name;
  const result = chatToAntigravity({ choices: [{ finish_reason: "tool_calls", message: { content: null,
    tool_calls: [{ id: "call-two", function: { name: alias, arguments: '{"number":9007199254740993,"_id":"item","_meta":{"__typename":"Record"}}' } }] } }] }, originalNames);
  assert.equal(result.candidates[0].content.parts[0].functionCall.name, tool.name);
  assert.match(JSON.stringify(result), /9007199254740993/);
  const { args } = result.candidates[0].content.parts[0].functionCall;
  assert.equal(args._id, "item");
  assert.deepEqual(args._meta, { __typename: "Record" });
  assert.throws(() => chatToAntigravity({ choices: [{ finish_reason: "tool_calls", message: { tool_calls: [{ id: "call-two", function: { name: alias, arguments: "{" } }] } }] }, originalNames), /arguments/);
});

test("unsupported tools, unmatched history, and denied tool calls fail explicitly", () => {
  const user = { role: "user", parts: [{ text: "hi" }] };
  assert.throws(() => antigravityToChat({ contents: [user], tools: [{ googleSearch: {} }] }, { model: "fixture" }), /cannot be represented/);
  assert.throws(() => antigravityToChat({ contents: [user, { role: "user", parts: [{ functionResponse: { name: "view_file", response: { output: "ok" } } }] }] }, { model: "fixture" }), /no matching call/);
  const { originalNames } = antigravityToChat({ contents: [user], tools: [{ functionDeclarations: [declaration] }], toolConfig: { functionCallingConfig: { mode: "NONE" } } }, { model: "fixture" });
  assert.throws(() => chatToAntigravity({ choices: [{ finish_reason: "tool_calls", message: { tool_calls: [{ id: "a", function: { name: "view_file", arguments: "{}" } }] } }] }, originalNames), /function call/);
});

test("native token budgets require an explicit advertised Copilot effort", () => {
  const request = { contents: [{ role: "user", parts: [{ text: "hello" }] }],
    generationConfig: { thinkingConfig: { includeThoughts: true, thinkingBudget: 4096 } } };
  assert.throws(() => antigravityToChat(request, { model: "gemini-4-carbon" }), /reasoning configuration/);
  assert.equal(antigravityToChat(request, { model: "gemini-4-carbon", effort: "high" }).chat.reasoning_effort,"high");
});

test("unsupported attachments are refused rather than silently omitted", () => {
  const request = { contents: [{ role: "user", parts: [{ inlineData: { mimeType: "application/pdf", data: "Zml4dHVyZQ==" } }] }] };
  assert.throws(()=>antigravityToChat(request,{model:"gemini-4-carbon"}),/not supported/);
  request.contents[0].parts[0].inlineData.mimeType="audio/wav";
  assert.throws(() => antigravityToChat(request, { model: "gemini-4-carbon" }), /not supported/);
});

test("unsupported Gemini parts identify the form and position without echoing part data", () => {
  const fixtures = [
    [{ text: "fixture", thoughtSignature: "fixture-signature" }, "ccdx_antigravity_thought_signature"],
    [{ functionCall: { name: "probe", args: {} }, thought_signature: "fixture-signature" }, "ccdx_antigravity_thought_signature"],
    [{ fileData: { fileUri: "https://fixture.invalid/file" } }, "ccdx_antigravity_file_reference"],
    [{ file_data: { file_uri: "fixture-path" } }, "ccdx_antigravity_file_reference"],
    [{ text: "fixture", partMetadata: { "fixture-key": "fixture-value" } }, "ccdx_antigravity_part_metadata"],
    [{ text: "fixture", "fixture-key": "fixture-value" }, "ccdx_antigravity_message_part"],
  ];
  for (const [part, code] of fixtures) {
    assert.throws(() => antigravityToChat({ contents: [
      { role: "user", parts: [{ text: "fixture" }] },
      { role: "model", parts: [{ text: "fixture" }, part] },
    ] }, { model: "gemini-4-carbon" }), error => {
      assert.equal(error.code, code);
      assert.equal(error.statusCode, 400);
      assert.match(error.message, /^Message 2, part 2\./);
      assert.doesNotMatch(error.message, /fixture/);
      return true;
    });
  }
});

test("tool-turn provenance expires and cannot be recovered from a new empty cache",()=>{
  let time=0;
  const cache=createAntigravityOpaqueReasoning({now:()=>time});
  const scope=["fixture-account","fixture-model","fixture-conversation"];
  const calls=[{id:"fixture-call",name:"lookup",args:{key:42}}];
  cache.remember(scope,calls);
  assert.equal(cache.matchesToolTurn(scope,calls),true);
  assert.equal(createAntigravityOpaqueReasoning().matchesToolTurn(scope,calls),false);
  time=60*60*1000;
  assert.equal(cache.matchesToolTurn(scope,calls),false);
});

test("missing tool IDs recover only from one complete, scoped tool-turn record",()=>{
  let time=0;
  const cache=createAntigravityOpaqueReasoning({now:()=>time});
  const scope=["fixture-account","fixture-model","fixture-conversation"];
  const first={id:"issued-one",name:"lookup",args:{path:"first",limit:1}};
  const second={id:"issued-two",name:"lookup",args:{path:"second",limit:1}};
  const idless={name:"lookup",args:{limit:1,path:"second"}};
  cache.remember(scope,[first,second]);
  const recovered=cache.recoverToolTurn(scope,[idless,first]);
  assert.equal(recovered.get(idless),second.id);
  assert.equal(cache.recoverToolTurn(scope,[idless]),null);
  assert.equal(cache.recoverToolTurn(scope,[idless,{...first,id:"made-up"}]),null);
  assert.equal(cache.recoverToolTurn(scope,[{...idless,args:{path:"changed",limit:1}},first]),null);
  for(const i of [0,1,2])assert.equal(cache.recoverToolTurn(scope.map((part,index)=>i===index?"other":part),[idless,first]),null);
  cache.remember(scope,[first,{...second,id:"issued-three"}]);
  assert.equal(cache.recoverToolTurn(scope,[idless,first]),null);
  time=60*60*1000;
  assert.equal(cache.recoverToolTurn(scope,[idless,first]),null);
});

test("a signed tool pair without IDs recovers the original IDs in the outbound copy",()=>{
  const cache=createAntigravityOpaqueReasoning();
  const scope=["fixture-account","fixture-model","fixture-conversation"];
  const issued={id:"issued-call",name:"lookup",args:{path:"fixture"}};
  cache.remember(scope,[issued]);
  const request={contents:[
    {role:"user",parts:[{text:"fixture"}]},
    {role:"model",parts:[{functionCall:{name:issued.name,args:issued.args},thoughtSignature:"fixture-signature"}]},
    {role:"user",parts:[{functionResponse:{name:issued.name,response:{result:"fixture"}}}]},
  ]};
  const before=structuredClone(request);
  const {chat}=antigravityToChat(request,{model:"fixture-model",
    acceptSignedToolTurn:parts=>cache.recoverToolTurn(scope,parts.map(part=>part.functionCall))});
  assert.equal(chat.messages[1].tool_calls[0].id,issued.id);
  assert.equal(chat.messages[2].tool_call_id,issued.id);
  assert.doesNotMatch(JSON.stringify(chat),/fixture-signature/);
  assert.deepEqual(request,before);
});

test("stream emits text promptly and reconstructs split tool arguments without losing integers", async () => {
  const { originalNames } = antigravityToChat({ contents: [{ role: "user", parts: [{ text: "hi" }] }], tools: [{ functionDeclarations: [declaration] }] }, { model: "fixture" });
  const events = [
    { choices: [{ delta: { content: "hello" } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "call-three", function: { name: "view_", arguments: '{"offset":9007199' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "file", arguments: "254740993}" } }] }, finish_reason: "tool_calls" }] },
    { choices: [], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } },
  ];
  const encoder = new TextEncoder(), response = new Response(new ReadableStream({ start(controller) {
    for (const event of events) controller.enqueue(encoder.encode("data: " + JSON.stringify(event) + "\n\n"));
    controller.enqueue(encoder.encode("data: [DONE]\n\n"));controller.close();
  } }));
  const chunks = [];for await (const chunk of chatStreamToAntigravity(response, originalNames)) chunks.push(chunk);
  assert.equal(chunks[0].response.candidates[0].content.parts[0].text, "hello");
  const part = chunks[1].response.candidates[0].content.parts[0].functionCall;
  assert.equal(part.name, "view_file");assert.equal(part.id, "call-three");
  assert.match(JSON.stringify(part.args), /9007199254740993/);
  assert.equal(chunks.at(-1).response.candidates[0].finishReason, "STOP");
  assert.equal(chunks.at(-1).response.usageMetadata.totalTokenCount, 13);
});

test("stream rejects an incomplete upstream response", async () => {
  const response = new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
  const received = [];
  await assert.rejects(async () => { for await (const value of chatStreamToAntigravity(response, new Map())) received.push(value); }, /ended before completion/);
  assert.equal(received[0].response.candidates[0].content.parts[0].text, "partial");
});

test("stream exposes upstream error details and does not invent a successful finish", async () => {
  const response = new Response('data: {"error":{"type":"rate_limit_error","message":"capacity unavailable"}}\n\n');
  await assert.rejects(async () => { for await (const _ of chatStreamToAntigravity(response, new Map())) {} }, /capacity unavailable/);
});

test("stream forwards text before the upstream finishes", async () => {
  const encoder = new TextEncoder();let writer;
  const response = new Response(new ReadableStream({ start(controller) { writer = controller; } }));
  const iterator = chatStreamToAntigravity(response, new Map());
  writer.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"early"}}]}\n\n'));
  const first = await iterator.next();
  assert.equal(first.value.response.candidates[0].content.parts[0].text, "early");
  writer.enqueue(encoder.encode('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'));
  writer.close();
  assert.equal((await iterator.next()).value.response.candidates[0].finishReason, "STOP");
  assert.equal((await iterator.next()).done, true);
});

test("thinking-only success is not reported as a completed answer", async () => {
  const source = 'data: {"choices":[{"delta":{"reasoning_content":"thinking"}}],"usage":{"completion_tokens":9,"reasoning_tokens":8}}\n\ndata: [DONE]\n\n';
  const diagnostic = /no text or tool calls \(output tokens: 9, reasoning tokens: 8\)/;
  await assert.rejects(async () => { for await (const _ of chatStreamToAntigravity(new Response(source), new Map())) {} }, diagnostic);
  assert.throws(() => chatToAntigravity({ choices: [{ finish_reason: "stop", message: { reasoning_content: "thinking" } }],
    usage: { completion_tokens: 9, reasoning_tokens: 8 } }, new Map()), diagnostic);
});
