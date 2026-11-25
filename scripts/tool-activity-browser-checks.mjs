import assert from "node:assert/strict";
import { comparePerformancePairs } from "./privacy-performance-analysis.mjs";

export async function checkToolActivity({ page, codex, metrics, performanceCheck = false, advanceToolClock }) {
  await page.evaluate(() => {
    window.__toolFrames = [];window.__toolFrameCount = 0;
    const original = window.requestAnimationFrame;
    window.requestAnimationFrame = callback => original.call(window, time => {
      const start = performance.now();try { return callback(time); } finally {
        window.__toolFrameCount++;window.__toolFrames.push(performance.now() - start);
        if (window.__toolFrames.length > 2000) window.__toolFrames.shift();
      }
    });
  });
  const styles = ["production", "clock", "assembly", "sorter", "gantry", "rotary", "arm"];
  assert.equal(await page.evaluate(() => typeof globalThis.ccdxToolArm), "undefined");
  assert.equal(await page.locator("#tool-style").inputValue(), "production");
  assert.deepEqual(await page.locator("#tool-style option").evaluateAll(options => options.map(option => option.value)), [...styles, "off"]);
  const tracker = codex.begin("responses", { requestId: "tool-browser", application: "codex_app" });
  const complete = metrics.begin("responses");tracker.setProvider("github");tracker.setModel("tool-model");tracker.observeSession("d".repeat(64));
  tracker.upstreamStarted();tracker.firstOutput();tracker.observeToolOutput({ output: ["read_file", "search_files", "run_command"].map((name, i) => ({ type: "function_call", call_id: `tool-${i}`, name })) }, "responses");
  await page.locator("#tool-activity").scrollIntoViewIfNeeded();
  await page.waitForFunction(() => document.querySelectorAll(".tool-entry").length === 3);
  tracker.terminal("completed");tracker.finish({ statusCode: 200 });complete({ statusCode: 200 });
  await page.waitForFunction(() => document.querySelector("#tool-state").textContent === "Waiting for tool results");
  const before = await page.evaluate(() => window.__toolFrameCount);await page.waitForTimeout(120);
  assert.ok(await page.evaluate(() => window.__toolFrameCount) > before, "Waiting activity animates without new model events");
  const subscriptionRequests = await page.evaluate(() => performance.getEntriesByType("resource").filter(row => row.name.includes("/_ccdx/activity")).length);
  for (const style of styles) {
    await page.selectOption("#tool-style", style);
    if (style === "arm") {
      await page.waitForFunction(() => {
        const canvas = document.getElementById("tool-canvas");
        return typeof globalThis.ccdxToolArm === "function" &&
          canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data.some((alpha, index) => index % 4 === 3 && alpha > 0);
      });
      assert.ok(await page.evaluate(() => {
        const canvas = document.createElement("canvas");
        canvas.width = 400;canvas.height = 275;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        const draw = globalThis.ccdxToolArm(context);
        const sample = time => {
          context.setTransform(1,0,0,1,0,0);
          context.clearRect(0,0,400,275);
          draw("arm", { time, width:400, height:275, dpr:1, ink:"#4c493e", surface:"#fbf5e6" });
          return context.getImageData(0,0,400,275).data;
        };
        for (const time of [4.2, 4.65, 5.2, 6.4, 13.8, 14.45]) {
          const before = sample(time), after = sample(time + .001);
          let changed = 0, visible = 0;
          for (let at = 0; at < before.length; at += 4) {
            if (before[at + 3] > 240) visible++;
            if (Math.abs(before[at] - after[at]) + Math.abs(before[at+1] - after[at+1]) +
              Math.abs(before[at+2] - after[at+2]) + Math.abs(before[at+3] - after[at+3]) > 54) changed++;
          }
          if (visible < 4000 || changed > 1600) return false;
        }
        return true;
      }), "The arm remains visible and continuous at nearby frames in both directions");
    }
    assert.equal(await page.locator("#tool-state").textContent(), "Waiting for tool results");
    assert.equal(await page.locator("#tool-stage").getAttribute("data-style"), style);
  }
  const performanceReceipt = {};
  if (performanceCheck) {
    const pairs = [], benchmarkStarted = Date.now();
    for (let pair = 0; pair < 20; pair++) {
      const result = {};
      for (const style of pair % 2 ? ["production", "off"] : ["off", "production"]) {
        await page.selectOption("#tool-style", style);
        const start = await page.evaluate(() => ({ sum: window.__toolFrames.reduce((a, b) => a + b, 0), length: window.__toolFrames.length }));
        await page.waitForTimeout(200);
        result[style] = await page.evaluate(start => ({ cpu_ms: window.__toolFrames.reduce((a, b) => a + b, 0) - start.sum, frames: window.__toolFrames.length - start.length }), start);
      }
      pairs.push(result);
    }
    const samples = await page.evaluate(() => window.__toolFrames.slice().sort((a, b) => a - b));
    const p95 = samples[Math.floor(samples.length * .95)] || 0;
    assert.ok(p95 <= 2, `Fixed-host animation callback p95 exceeded 2ms: ${p95}`);
    assert.ok(pairs.every(pair => pair.off.frames === 0), "Disabled style schedules no continuing animation frames");
    const comparison = comparePerformancePairs(pairs.map(pair => ({ before_ms: 200 + pair.off.cpu_ms, after_ms: 200 + pair.production.cpu_ms })), { tolerance: .025, absoluteToleranceMs: 5 });
    assert.equal(comparison.decision, "pass", "Paired callback overhead must stay within 5ms per 200ms window");
    Object.assign(performanceReceipt, { paired_samples: pairs, comparison, callback_p95_ms: p95, frame_budget_ms: 2 });
    console.log(JSON.stringify({tool_performance:performanceReceipt,elapsed_ms:Date.now()-benchmarkStarted,backend_states:codex.snapshot().tool_activity.items.map(row=>({state:row.state,expires_in_ms:row.expires_in_ms})),connection:await page.locator("#connection").textContent()}));
    assert.ok(pairs.every(pair=>pair.production.frames>0), "Visible active style must actually animate throughout the performance sample");
  }
  await page.selectOption("#tool-style", "assembly");
  await page.emulateMedia({ reducedMotion: "reduce" });await page.waitForTimeout(80);
  const reduced = await page.evaluate(() => window.__toolFrameCount);await page.waitForTimeout(120);
  assert.equal(await page.evaluate(() => window.__toolFrameCount), reduced);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.locator("#language-toggle").click();
  await page.waitForFunction(() => document.documentElement.lang === "zh-CN");
  assert.equal(await page.locator("#tool-state").textContent(), "等待工具返回");
  assert.deepEqual(await page.locator(".tool-name").allTextContents(), ["运行命令", "搜索文件", "读取文件"]);
  const next = codex.begin("responses", { requestId: "tool-results", application: "codex_app" });next.observeSession("d".repeat(64));
  next.observeToolInput({ input: [0, 1, 2].map(i => ({ type: "function_call_output", call_id: `tool-${i}`, output: "not retained" })) }, "responses");next.terminal("completed");next.finish({ statusCode: 200 });
  await page.waitForFunction(() => document.querySelector("#tool-state").textContent === "工具结果已返回");
  assert.equal(await page.locator("#tool-cursor").isVisible(), false);
  const stopped = await page.evaluate(() => window.__toolFrameCount);await page.waitForTimeout(150);
  assert.equal(await page.evaluate(() => window.__toolFrameCount), stopped, "Completed tools stop drawing as soon as they complete");
  const expiring = codex.begin("responses", { requestId: "tool-expiring", application: "codex_app" });
  expiring.setProvider("github");expiring.setModel("tool-model");expiring.observeSession("e".repeat(64));
  expiring.observeToolOutput({ type: "function_call", call_id: "expiring-call", name: "read_file" }, "responses");expiring.terminal("completed");expiring.finish({ statusCode: 200 });
  await page.waitForFunction(() => document.querySelector('#tool-state').textContent === '等待工具返回');
  advanceToolClock(89900);
  await page.waitForFunction(() => document.querySelector('#tool-state').textContent === '状态待更新');
  const stale = await page.evaluate(() => window.__toolFrameCount);await page.waitForTimeout(120);
  assert.equal(await page.evaluate(() => window.__toolFrameCount), stale, 'Expired evidence does not remain animated');
  await page.setViewportSize({ width: 320, height: 900 });
  assert.ok(await page.locator("#tool-activity").evaluate(el => el.scrollWidth <= el.clientWidth));
  for (const style of styles) {
    await page.selectOption("#tool-style", style);
    assert.ok(await page.locator("#tool-activity").evaluate(el => el.scrollWidth <= el.clientWidth));
  }
  await page.setViewportSize({ width: 1280, height: 1000 });
  const agent = codex.begin("responses", { requestId: "agent-browser", application: "codex_app" });agent.setProvider("github");agent.setModel("agent-model");
  await page.waitForFunction(() => document.querySelector('#tool-state').textContent === '正在处理请求');
  agent.upstreamStarted();agent.firstOutput();
  await page.waitForFunction(() => document.querySelector('#tool-state').textContent === '正在生成回复');
  for (const style of styles) {
    await page.selectOption("#tool-style", style);const before = await page.evaluate(() => window.__toolFrameCount);await page.waitForTimeout(100);
    assert.ok(await page.evaluate(() => window.__toolFrameCount) > before);
  }
  await page.selectOption("#tool-style", "off");assert.equal(await page.locator("#tool-state").isVisible(), true);
  const disabled = await page.evaluate(() => window.__toolFrameCount);await page.waitForTimeout(100);assert.equal(await page.evaluate(() => window.__toolFrameCount), disabled);
  agent.terminal("cancelled");agent.finish({ aborted: true });await page.waitForFunction(() => document.querySelector('#tool-state').textContent === '状态待更新');
  for (const style of styles) {
    await page.selectOption("#tool-style", style);const before = await page.evaluate(() => window.__toolFrameCount);await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => window.__toolFrameCount), before, 'Terminal requests leave no continuing animation');
  }
  await page.locator("#language-toggle").click();await page.selectOption("#tool-style", "sorter");
  assert.equal(await page.evaluate(() => performance.getEntriesByType("resource").filter(row => row.name.includes("/_ccdx/activity")).length), subscriptionRequests, "Styles reuse the existing activity subscription");
  return { styles: styles.length, agent_phases: true, parallel_tools: 3, genuine_results: true, stopped: true, reduced_motion: true, small_screen: true, ...performanceReceipt };
}
