import { isDeepStrictEqual } from "node:util";
import { parse } from "smol-toml";

export function parseCodexToml(content) {
  try {
    return parse(content, { integersAsBigInt: true });
  } catch {
    // TOML parser errors include source snippets, which may contain credentials.
    throw new Error("Codex configuration is not valid TOML; no configuration changes were written");
  }
}

export function configValue(config, keys) {
  return keys.reduce((value, key) => (
    value && Object.hasOwn(value, key) ? value[key] : undefined
  ), config);
}

function keyParts(source) {
  let value = parseCodexToml(`${source} = 0`);
  const keys = [];
  while (value && typeof value === "object") {
    const [key] = Object.keys(value);
    keys.push(key);
    value = value[key];
  }
  return keys;
}

// Locate complete declarations without interpreting value syntax. The TOML parser
// remains authoritative; this scanner only supplies spans for surgical edits.
export function codexTomlStatements(content) {
  const statements = [];
  let section = [];
  let offset = 0;
  let line = 0;
  while (offset < content.length) {
    const char = content[offset];
    if (/\s/.test(char)) {
      if (char === "\n") line += 1;
      offset += 1;
      continue;
    }
    const start = offset;
    const startLine = line;
    if (char === "#" || char === "[") {
      const end = content.indexOf("\n", offset);
      offset = end < 0 ? content.length : end;
      const source = content.slice(start, offset).trimEnd();
      if (char === "#") statements.push({ kind: "comment", start, end: offset, line: startLine, source });
      else {
        const brackets = source.startsWith("[[") ? 2 : 1;
        let quote = "";
        let close = brackets;
        for (; close < source.length; close += 1) {
          const next = source[close];
          if (quote === '"' && next === "\\") { close += 1; continue; }
          if (quote) { if (next === quote) quote = ""; continue; }
          if (next === '"' || next === "'") quote = next;
          else if (next === "]") break;
        }
        section = keyParts(source.slice(brackets, close));
        statements.push({ kind: "table", keys: section, start, end: offset, line: startLine });
      }
      continue;
    }

    let quote = "";
    for (; offset < content.length; offset += 1) {
      const next = content[offset];
      if (quote === '"' && next === "\\") { offset += 1; continue; }
      if (quote) { if (next === quote) quote = ""; continue; }
      if (next === '"' || next === "'") quote = next;
      else if (next === "=") break;
    }
    const keys = [...section, ...keyParts(content.slice(start, offset).trim())];
    offset += 1;
    while (content[offset] === " " || content[offset] === "\t") offset += 1;
    const valueStart = offset;
    let depth = 0;
    let multiline = false;
    for (; offset < content.length; offset += 1) {
      const next = content[offset];
      if (next === "\n") line += 1;
      if (quote) {
        if (quote === '"' && next === "\\") {
          if (content[offset + 1] === "\n") line += 1;
          offset += 1;
        } else if (next === quote) {
          if (!multiline) quote = "";
          else if (content.startsWith(quote.repeat(3), offset)) {
            while (content[offset + 1] === quote) offset += 1;
            quote = "";
          }
        }
        continue;
      }
      if (next === '"' || next === "'") {
        quote = next;
        multiline = content.startsWith(next.repeat(3), offset);
        if (multiline) offset += 2;
      } else if (next === "[" || next === "{") depth += 1;
      else if (next === "]" || next === "}") depth -= 1;
      else if (next === "#") {
        if (depth === 0) break;
        const end = content.indexOf("\n", offset);
        offset = end < 0 ? content.length : end - 1;
      } else if (next === "\n" && depth === 0) {
        line -= 1;
        break;
      }
    }
    const valueEnd = valueStart + content.slice(valueStart, offset).trimEnd().length;
    statements.push({ kind: "value", keys, section, start, end: offset, line: startLine, valueStart, valueEnd });
  }
  return statements;
}

function omitManaged(config, paths) {
  const result = structuredClone(config);
  for (const keys of paths) {
    const parents = [];
    let value = result;
    for (const key of keys) {
      if (!value || typeof value !== "object" || Array.isArray(value) || !Object.hasOwn(value, key)) break;
      parents.push([value, key]);
      value = value[key];
    }
    if (parents.length === keys.length) {
      const [parent, leaf] = parents.pop();
      delete parent[leaf];
    }
    while (parents.length) {
      const [owner, key] = parents.pop();
      if (!owner[key] || typeof owner[key] !== "object" || Array.isArray(owner[key]) || Object.keys(owner[key]).length) break;
      delete owner[key];
    }
  }
  return result;
}

export function validateManagedConfigEdit(before, content, managedPaths) {
  const after = parseCodexToml(content);
  if (!isDeepStrictEqual(omitManaged(before, managedPaths), omitManaged(after, managedPaths))) {
    throw new Error("Unsafe Codex configuration edit outside CCDX's managed keys; no configuration changes were written");
  }
}
