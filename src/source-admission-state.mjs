import path from "node:path";
import { createSourceAdmission } from "./source-admission.mjs";
import { userSettingsPath } from "./user-settings.mjs";
import { readBoundedFileSync } from "./bounded-file.mjs";
import { atomicWriteFile } from "./atomic-file.mjs";

export function createRuntimeSourceAdmission({ persistSourceState = false, ...options } = {}) {
  if (!persistSourceState) return createSourceAdmission();
  const file = path.join(path.dirname(userSettingsPath(options)), "source-capacity.json");
  let learned = {}, dirty = false, timer, writing = Promise.resolve();
  try {
    const saved = JSON.parse(readBoundedFileSync(file, { maxBytes: 16384, encoding: "utf8" }));
    if (saved.version === 1 && saved.entries && Object.keys(saved.entries).length <= 64) learned = Object.fromEntries(Object.entries(saved.entries)
      .filter(([key, value]) => /^[a-f0-9]{64}$/.test(key) && Number.isSafeInteger(value.limit) && value.limit > 0 && value.limit <= 128 && Number.isFinite(value.at)));
  } catch { /* Disposable capacity metadata is relearned; source configuration is never rewritten. */ }
  const flush = () => {
    clearTimeout(timer);timer = null;
    if (!dirty) return writing;
    dirty = false;const text = JSON.stringify({ version: 1, entries: learned }) + "\n";
    writing = writing.catch(() => {}).then(() => atomicWriteFile(file, text)).catch(() => {});
    return writing;
  };
  const scheduler = createSourceAdmission({ learned, onStable(key, limit) {
    delete learned[key];learned[key] = { limit, at: Date.now() };
    while (Object.keys(learned).length > 64) delete learned[Object.keys(learned)[0]];
    dirty = true;if (!timer) { timer = setTimeout(flush, 1000);timer.unref?.(); }
  } });
  return { ...scheduler, async close() { scheduler.close();await flush(); } };
}
