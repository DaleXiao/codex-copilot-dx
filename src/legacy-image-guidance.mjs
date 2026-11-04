import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const SKILL_MARKER = /<!-- ccdx:image-skill:([a-f0-9]{64}) -->\n/;
const HELPER_MARKER = /^\/\/ ccdx:image-helper:([a-f0-9]{64})\n/;
const REFERENCE_MARKER = /^<!-- ccdx:image-reference:([a-f0-9]{64}) -->\n/;
const REFERENCE_FILES = ["editing.md", "helper.md"];

function digest(content) {
  return createHash("sha256").update(content).digest("hex");
}

function conflict(message) {
  return Object.assign(new Error(message), { code: "CCDX_IMAGE_SKILL_CONFLICT" });
}

function directoryCheck(directory) {
  try {
    if (!fs.lstatSync(directory).isDirectory()) throw conflict(`CCDX image skill path is not a regular directory: ${directory}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function ownedSnapshot(filePath, marker, preserveUnowned = false) {
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile()) throw conflict(`Refusing to replace an unowned CCDX image skill path: ${filePath}`);
    const content = fs.readFileSync(filePath, "utf8");
    const match = marker.exec(content);
    if (!match || digest(content.replace(marker, "")) !== match[1]) {
      throw conflict(`Preserving an existing or modified image skill file: ${filePath}`);
    }
    return { content };
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    if (preserveUnowned && error?.code === "CCDX_IMAGE_SKILL_CONFLICT") return { unowned: true };
    throw error;
  }
}

function removeFile(filePath) {
  try { fs.unlinkSync(filePath); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
}

function removeEmptyDirectories(skillDirectory) {
  for (const directory of [path.join(skillDirectory, "scripts"), path.join(skillDirectory, "references"), skillDirectory]) {
    try { fs.rmdirSync(directory); }
    catch (error) { if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error?.code)) throw error; }
  }
}

export function removeLegacyImageGuidance({ codexPath } = {}) {
  const skillDirectory = path.join(path.dirname(codexPath), "skills", "ccdx-image");
  const files = [["SKILL.md", SKILL_MARKER], ["scripts/generate.mjs", HELPER_MARKER],
    ...REFERENCE_FILES.map(name => [`references/${name}`, REFERENCE_MARKER])];
  try {
    for (const directory of [skillDirectory, path.join(skillDirectory, "scripts"), path.join(skillDirectory, "references")]) directoryCheck(directory);
  } catch (error) {
    if (error.code === "CCDX_IMAGE_SKILL_CONFLICT" || error.code === "ENOTDIR") return { changed: false, preserved: true };
    throw error;
  }
  let changed = false, preserved = false;
  for (const [relative, marker] of files) {
    const file = path.join(skillDirectory, relative), snapshot = ownedSnapshot(file, marker, true);
    if (snapshot?.unowned) preserved = true;
    else if (snapshot) { removeFile(file);changed = true; }
  }
  removeEmptyDirectories(skillDirectory);
  return { changed, preserved };
}
