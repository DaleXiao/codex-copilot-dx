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
const shell = (await fs.readFile(new URL("../src/dashboard/index.html", import.meta.url), "utf8"))
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
  .replace(/<link\b[^>]*>/gi, "");
const languageScript = await fs.readFile(new URL("../src/dashboard/language.js", import.meta.url), "utf8");
const statusScript = await fs.readFile(new URL("../src/dashboard/status.js", import.meta.url), "utf8");
const iconScript = await fs.readFile(new URL("../src/dashboard/icons.js", import.meta.url), "utf8");
const timeScript = await fs.readFile(new URL("../src/dashboard/time.js", import.meta.url), "utf8");
const layoutResults = [];
for (const name of (options.get("--engines") || "chromium,webkit").split(",")) {
  const browser = await playwright[name].launch({ headless: true });
  try {
    for (const language of (options.get("--languages") || "en,zh").split(",")) {
      for (const width of (options.get("--widths") || "420,900,1440").split(",").map(Number)) {
        for (const reducedMotion of ["no-preference", "reduce"]) {
          console.log("Disclosure layout:", JSON.stringify({ engine: name, language, width, reducedMotion }));
          const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion });
          const errors = [], requests = [];
          page.on("pageerror", error => errors.push(error.message));
          await page.route("**/*", route => { requests.push(route.request().url());return route.abort(); });
          const watchdog = setTimeout(() => { console.error("Disclosure layout exceeded 45 seconds");process.exit(124); }, 45000);
          watchdog.unref();
          try {
            await page.setContent(shell);
            await page.addStyleTag({ content: css });
            await page.addScriptTag({ content: languageScript });
            await page.addScriptTag({ content: iconScript });
            await page.evaluate(language => {
              document.querySelectorAll("[hidden]").forEach(node => { node.hidden = false; });
              document.dispatchEvent(new Event("DOMContentLoaded"));
              if ((document.documentElement.lang === "zh-CN") !== (language === "zh")) document.getElementById("language-toggle").click();
            }, language);
            await page.addScriptTag({ content: timeScript });
            await page.addScriptTag({ content: statusScript });
            await page.evaluate(() => {
              const element = id => document.getElementById(id), phrase = (key, values) => ccdxLanguage.format(key, values);
              const localize = (node, key, values) => ccdxLanguage.set(node, key, values);
              const finite = value => value !== null && value !== undefined && Number.isFinite(Number(value));
              const number = value => finite(value) ? Number(value).toLocaleString("en-US") : "—";
              const tableRow = (values, { labels = [] } = {}) => {
                const row = document.createElement("tr");
                values.forEach((value, i) => { const cell = document.createElement("td");if (labels.includes(i)) localize(cell, value);else cell.textContent = value;row.append(cell); });
                return row;
              };
              const renderer = ccdxDashboardStatus.create({ element, phrase, localize, finite, number, time: (value, options) => ccdxTime.format(value, options), mib: number, tableRow,
                emptyTable: (id, cols, key) => { const row = tableRow([phrase(key)]);row.firstChild.colSpan = cols;element(id).replaceChildren(row); },
                text: (id, key, values) => { const node = element(id);if (node) localize(node, key, values); }, document, navigator });
              renderer.renderContext({ recent_requests: [0, 1].map(i => ({ at: "2026-10-29T04:58:04.123Z", provider: "m365", model: "example-model-with-a-long-identifier", outcome: "completed", request_id: `00000000-1111-2222-3333-44444444444${i}`, http_status: 200, upstream_attempts: 1,
                context: { input_tokens: 450050, context_window_tokens: 1048576, payload_bytes: 4096, max_output_tokens_requested: 16000, max_output_tokens_sent: 16000, output_tokens: 42, images: 0 } })) });
              renderer.renderFailures([{ at: "2026-10-29T04:59:04.123Z", provider: "m365", model: "example-model", request_id: "00000000-1111-2222-3333-444444444440", code: "http_403", http_status: 403, origin: "upstream", message: "A bounded diagnostic message for an example request.", target: "/anthropic/v1/messages", method: "POST" }]);
              for (const bodyId of ["checks-body", "live-models-body"]) {
                const body = element(bodyId);if (!body) continue;
                const rows = [...body.closest("table").tHead.rows[0].cells].map((_, i) => i ? "—" : "Example model/source");
                const row = tableRow(rows), detail = document.createElement("details"), summary = document.createElement("summary"), fields = document.createElement("dl");
                if (bodyId === "live-models-body") fields.className = "failure-detail";
                localize(summary, bodyId === "live-models-body" ? "model_details" : "tools_details");detail.append(summary, fields);
                for (const value of ["model-identifier-with-long-unbroken-segments", "00000000-1111-2222-3333-444444444440", "2026-10-29T04:59:04.123Z"]) {
                  if (bodyId === "checks-body") {
                    const message = document.createElement("p");message.className = "hint";message.textContent = value;detail.append(message);
                  } else {
                    const dt = document.createElement("dt"), dd = document.createElement("dd");dt.textContent = "Field";dd.textContent = value;fields.append(dt, dd);
                  }
                }
                if (bodyId === "checks-body") fields.remove();
                row.lastChild.replaceChildren(detail);body.replaceChildren(row);
              }
              const note = element("m365-control-note");
              if (note) { const detail = document.createElement("details"), summary = document.createElement("summary"), code = document.createElement("code");localize(summary, "message");code.textContent = "m365_proxy_settings_unsupported";detail.append(summary, code);note.append(detail); }
            });
            await page.addScriptTag({ content: script });
            await page.evaluate(() => document.fonts.ready);
            const report = await page.evaluate(async () => {
              const summaries = [...document.querySelectorAll("details > summary")];
              const touched = [];
              const measure = summary => {
                const box = summary.getBoundingClientRect(), table = summary.closest("table"), wrap = summary.closest(".table-wrap");
                const walker = document.createTreeWalker(summary, NodeFilter.SHOW_TEXT);
                let node;while ((node = walker.nextNode()) && !node.textContent.trim()) {}
                let textX = box.x;
                if (node) { const range = document.createRange();range.selectNodeContents(node);textX = range.getBoundingClientRect().x; }
                const peers = summary.closest("tr") ? [...summary.closest("tr").cells].filter(cell => !cell.contains(summary)).map(cell => {
                  const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);let node;
                  while ((node = walker.nextNode()) && !node.textContent.trim()) {}
                  if (!node) return null;
                  const range = document.createRange();range.selectNodeContents(node);return range.getBoundingClientRect().y;
                }) : [];
                return { x: box.x, y: box.y, peers, textX, width: box.width, pageX: scrollX, tableX: wrap?.scrollLeft || 0,
                  pageWidth: document.documentElement.scrollWidth,
                  cells: table ? [...(table.tHead?.rows[0]?.cells || [])].map(cell => ({ x: cell.getBoundingClientRect().x, width: cell.getBoundingClientRect().width })) : [] };
              };
              const animations = detail => detail.getAnimations({ subtree: true }).filter(animation => Number.isFinite(animation.effect?.getComputedTiming().endTime));
              const finish = async detail => { animations(detail).forEach(animation => animation.finish());await Promise.resolve();await Promise.resolve(); };
              const check = (before, after, label, phase) => {
                const keys = ["x", "y", "textX", "width", "pageX", "tableX", "pageWidth"];
                const bad = keys.filter(key => Math.abs(before[key] - after[key]) > 1);
                if (before.cells.length !== after.cells.length) bad.push("cells");
                before.peers.forEach((value, i) => { if (value !== null && Math.abs(value - after.peers[i]) > 1) bad.push(`peer${i}.y`); });
                before.cells.forEach((cell, i) => { for (const key of ["x", "width"]) if (Math.abs(cell[key] - after.cells[i]?.[key]) > 1) bad.push(`column${i}.${key}`); });
                if (bad.length) throw Error(JSON.stringify({ label, phase, changed: bad, before, after }));
              };
              for (const summary of summaries) {
                const detail = summary.parentElement;
                for (let ancestor = detail.parentElement?.closest("details"); ancestor; ancestor = ancestor.parentElement?.closest("details")) ancestor.open = true;
                const original = detail.open;detail.open = false;
                const wrap = summary.closest(".table-wrap");if (wrap) wrap.scrollLeft = wrap.scrollWidth - wrap.clientWidth;
                const before = measure(summary), label = `${detail.id || detail.closest("[id]")?.id || "detail"}: ${summary.textContent.trim().slice(0, 55)}`;
                summary.click();check(before, measure(summary), label, "opening");
                for (const animation of animations(detail)) animation.currentTime = animation.effect.getComputedTiming().endTime / 2;
                check(before, measure(summary), label, "mid-animation");
                await finish(detail);check(before, measure(summary), label, "open");
                if (!detail.open) throw Error(`Disclosure did not open: ${label}`);
                summary.click();await finish(detail);check(before, measure(summary), label, "closed");
                if (detail.open) throw Error(`Disclosure did not close: ${label}`);
                detail.open = original;touched.push(label);
              }
              return { count: touched.length, controls: touched, inlineContainmentSupported: CSS.supports("contain", "inline-size") };
            });
            if (options.get("--output") && language === "zh" && width === 1440 && reducedMotion === "no-preference") {
              const output = options.get("--output");await fs.mkdir(output, { recursive: true });
              await page.evaluate(() => { document.documentElement.dataset.palette = "mono";document.documentElement.dataset.theme = "light";document.getElementById("request-context").open = true;document.querySelectorAll("#context-body details").forEach(detail => { detail.open = false; }); });
              await page.locator("#request-context").screenshot({ path: `${output}/${name}-requests-closed.png` });
              await page.locator("#context-body details > summary").first().click();
              await page.waitForTimeout(220);
              await page.locator("#request-context").screenshot({ path: `${output}/${name}-requests-open.png` });
            }
            assert.deepEqual(errors, []);assert.deepEqual(requests, []);
            layoutResults.push({ engine: name, language, width, reducedMotion, ...report });
          } finally { clearTimeout(watchdog);await page.close(); }
        }
      }
    }
  } finally { await browser.close(); }
}

console.log(JSON.stringify({ cases: results.length, results, layout_cases: layoutResults.length, layout_results: layoutResults, live_provider_calls: 0 }));
