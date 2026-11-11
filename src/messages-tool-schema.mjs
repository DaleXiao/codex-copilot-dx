import { isDeepStrictEqual } from "node:util";

export const MESSAGES_TOOL_GUARD = Symbol("messages-tool-schema-guard");
const combiners = ["oneOf", "anyOf", "allOf"];
const unsafeKeywords = new Set(["pattern", "patternProperties", "format", "uniqueItems", "$ref", "$dynamicRef", "$recursiveRef"]);
const object = value => value && typeof value === "object" && !Array.isArray(value);

export function hasRootToolSchema(body) {
  return Array.isArray(body?.tools) && body.tools.some(tool => object(tool?.input_schema)
    && combiners.some(key => Object.hasOwn(tool.input_schema, key)));
}

export function isRootToolSchemaError(status, text) {
  if (![400, 422].includes(status) || typeof text !== "string") return false;
  let message = text;
  try { const parsed = JSON.parse(text);message = parsed?.error?.message ?? parsed?.message ?? ""; } catch {}
  return typeof message === "string" && /^(?:tools\.\d+\.(?:custom\.)?input_schema:\s*)?input_schema does not support oneOf, allOf, or anyOf at the top level\.?\s*$/i.test(message);
}

function safeSchema(schema) {
  if (Buffer.byteLength(JSON.stringify(schema)) > 64 * 1024) return false;
  let nodes = 0;
  const visit = (value, depth) => {
    if (++nodes > 2048 || depth > 32) return false;
    if (typeof value === "number" && Number.isInteger(value) && !Number.isSafeInteger(value)) return false;
    if (!value || typeof value !== "object") return true;
    if (Array.isArray(value)) return value.every(item => visit(item, depth + 1));
    return Object.entries(value).every(([key, child]) => !unsafeKeywords.has(key) && visit(child, depth + 1));
  };
  return visit(schema, 0);
}

function modelFacingSchema(schema, strict) {
  const keys = combiners.filter(key => Object.hasOwn(schema, key));
  if (keys.length !== 1 || schema.type != null && schema.type !== "object") return null;
  const key = keys[0], variants = schema[key];
  if (!Array.isArray(variants) || !variants.length || variants.some(variant => !object(variant)
    || variant.type != null && variant.type !== "object" || combiners.some(name => Object.hasOwn(variant, name)))) return null;
  if (schema.properties != null && !object(schema.properties) || variants.some(variant => variant.properties != null && !object(variant.properties))) return null;
  const properties = Object.create(null), names = new Set(Object.keys(schema.properties || {}));
  for (const variant of variants) for (const name of Object.keys(variant.properties || {})) names.add(name);
  for (const name of names) {
    if (Object.hasOwn(schema.properties || {}, name)) { properties[name] = schema.properties[name];continue; }
    const choices = [];
    for (const variant of variants) {
      const property = variant.properties?.[name];
      if (property === undefined) {
        if (variant.additionalProperties !== false) { choices.splice(0, choices.length, {});break; }
      } else if (!choices.some(value => isDeepStrictEqual(value, property))) choices.push(property);
    }
    properties[name] = choices.length === 1 ? choices[0] : choices.length ? { anyOf: choices } : {};
  }
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const lists = variants.map(variant => new Set(Array.isArray(variant.required) ? variant.required : []));
  for (const name of lists[0]) if (key === "allOf" || lists.every(list => list.has(name))) required.add(name);
  if (key === "allOf") for (const list of lists) for (const name of list) required.add(name);
  for (const name of required) if (!Object.hasOwn(properties, name)) properties[name] = {};
  const closed = schema.additionalProperties === false || variants.every(variant => variant.additionalProperties === false);
  if (strict && !closed) return null;
  return { type: "object", properties, ...(required.size ? { required: [...required] } : {}),
    ...(closed ? { additionalProperties: false } : {}),
    ...Object.fromEntries(["title", "description", "minProperties", "maxProperties"].filter(name => schema[name] !== undefined).map(name => [name, schema[name]])) };
}

function lossyNumber(value, source) {
  if (typeof value !== "number") return false;
  if (!Number.isFinite(value) || Number.isInteger(value) && !Number.isSafeInteger(value)) return true;
  return typeof source === "string" && String(value) !== source && source.replace(/\D/g, "").replace(/^0+/, "").length > 15;
}

function parseCheckedJson(text) {
  const unsafe = new WeakSet();
  const value = JSON.parse(text, function(_key, child, context) {
    if (lossyNumber(child, context?.source) || child && typeof child === "object" && unsafe.has(child)) unsafe.add(this);
    return child;
  });
  return { value, unsafe };
}

