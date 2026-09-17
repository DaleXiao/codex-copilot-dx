import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { atomicWriteFilePairSync, atomicWriteFileSync } from "./atomic-file.mjs";
import { adapterBaseUrl } from "./running-adapter.mjs";

const SKILL_MARKER = /<!-- ccdx:image-skill:([a-f0-9]{64}) -->\n/;
const HELPER_MARKER = /^\/\/ ccdx:image-helper:([a-f0-9]{64})\n/;
const REFERENCE_MARKER = /^<!-- ccdx:image-reference:([a-f0-9]{64}) -->\n/;
const REFERENCE_FILES = ["editing.md", "helper.md"];

function digest(content) {
  return createHash("sha256").update(content).digest("hex");
}

function quote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
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
    return { content, mode: stat.mode & 0o777 };
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

export function updateImageSkill({
  enabled,
  codexPath,
  adapterPort = 2026,
  adapterHost = "127.0.0.1",
  nodePath = process.execPath,
} = {}) {
  const skillDirectory = path.join(path.dirname(codexPath), "skills", "ccdx-image");
  const skillPath = path.join(skillDirectory, "SKILL.md");
  const helperPath = path.join(skillDirectory, "scripts", "generate.mjs");
  const references = REFERENCE_FILES.map((name) => ({ name, filePath: path.join(skillDirectory, "references", name) }));
  try {
    directoryCheck(skillDirectory);
    directoryCheck(path.dirname(helperPath));
    directoryCheck(path.join(skillDirectory, "references"));
  } catch (error) {
    if (!enabled && error?.code === "CCDX_IMAGE_SKILL_CONFLICT") {
      return { changed: false, preserved: true, skillPath, rollback: () => {} };
    }
    throw error;
  }
  const previousSkill = ownedSnapshot(skillPath, SKILL_MARKER, !enabled);
  const previousHelper = ownedSnapshot(helperPath, HELPER_MARKER, !enabled);
  for (const reference of references) reference.previous = ownedSnapshot(reference.filePath, REFERENCE_MARKER, !enabled);
  const snapshots = [[skillPath, previousSkill], [helperPath, previousHelper], ...references.map(({ filePath, previous }) => [filePath, previous])];
  const touched = [];
  let rolledBack = false;
  const rollback = () => {
    if (rolledBack) return;
    for (const [filePath, snapshot] of touched) {
      if (snapshot) atomicWriteFileSync(filePath, snapshot.content, { mode: snapshot.mode, preserveMode: false });
      else removeFile(filePath);
    }
    removeEmptyDirectories(skillDirectory);
    rolledBack = true;
  };
  if (!enabled) {
    const preserved = snapshots.some(([, snapshot]) => snapshot?.unowned);
    if (!snapshots.some(([, snapshot]) => snapshot?.content)) return { changed: false, preserved, skillPath, rollback: () => {} };
    try {
      for (const [filePath, snapshot] of snapshots) {
        if (!snapshot?.content) continue;
        touched.push([filePath, snapshot]);
        removeFile(filePath);
      }
      removeEmptyDirectories(skillDirectory);
    } catch (error) {
      rollback();
      throw error;
    }
    return { changed: true, preserved, skillPath, rollback };
  }
  const host = ["0.0.0.0", "::", "[::]"].includes(adapterHost) ? (adapterHost === "0.0.0.0" ? "127.0.0.1" : "::1") : adapterHost;
  const endpoint = `${adapterBaseUrl(host, adapterPort)}/mcp/image`;
  const skillBody = fs.readFileSync(new URL("./image-skill/SKILL.md", import.meta.url), "utf8");
  for (const reference of references) {
    const body = fs.readFileSync(new URL(`./image-skill/references/${reference.name}`, import.meta.url), "utf8")
      .replaceAll("{{NODE}}", () => quote(nodePath)).replaceAll("{{HELPER}}", () => quote(helperPath));
    reference.content = `<!-- ccdx:image-reference:${digest(body)} -->\n${body}`;
  }
  const skillContent = skillBody.replace("# CCDX image generation", `<!-- ccdx:image-skill:${digest(skillBody)} -->\n# CCDX image generation`);
  const helperBody = `${fs.readFileSync(new URL("./image-tool-client.mjs", import.meta.url), "utf8")}\ntry {\n  await runImageToolClient({ endpoint: ${JSON.stringify(endpoint)} });\n} catch (error) {\n  console.error(String(error?.message || "Image generation failed").replace(/[\\u0000-\\u001f\\u007f-\\u009f]/g, " ").slice(0, 1000));\n  process.exitCode = 1;\n}\n`;
  const helperContent = `// ccdx:image-helper:${digest(helperBody)}\n${helperBody}`;
  if (previousSkill?.content === skillContent && previousHelper?.content === helperContent
    && references.every(({ previous, content }) => previous?.content === content)) {
    return { changed: false, skillPath, rollback: () => {} };
  }
  try {
    // Install conditional resources before publishing the skill entrypoint.
    for (const { filePath, previous, content } of references) {
      if (previous?.content === content) continue;
      touched.push([filePath, previous]);
      atomicWriteFileSync(filePath, content, { mode: 0o600, preserveMode: false });
    }
    atomicWriteFilePairSync(helperPath, helperContent, skillPath, skillContent, { mode: 0o600 });
    touched.push([helperPath, previousHelper], [skillPath, previousSkill]);
  } catch (error) {
    rollback();
    throw error;
  }
  return { changed: true, skillPath, rollback };
}
