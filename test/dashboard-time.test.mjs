import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { runInNewContext } from "node:vm";

test("dashboard times share a local 24-hour clock and reject missing or invalid values", () => {
  const document = { documentElement: { lang: "zh-CN" } }, context = { document, Intl, Date };
  runInNewContext(fs.readFileSync(new URL("../src/dashboard/time.js", import.meta.url), "utf8"), context);
  const value = new Date(2026, 9, 22, 15, 5, 6).getTime();
  for (const language of ["zh-CN", "en"]) {
    document.documentElement.lang = language;
    assert.match(context.ccdxTime.format(value), /15:05:06/);
    assert.match(context.ccdxTime.format(value, { date: true }), /2026/);
    assert.doesNotMatch(context.ccdxTime.format(value), /AM|PM/);
    for (const missing of [null, undefined, "", "bad time", Infinity]) assert.equal(context.ccdxTime.format(missing), "—");
  }
});
