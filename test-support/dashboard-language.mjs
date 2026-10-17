import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

// Exercise the shipped catalog/formatter in component tests too.
const context = { document: { documentElement: {}, addEventListener() {} }, localStorage: { getItem() {} } };
runInNewContext(readFileSync(new URL("../src/dashboard/language.js", import.meta.url), "utf8"), context);
export const dashboardLanguage = {
  format: context.ccdxLanguage.format,
  set(target, key, values, attribute = "textContent") {
    const value = context.ccdxLanguage.format(key, values);
    if (attribute === "textContent") target.textContent = value;
    else target.setAttribute(attribute, value);
  },
};
