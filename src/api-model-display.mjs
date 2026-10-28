import fs from "node:fs";
import path from "node:path";
import { accessSettingsPath } from "./access-settings.mjs";
import { readBoundedFileSync } from "./bounded-file.mjs";
import { atomicWriteFileSync } from "./atomic-file.mjs";
import { redactDiagnosticText } from "./diagnostic-text.mjs";

export function apiModelDisplay(model) {
  return Object.fromEntries(["publisher", "vendor", "owned_by", "display_name", "name"].flatMap(key => {
    const value = model?.[key];
    return typeof value === "string" && value.trim() && value.length <= 160
      && !/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(value) && redactDiagnosticText(value) === value ? [[key, value.trim()]] : [];
  }));
}

// Display-only evidence lives outside the strict connection schema. Older
// versions ignore it; losing this cache never changes routing or credentials.
export function createApiModelDisplayStore(options = {}) {
  const directory = path.join(path.dirname(accessSettingsPath(options)), "api-model-display"), cache = new Map();
  const file = id => { if (!/^api_[a-zA-Z0-9_-]{1,60}$/.test(id)) throw Error("Invalid model display source");return path.join(directory, id + ".json"); };
  const validate = (value, revision) => {
    if (value?.version !== 1 || value.revision !== revision || !Array.isArray(value.models) || value.models.length > 500) return null;
    const map = new Map();
    for (const item of value.models) {
      if (typeof item?.id !== "string" || !/^[\w][\w./:@+-]{0,159}$/.test(item.id) || map.has(item.id)) return null;
      map.set(item.id, apiModelDisplay(item));
    }
    return map;
  };
  function read(id, revision) {
    const old = cache.get(id);if (old?.revision === revision) return old.models;
    let models = null;
    try { models = validate(JSON.parse(readBoundedFileSync(file(id), { encoding: "utf8", maxBytes: 512 * 1024 })), revision); } catch {}
    cache.set(id, { revision, models });while (cache.size > 16) cache.delete(cache.keys().next().value);
    return models;
  }
  return {
    has: (id, revision) => read(id, revision) !== null,
    get: (id, revision, model) => read(id, revision)?.get(model) || {},
    set(id, revision, models) {
      const value = { version: 1, revision, models: models.map(model => ({ id: model.id, ...apiModelDisplay(model.display) })) };
      const checked = validate(value, revision), text = JSON.stringify(value) + "\n";
      if (!checked || Buffer.byteLength(text) > 512 * 1024) throw Error("Invalid model display cache");
      const changed = JSON.stringify([...(read(id, revision) || [])]) !== JSON.stringify([...checked]);
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });atomicWriteFileSync(file(id), text, { mode: 0o600 });cache.set(id, { revision, models: checked });while (cache.size > 16) cache.delete(cache.keys().next().value);
      return changed;
    },
  };
}
