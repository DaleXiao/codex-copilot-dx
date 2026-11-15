const record = value => value !== null && typeof value === "object" && !Array.isArray(value);

function fillMissing(first, later) {
  const updates = [];
  for (const [key, value] of Object.entries(later)) {
    const previous = Object.hasOwn(first, key) ? first[key] : undefined;
    const next = previous == null || previous === "" ? value
      : record(previous) && record(value) ? fillMissing(previous, value) : previous;
    if (next !== previous) updates.push([key, next]);
  }
  return updates.length ? { ...first, ...Object.fromEntries(updates) } : first;
}

// Call only on a single source/account catalog. Explicit values, including
// false and empty capability arrays, win; duplicates only supply missing data.
export function uniqueModelEntries(models) {
  const positions = new Map();let result = null;
  for (let index = 0; index < models.length; index++) {
    const model = models[index], id = model?.id;
    if (typeof id === "string" && id && positions.has(id)) {
      result ||= models.slice(0, index);
      const position = positions.get(id);
      result[position] = fillMissing(result[position], model);
    } else {
      if (typeof id === "string" && id) positions.set(id, result ? result.length : index);
      if (result) result.push(model);
    }
  }
  return result || models;
}

export function normalizeModelList(value) {
  const data = Array.isArray(value) ? value : value?.data;
  if (!Array.isArray(data)) return value;
  const normalized = uniqueModelEntries(data);
  return normalized === data ? value : Array.isArray(value) ? normalized : { ...value, data: normalized };
}
