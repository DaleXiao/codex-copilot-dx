import path from "node:path";
import { atomicWriteFile } from "./atomic-file.mjs";
import { readBoundedFile } from "./bounded-file.mjs";
import { userSettingsPath } from "./user-settings.mjs";

export function boundedReadManifestPath(options) {
  return path.join(path.dirname(userSettingsPath(options)), "windows-antigravity-compat.json");
}

export async function readManifestCache(file, maxBytes) {
  return JSON.parse(await readBoundedFile(file, { maxBytes, encoding: "utf8" }));
}

export function writeManifestCache(file, value) {
  return atomicWriteFile(file, JSON.stringify(value), { mode: 0o600, preserveMode: false });
}
