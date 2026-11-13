import fs from "node:fs/promises";
import { watch } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { readBoundedFile } from "./bounded-file.mjs";

const MAX_HEADER = 4 * 1024 * 1024, MAX_SOURCE = 16 * 1024 * 1024;
const cache = new Map();
const version = text => /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(text)?.[1];
const stamp = stat => [stat.dev, stat.ino, stat.size, stat.mtimeMs].join(":");

export function watchClaudeAppContract({ platform = process.platform, appPath = "/Applications/Claude.app", onChange = () => {}, watchFile = watch } = {}) {
  const watchers = [];let timer, closed = false;
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => { if (!closed) void Promise.resolve().then(onChange).catch(() => {}); }, 250);timer.unref?.();
  };
  if (platform === "darwin") for (const [directory, name] of [[path.dirname(appPath), path.basename(appPath)], [path.join(appPath, "Contents"), "Info.plist"], [path.join(appPath, "Contents", "Resources"), "app.asar"]]) {
    try {
      const watcher = watchFile(directory, { persistent: false }, (_event, file) => { if (!file || String(file) === name) schedule(); });
      watcher.on("error", () => watcher.close());watchers.push(watcher);
    } catch { /* Existing periodic inspection also covers replacement/watch failure. */ }
  }
  return { close() { closed = true;clearTimeout(timer);for (const watcher of watchers) watcher.close(); } };
}

function archiveFiles(node, prefix = "", output = []) {
  for (const [name, entry] of Object.entries(node.files || {})) {
    const file = prefix + name;
    if (entry.files) archiveFiles(entry, file + "/", output);
    else if (!entry.unpacked && Number.isSafeInteger(entry.size) && /^\d+$/.test(entry.offset || "")) output.push({ name: file, ...entry });
  }
  return output;
}

// Read declarations and their consumers, not a release-number allowlist.
// No application code is executed and no user profile or credential is read.
export function parseClaudeAppContract(source) {
  const profiles = [];
  for (const match of source.matchAll(/"(claude-[a-z]+-[0-9][0-9.-]*)":\{effortLevels:\[([^\]]{0,120})\]/g)) {
    const values = match[2].match(/"(?:low|medium|high|xhigh|max)"/g)?.map(value => JSON.parse(value));
    if (values?.length && values.join(",") === match[2].replaceAll('"', "").replaceAll(" ", "") && new Set(values).size === values.length)
      profiles.push({ model: match[1], efforts: values });
  }
  const fields = {
    models: /flatKey:"inferenceModels"/.test(source) && /readers:\["desktop","m365","code"\]/.test(source),
    discovery: /flatKey:"modelDiscoveryEnabled"/.test(source),
    behaves_as: /\.find\(\(\w+=>\w+\.behavesAs\)\)\?\.behavesAs/.test(source),
    effort_cap: /maxEffortLevel/.test(source) && /\.effort_options/.test(source) && /\.maxEffort/.test(source),
    context: /autoCompactWindow/.test(source) && /1000000/.test(source),
    output: /CLAUDE_CODE_MAX_OUTPUT_TOKENS/.test(source),
  };
  const picker = profiles.length > 0 && fields.models && fields.behaves_as && fields.effort_cap;
  const facts = { fields, profiles: profiles.sort((a, b) => a.model.localeCompare(b.model)) };
  return { status: picker ? "verified" : "unverified", ...facts,
    fingerprint: createHash("sha256").update(JSON.stringify(facts)).digest("hex").slice(0, 24) };
}

export async function inspectClaudeAppContract({ platform = process.platform, appPath = "/Applications/Claude.app", appSource } = {}) {
  if (typeof appSource === "string") return parseClaudeAppContract(appSource);
  if (platform !== "darwin") return { status: "unavailable", fields: {}, profiles: [], fingerprint: null };
  const archive = path.join(appPath, "Contents", "Resources", "app.asar");let handle;
  try {
    const info = await readBoundedFile(path.join(appPath, "Contents", "Info.plist"), { maxBytes: 65536, encoding: "utf8" });
    if (!/<key>CFBundleIdentifier<\/key>\s*<string>com\.anthropic\.claudefordesktop<\/string>/.test(info)) throw Error("Unrecognized App");
    const before = await fs.stat(archive), key = stamp(before), previous = cache.get(archive);
    if (previous?.key === key) return { ...structuredClone(previous.value), app_version: version(info) || null };
    handle = await fs.open(archive, "r");const prefix = Buffer.alloc(16);await handle.read(prefix, 0, 16, 0);
    const headerSize = prefix.readUInt32LE(12), base = 8 + prefix.readUInt32LE(4);
    if (headerSize <= 0 || headerSize > MAX_HEADER || base > before.size) throw Error("Invalid archive");
    const header = Buffer.alloc(headerSize);await handle.read(header, 0, headerSize, 16);
    const files = archiveFiles(JSON.parse(header.toString("utf8"))).filter(file => /^\.vite\/build\/index(?:\.chunk[^/]*|\.pre)\.js$/.test(file.name)
      && file.size > 500000 && file.size <= MAX_SOURCE).sort((a, b) => b.size - a.size);
    let result = { status: "unverified", fields: {}, profiles: [], fingerprint: null };
    for (const file of files.slice(0, 6)) {
      const offset = base + Number(file.offset);if (!Number.isSafeInteger(offset) || offset + file.size > before.size) continue;
      const bytes = Buffer.alloc(file.size);await handle.read(bytes, 0, bytes.length, offset);
      const candidate = parseClaudeAppContract(bytes.toString("utf8"));
      if (candidate.status === "verified") { result = candidate;break; }
    }
    if (stamp(await fs.stat(archive)) !== key) throw Error("App changed during inspection");
    const value = { ...result, app_version: version(info) || null, installation: key };
    cache.set(archive, { key, value });if (cache.size > 2) cache.delete(cache.keys().next().value);
    return structuredClone(value);
  } catch { return { status: "unavailable", fields: {}, profiles: [], fingerprint: null }; }
  finally { await handle?.close(); }
}

export function claudeNativeModelHint(values = {}, contract) {
  if (contract?.status !== "verified" || values.reasoning === false) return null;
  const levels = values.reasoning_efforts || [], order = ["low", "medium", "high", "xhigh", "max"];
  if (!levels.length || levels.some(level => !order.includes(level))) return null;
  const sorted = order.filter(level => levels.includes(level)), maximum = sorted.at(-1);
  const profile = contract.profiles?.find(profile => profile.efforts.filter(level => order.indexOf(level) <= order.indexOf(maximum)).join(",") === sorted.join(","));
  return profile ? { behavesAs: profile.model, maxEffort: maximum } : null;
}
