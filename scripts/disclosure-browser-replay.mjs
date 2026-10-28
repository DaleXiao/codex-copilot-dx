import assert from "node:assert/strict";
import fs from "node:fs/promises";

const options = new Map();for (let i = 2; i < process.argv.length; i += 2) options.set(process.argv[i], process.argv[i + 1]);
const module = await import(options.get("--playwright")), playwright = module.default || module;
const css = await fs.readFile(new URL("../src/dashboard/ui.css", import.meta.url), "utf8");
const script = await fs.readFile(new URL("../src/dashboard/disclosure.js", import.meta.url), "utf8");
const results = [];
for (const name of (options.get("--engines") || "chromium,webkit").split(",")) {
  const browser = await playwright[name].launch({ headless: true });
  try { for (const reducedMotion of ["no-preference", "reduce"]) {
    console.log("Disclosure case:", name, reducedMotion);
    const page = await browser.newPage({ viewport: { width: 900, height: 700 }, reducedMotion }), errors = [];page.on("pageerror", error => errors.push(error.message));page.setDefaultTimeout(10000);
    await page.setContent(`<style>${css}</style><details id="panel"><summary>Details</summary><p>Content</p></details>`);
    await page.addScriptTag({ content: script });
    const summary = page.locator("#panel > summary");
    assert.match(await summary.evaluate(node => getComputedStyle(node, "::before").maskImage), /svg/);
    assert.equal(await summary.evaluate(node => getComputedStyle(node, "::before").content), '""');
    await summary.press("Enter");await page.waitForFunction(() => document.getElementById("panel").open);
    await page.waitForFunction(() => getComputedStyle(document.querySelector("summary"), "::before").transform.startsWith("matrix(-1"));
    await summary.press("Space");await page.waitForFunction(() => !document.getElementById("panel").open);
    await page.evaluate(() => { const summary = document.querySelector("summary");summary.click();summary.click();summary.click(); });
    await page.waitForFunction(() => document.getElementById("panel").open && !document.getElementById("panel").hasAttribute("data-disclosure-closing"));
    await page.evaluate(() => { document.querySelector("summary").textContent = "已翻译"; });
    assert.match(await summary.evaluate(node => getComputedStyle(node, "::before").maskImage), /svg/);
    await page.evaluate(() => { const detail = document.createElement("details");detail.id = "dynamic";detail.innerHTML = "<summary>Dynamic</summary><p>New content</p>";document.body.append(detail); });
    await page.locator("#dynamic > summary").click();await page.waitForFunction(() => document.getElementById("dynamic").open);
    if (reducedMotion === "reduce") {
      assert.equal(await summary.evaluate(node => getComputedStyle(node, "::before").transitionDuration), "0s");
      assert.equal(await page.locator("#dynamic p").evaluate(node => node.getAnimations().length), 0);
    } else {
      await page.emulateMedia({ reducedMotion: "reduce" });await summary.press("Enter");await page.waitForFunction(() => !document.getElementById("panel").open);
    }
    assert.deepEqual(errors, []);results.push({ engine: name, reducedMotion, keyboard: true, rapid_toggle: true, translated: true, dynamic: true });await page.close();
  } } finally { await browser.close(); }
}
console.log(JSON.stringify({ cases: results.length, results, live_provider_calls: 0 }));
