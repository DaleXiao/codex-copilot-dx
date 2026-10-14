import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { readBoundedFileSync } from "./bounded-file.mjs";
import { atomicWriteFileSync } from "./atomic-file.mjs";
import { withFileLockSync } from "./lock.mjs";

const validPac = value => typeof value === "string" && /^http:\/\/127\.0\.0\.1:\d{1,5}\/proxy\.pac$/.test(value)
  && Number(new URL(value).port) >= 1024 && Number(new URL(value).port) <= 65535;
const object = value => value && typeof value === "object" && !Array.isArray(value);

function regularFile(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Prediction route file is not a regular owned file; it was preserved");
}

function preferences(profile) {
  for (const directory of [profile, path.join(profile, "Default")]) {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Prediction profile is not a regular directory; it was preserved");
  }
  regularFile(path.join(profile, "Local State"));
  const file = path.join(profile, "Default", "Preferences");
  regularFile(file);
  const bytes = readBoundedFileSync(file);
  const value = JSON.parse(bytes);
  if (!object(value)) throw new Error("Unknown App preferences; they were preserved");
  return { file, bytes, value };
}

function recordAt(file, profile) {
  try {
    regularFile(file);
    const value = JSON.parse(readBoundedFileSync(file, { encoding: "utf8" }));
    if (value?.version !== 1 || value.profile !== profile || !validPac(value.pacUrl)
      || typeof value.hadProxy !== "boolean" || (value.hadProxy && !isDeepStrictEqual(value.previousProxy, { mode: "system" }))) {
      throw new Error("Unknown saved prediction route ownership; no preference was changed");
    }
    return value;
  } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

export function hasInstalledPredictionRoute({ directory, profile, pacUrl } = {}) {
  try {
    const record = recordAt(path.join(directory, "route.json"), profile);
    return record?.pacUrl === pacUrl && isDeepStrictEqual(preferences(profile).value.proxy, { mode: "pac_script", pac_url: pacUrl });
  } catch { return false; }
}

// A write is allowed only while the App is closed. The ownership intent is
// committed first, so an interrupted activation remains identifiable on off.
export function updatePredictionRoute({ directory, profile, pacUrl, remove = false, assertClosed, direct = false,
  writeFile = atomicWriteFileSync } = {}) {
  if (!path.isAbsolute(profile || "") || (!remove && !validPac(pacUrl))) throw new Error("Invalid prediction route binding");
  const recordFile = path.join(directory, "route.json");
  if (remove && !fs.existsSync(recordFile)) return { status: "absent" };
  if (!remove && !direct) return { status: "preserved", reason: "Existing system/company routing was preserved" };
  return withFileLockSync(`${recordFile}.lock`, () => {
    const record = recordAt(recordFile, profile);
    if (remove && !record) return { status: "absent" };
    let current;
    try { current = preferences(profile); }
    catch (error) {
      if (error.code === "ENOENT" && !remove) return { status: "pending", reason: "App preferences are not initialized" };
      throw error;
    }
    const owned = record && isDeepStrictEqual(current.value.proxy, { mode: "pac_script", pac_url: record.pacUrl });
    if (remove && !owned) {
      // The user replaced the route; retain their edit and remove only our intent.
      fs.unlinkSync(recordFile);return { status: "preserved", reason: "User-edited App route was preserved" };
    }
    if (!remove && owned && record.pacUrl === pacUrl) return { status: "installed" };
    if (!remove && !owned && Object.hasOwn(current.value, "proxy") && !isDeepStrictEqual(current.value.proxy, { mode: "system" })) {
      return { status: "preserved", reason: "Existing App proxy preference was preserved" };
    }
    assertClosed();
    if (!readBoundedFileSync(current.file).equals(current.bytes)) throw new Error("App preferences changed during route setup; retry after quitting the App");
    if (remove) {
      if (record.hadProxy) current.value.proxy = record.previousProxy;
      else delete current.value.proxy;
    } else {
      const next = record || { version: 1, profile, pacUrl, hadProxy: Object.hasOwn(current.value, "proxy"),
        ...(Object.hasOwn(current.value, "proxy") ? { previousProxy: current.value.proxy } : {}) };
      writeFile(recordFile, JSON.stringify({ ...next, pacUrl }, null, 2) + "\n", { preserveMode: false });
      current.value.proxy = { mode: "pac_script", pac_url: pacUrl };
    }
    // Recheck after committing the small intent file, before touching App data.
    assertClosed();
    if (!readBoundedFileSync(current.file).equals(current.bytes)) throw new Error("App preferences changed during route setup; the saved intent was retained");
    writeFile(current.file, JSON.stringify(current.value) + "\n");
    if (remove) fs.unlinkSync(recordFile);
    return { status: remove ? "removed" : "installed" };
  }, { timeoutMs: 100 });
}
