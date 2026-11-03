import test from "node:test";
import assert from "node:assert/strict";
import { createPrivacyDetection } from "../src/privacy-detection.mjs";
import { validatePrivacyFindings } from "../src/privacy-findings.mjs";
import { privacyFailure } from "../src/privacy-model.mjs";
const tick = () => new Promise(setImmediate);
async function waitFor(check) { for (let at=0;at<60&&!check();at++) await tick();assert.ok(check()); }

test("whole-text hot memoization and shared work retain legacy component behavior", async t => {
  const calls=[];const detection=createPrivacyDetection({find: (texts,options) => new Promise(resolve=>calls.push({texts,options,resolve}))});t.after(()=>detection.close());
  const abort=new AbortController(), first=detection.find(["ordinary sample"],{signal:abort.signal});
  abort.abort(Error("cancelled"));await assert.rejects(first);
  assert.equal(calls.length,1);assert.equal(calls[0].options.workSignal.aborted,true);
  const retry=detection.find(["ordinary sample"]);calls[0].resolve([[]]);assert.deepEqual(await retry,[[]]);
  assert.deepEqual(await detection.find(["ordinary sample"]),[[]]);assert.equal(calls.length,1);
});

test("a waiter joining a canceling window job resumes after acknowledgement rather than duplicating physical work", async t => {
  const calls=[];const detection=createPrivacyDetection({find:(texts,options)=>new Promise((resolve,reject)=>calls.push({texts,options,resolve,reject}))});t.after(()=>detection.close());
  const abort=new AbortController(), first=detection.find(["same full text"],{signal:abort.signal});abort.abort(Error("cancelled"));await assert.rejects(first);
  const retry=detection.find(["same full text"]);assert.equal(calls.length,1);
  calls[0].reject(privacyFailure("cancelled"));await waitFor(()=>calls.length===2);
  assert.equal(calls[1].options.workSignal.aborted,false);calls[1].resolve([[]]);assert.deepEqual(await retry,[[]]);assert.equal(detection.busy(),false);
});

test("one caller leaving does not cancel a batch another caller still needs", async t => {
  const calls=[];const detection=createPrivacyDetection({find:(texts,options)=>new Promise(resolve=>calls.push({texts,options,resolve}))});t.after(()=>detection.close());
  const abort=new AbortController(), first=detection.find(["shared"],{signal:abort.signal}), second=detection.find(["shared"]);
  abort.abort(Error("cancelled"));await assert.rejects(first);assert.equal(calls[0].options.workSignal.aborted,false);
  calls[0].resolve([[]]);await second;assert.equal(calls.length,1);
});

test("a short request runs beside a long one while native admission remains bounded", async t => {
  const calls=[];const detection=createPrivacyDetection({find:texts=>new Promise(resolve=>calls.push({texts,resolve}))});t.after(()=>detection.close());
  const first=detection.find(["long ".repeat(5000)]), second=detection.find(["short"]), third=detection.find(["third"]);
  assert.equal(calls.length,2);assert.deepEqual(calls[1].texts,["short"]);
  calls[1].resolve([[]]);await second;await waitFor(()=>calls.length===3);calls[2].resolve([[]]);calls[0].resolve([[]]);await first;await third;
});

test("invalid UTF-8 boundaries and invalid engine findings never become reusable", async t => {
  assert.throws(()=>validatePrivacyFindings(["中文"],[[{start:1,end:3,label:"private_person",score:0.9}]]),{code:"ccdx_privacy_engine_invalid"});
  let calls=0;const detection=createPrivacyDetection({find:async texts=>{calls++;return calls===1?[[{start:0,end:999,label:"common_secret",score:0.9}]]:texts.map(()=>[]);}});t.after(()=>detection.close());
  await assert.rejects(detection.find(["short"]),{code:"ccdx_privacy_engine_invalid"});assert.deepEqual(await detection.find(["short"]),[[]]);assert.equal(calls,2);
});

test("pending and cache budgets remain bounded and snapshots contain no text", async t => {
  const detection=createPrivacyDetection({find:()=>new Promise(()=>{})},{maxPendingBytes:16,maxPendingEntries:2});t.after(()=>detection.close());
  await assert.rejects(detection.find(["x".repeat(17)]),{code:["ccdx","privacy","busy"].join("_")});assert.equal(detection.snapshot().pending_texts,0);
  assert.ok(!JSON.stringify(detection.snapshot()).includes("xxxxxxxx"));
  const small=createPrivacyDetection({find:async texts=>texts.map(()=>[])},{maxCacheBytes:256,maxCacheEntries:1});t.after(()=>small.close());await small.find(["one"]);await small.find(["two"]);
  assert.ok(small.snapshot().cache_bytes<=256);assert.ok(small.snapshot().cache_entries<=1);
});

test("native window work counts are separate from submitted whole-text bytes", async t => {
  const detection=createPrivacyDetection({find:async(texts,options)=>{options.onSubmitted();options.onWindowWork({evaluated:2,hits:3,shared:1,total:6});return texts.map(()=>[]);}});t.after(()=>detection.close());
  await detection.find(["ordinary full text"]);const stats=detection.snapshot();assert.equal(stats.window_evaluations,2);assert.equal(stats.window_hits,3);assert.equal(stats.window_shared,1);assert.equal(stats.submitted_batches,1);
});
