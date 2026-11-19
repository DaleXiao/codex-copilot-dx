const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const schemaMaps = new Set(["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]);
const schemaLists = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
const schemaValues = new Set(["additionalProperties", "unevaluatedProperties", "additionalItems",
  "unevaluatedItems", "contains", "propertyNames", "not", "if", "then", "else", "contentSchema"]);
const references = ["$ref", "$dynamicRef", "$recursiveRef"];

function mapChanged(value, map) {
  const entries = Object.entries(value).map(([key, item]) => [key, map(item, key)]);
  return entries.every(([key, item]) => item === value[key]) ? value : Object.fromEntries(entries);
}
const requiredList = value => value === undefined
  || Array.isArray(value) && value.every(item => typeof item === "string") && new Set(value).size === value.length;

// Carbon rejects object-union schemas whose type/required sit next to anyOf
// while the properties are declared inside its branches. Distribute these two
// conjunctive assertions into every branch: T & (A | B) == (T & A) | (T & B).
// Keep nullable types, const discriminators and all branch-specific constraints.
export function normalizeCarbonToolSchema(schema, depth = 0) {
  if (!object(schema) || depth > 128) return schema;
  const recurse = child => normalizeCarbonToolSchema(child, depth + 1);
  const result = mapChanged(schema, (value, key) => {
    if (schemaMaps.has(key) && object(value)) return mapChanged(value, recurse);
    if ((schemaLists.has(key) || key === "items") && Array.isArray(value)) {
      const next = value.map(recurse);
      return next.every((item, index) => item === value[index]) ? value : next;
    }
    if (schemaValues.has(key) || key === "items") return recurse(value);
    if (key === "dependencies" && object(value)) {
      return mapChanged(value, item => Array.isArray(item) ? item : recurse(item));
    }
    // Literal values under const/enum/default/examples are data, not schemas.
    return value;
  });
  return distributeAssertions(result, depth);
}

function distributeAssertions(schema, depth) {
  if (depth > 128) return schema;
  let result = schema;
  const { anyOf, type, required } = result;
  const validType = type === undefined || typeof type === "string"
    || Array.isArray(type) && type.length > 0 && type.every(item => typeof item === "string");
  if (!Array.isArray(anyOf) || !anyOf.length || result.properties !== undefined
    || type === undefined && required === undefined || !validType || !requiredList(required)
    || references.some(key => Object.hasOwn(result, key))
    || !anyOf.every(branch => object(branch) && !references.some(key => Object.hasOwn(branch, key))
      && (type === undefined || branch.type === undefined || JSON.stringify(type) === JSON.stringify(branch.type))
      && requiredList(branch.required))) return result;

  result = { ...result, anyOf: anyOf.map(branch => distributeAssertions({ ...branch,
    ...(type === undefined ? {} : { type }),
    ...(required === undefined ? {} : { required: [...new Set([...(branch.required || []), ...required])] }),
  }, depth + 1))};
  delete result.type;
  delete result.required;
  return result;
}

// Operate only on outbound tool parameters, after the Carbon namespace/deferred
// tool bridge. Canonical request/history objects and non-Carbon routes stay intact.
export function normalizeCarbonToolSchemas(body) {
  if (!Array.isArray(body?.tools)) return body;
  const tools = body.tools.map(tool => {
    if (tool?.type !== "function") return tool;
    const owner = object(tool.function) ? tool.function : tool;
    const parameters = normalizeCarbonToolSchema(owner.parameters);
    if (parameters === owner.parameters) return tool;
    return owner === tool ? { ...tool, parameters } : { ...tool, function: { ...owner, parameters } };
  });
  return tools.every((tool, index) => tool === body.tools[index]) ? body : { ...body, tools };
}