function invalidToolInput() {
  return Object.assign(new Error("Upstream tool input did not satisfy its original schema."), { code: "ccdx_tool_input_invalid", statusCode: 502 });
}

function makeGuard(validators, maxBytes) {
  const pending = new Map(), buffered = [];let bytes = 0;
  const check = (name, value, unsafe, restore) => {
    const validate = validators.get(name);
    if (!validate) return;
    if (unsafe || !validate(restore ? restore(value) : value)) throw invalidToolInput();
  };
  return {
    validateMessage(text, restore) {
      let parsed;try { parsed = parseCheckedJson(text); } catch { throw invalidToolInput(); }
      if (parsed.value?.content !== undefined && !Array.isArray(parsed.value.content)) throw invalidToolInput();
      for (const block of parsed.value?.content || []) if (block?.type === "tool_use" && validators.has(block.name)) {
        check(block.name, block.input, block.input && typeof block.input === "object" && parsed.unsafe.has(block.input), restore);
      }
      return parsed.value;
    },
    frame(event, chunk, raw, restore) {
      const block = event?.content_block;
      if (event?.type === "content_block_start" && block?.type === "tool_use" && validators.has(block.name)) {
        if (pending.has(event.index)) throw invalidToolInput();
        const parsed = parseCheckedJson(raw), initial = parsed.value?.content_block?.input;
        pending.set(event.index, { name: block.name, initial, unsafe: initial && typeof initial === "object" && parsed.unsafe.has(initial), parts: [] });
      }
      if (!pending.size) return [{ event, chunk }];
      if (event?.type === "error") { pending.clear();buffered.length = 0;bytes = 0;return [{ event, chunk }]; }
      buffered.push({ event, chunk });bytes += chunk.length;
      if (bytes > maxBytes) throw invalidToolInput();
      const state = pending.get(event?.index);
      if (state && event.type === "content_block_delta") {
        if (event.delta?.type !== "input_json_delta" || typeof event.delta.partial_json !== "string") throw invalidToolInput();
        state.parts.push(event.delta.partial_json);
      }
      if (state && event.type === "content_block_stop") {
        let value = state.initial, unsafe = state.unsafe;
        if (state.parts.length) {
          let parsed;try { parsed = parseCheckedJson(state.parts.join("")); } catch { throw invalidToolInput(); }
          value = parsed.value;unsafe = value && typeof value === "object" && parsed.unsafe.has(value);
        }
        check(state.name, value, unsafe, restore);pending.delete(event.index);
        if (!pending.size) { const result = buffered.splice(0);bytes = 0;return result; }
      }
      if (event?.type === "message_stop") throw invalidToolInput();
      return [];
    },
  };
}

export async function adaptMessagesToolSchemas(body, { maxBytes = 8 * 1024 * 1024 } = {}) {
  if (!hasRootToolSchema(body)) return null;
  const names = new Set(), validators = new Map(), tools = [];
  let Ajv, Ajv2020;
  try {
    for (const tool of body.tools) {
      if (typeof tool?.name === "string") { if (names.has(tool.name)) return null;names.add(tool.name); }
      const schema = tool?.input_schema;
      if (!object(schema) || !combiners.some(key => Object.hasOwn(schema, key))) { tools.push(tool);continue; }
      if (typeof tool.name !== "string" || !tool.name || !safeSchema(schema)) return null;
      if (validators.size >= 32) return null;
      const modelSchema = modelFacingSchema(schema, tool.strict === true);
      if (!modelSchema) return null;
      const dialect = schema.$schema;
      if (dialect && !["http://json-schema.org/draft-07/schema#", "https://json-schema.org/draft/2020-12/schema"].includes(dialect)) return null;
      if (dialect?.includes("2020-12")) Ajv2020 ||= (await import("ajv/dist/2020.js")).default;
      else Ajv ||= (await import("ajv")).default;
      const Validator = dialect?.includes("2020-12") ? Ajv2020 : Ajv;
      const validator = new Validator({ strict: true, strictTypes: false, strictRequired: false, allowUnionTypes: true, allErrors: false, addUsedSchema: false });
      validators.set(tool.name, validator.compile(schema));
      tools.push({ ...tool, input_schema: modelSchema });
    }
  } catch { return null; }
  return validators.size ? { body: { ...body, tools }, guard: makeGuard(validators, maxBytes) } : null;
}
