import test from "node:test";
import assert from "node:assert/strict";
import { parseClaudeAppContract, claudeNativeModelHint, watchClaudeAppContract } from "../src/claude-app-contract.mjs";
import { EventEmitter } from "node:events";

test("installation hints combine repeated events and stop after close", async () => {
  const callbacks = [];let changes = 0, closes = 0;
  const watcher = watchClaudeAppContract({ platform: "darwin", onChange: () => changes++, watchFile: (_directory, _options, callback) => {
    callbacks.push(callback);const emitter = new EventEmitter();emitter.close = () => closes++;return emitter;
  } });
  callbacks[0]("rename", "Other.app");callbacks[1]("change", "Info.plist");callbacks[2]("rename", "app.asar");
  await new Promise(resolve => setTimeout(resolve, 300));assert.equal(changes, 1);
  callbacks[2]("change", "app.asar");watcher.close();await new Promise(resolve => setTimeout(resolve, 300));assert.equal(changes, 1);assert.equal(closes, 3);
});
import { inspectClaudeCapabilitySupport, claudeSupportForSync } from "../src/claude-capability-config.mjs";

const source = 'flatKey:"inferenceModels",readers:["desktop","m365","code"];flatKey:"modelDiscoveryEnabled";list.find((entry=>entry.behavesAs))?.behavesAs;modelSettings.maxEffortLevel;row.effort_options;row.maxEffort;autoCompactWindow 1000000;CLAUDE_CODE_MAX_OUTPUT_TOKENS;"claude-sonnet-4-6":{effortLevels:["low","medium","high","max"]}';
test("a validated contract enables capabilities independently of a major-version allowlist",()=>{
  const contract={...parseClaudeAppContract(source),app_version:"5.11492.0"};assert.equal(contract.status,"verified");
  const support=inspectClaudeCapabilitySupport({platform:"linux",env:{PATH:""},appContract:contract});
  assert.equal(support.app,true);assert.equal(support.app_aliases,false);
  assert.equal(claudeSupportForSync(support,{claude_unrecognized:true,claude:[{id:"claude_system_claude",version:"5.11492.0"}]}).app,true);
  assert.equal(claudeSupportForSync(support,{claude:[{id:"claude_system_claude",version:"6.0.0"}]}).app,false,"Unverified replacement needs a fresh contract");
});
test("native hint matches source levels without inventing intermediate or extra levels",()=>{
  const contract=parseClaudeAppContract(source);
  assert.deepEqual(claudeNativeModelHint({reasoning_efforts:["low","medium","high"]},contract),{behavesAs:"claude-sonnet-4-6",maxEffort:"high"});
  assert.equal(claudeNativeModelHint({reasoning_efforts:["low","medium","high","max"]},contract).maxEffort,"max");
  assert.equal(claudeNativeModelHint({reasoning_efforts:["low","high","max"]},contract),null);
  assert.equal(parseClaudeAppContract(source.replace('row.effort_options','row.other')).status,"unverified");
  assert.equal(parseClaudeAppContract('flatKey:"inferenceModels";maxEffort;behavesAs').status,"unverified");
});
