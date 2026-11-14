import assert from "node:assert/strict";

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
  for (const style of ["halo", "orbit", "weave", "grid"]) {
    await page.selectOption("#tool-style", style);
    assert.equal(await page.locator("#tool-state").textContent(), "Waiting for tool results");
    assert.equal(await page.locator("#tool-stage").getAttribute("data-style"), style);
  }
  const performanceReceipt = {};
  if (performanceCheck) {
    const pairs = [], benchmarkStarted = Date.now();
    for (let pair = 0; pair < 20; pair++) {
      const result = {};
      for (const style of pair % 2 ? ["weave", "off"] : ["off", "weave"]) {
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
    Object.assign(performanceReceipt, { paired_samples: pairs, callback_p95_ms: p95, frame_budget_ms: 2 });
    console.log(JSON.stringify({tool_performance:performanceReceipt,elapsed_ms:Date.now()-benchmarkStarted,backend_states:codex.snapshot().tool_activity.items.map(row=>({state:row.state,expires_in_ms:row.expires_in_ms})),connection:await page.locator("#connection").textContent()}));
    assert.ok(pairs.every(pair=>pair.weave.frames>0), "Visible active style must actually animate throughout the performance sample");
  }
  await page.selectOption("#tool-style", "grid");
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
  await page.waitForTimeout(1050);
  const stopped = await page.evaluate(() => window.__toolFrameCount);await page.waitForTimeout(150);
  assert.equal(await page.evaluate(() => window.__toolFrameCount), stopped, "Completed tools stop drawing after their bounded finish");
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
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.locator("#language-toggle").click();await page.selectOption("#tool-style", "grid");
  assert.equal(await page.evaluate(() => performance.getEntriesByType("resource").filter(row => row.name.includes("/_ccdx/activity")).length), subscriptionRequests, "Styles reuse the existing activity subscription");
  return { styles: 4, parallel_tools: 3, genuine_results: true, stopped: true, reduced_motion: true, small_screen: true, ...performanceReceipt };
}
