import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { atomicWriteFilePairSync, atomicWriteFileSync } from "./atomic-file.mjs";
import { adapterBaseUrl } from "./running-adapter.mjs";

const SKILL_MARKER = /<!-- ccdx:image-skill:([a-f0-9]{64}) -->\n/;
const HELPER_MARKER = /^\/\/ ccdx:image-helper:([a-f0-9]{64})\n/;

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
  for (const directory of [path.join(skillDirectory, "scripts"), skillDirectory]) {
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
  try {
    directoryCheck(skillDirectory);
    directoryCheck(path.dirname(helperPath));
  } catch (error) {
    if (!enabled && error?.code === "CCDX_IMAGE_SKILL_CONFLICT") {
      return { changed: false, preserved: true, skillPath, rollback: () => {} };
    }
    throw error;
  }
  const previousSkill = ownedSnapshot(skillPath, SKILL_MARKER, !enabled);
  const previousHelper = ownedSnapshot(helperPath, HELPER_MARKER, !enabled);
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
    const preserved = Boolean(previousSkill?.unowned || previousHelper?.unowned);
    if (!previousSkill?.content && !previousHelper?.content) return { changed: false, preserved, skillPath, rollback: () => {} };
    try {
      for (const [filePath, snapshot] of [[skillPath, previousSkill], [helperPath, previousHelper]]) {
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
  const skillBody = `---
name: ccdx-image
description: Generate images from text and edit previously generated CCDX images using the user's configured provider. Use for drawing a new image or modifying a CCDX result identified in the conversation. Excludes arbitrary image uploads, masks, transparent output, and code-native SVG or diagrams.
---

# CCDX image generation

The user enabled this provider through ccdx enable-image. Use the configured CCDX provider directly for text-to-image requests and supported edits of its previous results.

For a new image, use the ccdx_image server's generate_image tool. Supply a complete prompt and one size: 1024x1024 (square), 1536x1024 (landscape), or 1024x1536 (portrait). Display its returned image and retain the returned image_id in the conversation for later edits. No Python, SDK installation, extra API key, or provider discovery is needed.

The tool returns ready-to-use saved-image Markdown in its text result. Include that exact Markdown in your final chat reply so the user sees a clickable thumbnail, alongside any image content you forward. Tool output or saying "generated" is not delivery. Do not put the image Markdown inside a code block or replace it with a download-only link. Keep its image path and image_id together. If the user asks "where is the image", "show it again", or "图呢", embed the same returned Markdown again; do not generate or edit another image just to display it. If the tool reports that saving failed, do not invent a path or claim the image was displayed, and do not submit another image request to fix delivery.

For an edit, use edit_image with the image_id of the specific CCDX result the user wants to change and a prompt describing the changes and what to preserve. Omit size to keep the source dimensions unless the user requests another size. Select the ID from this conversation; never assume a global last image or substitute a different result. Each edit returns a new image and image_id and preserves the source. IDs belong to the running CCDX process and can expire after cache eviction or restart. If the source ID is missing or expired, explain that the original image is unavailable for this edit. The provider must support edit_image; an unsupported edit is not permission to generate a replacement.

If the desired tool is not directly callable and the host provides tool search, make one targeted search for ccdx_image generate_image or ccdx_image edit_image as appropriate and use that tool if it becomes callable. If it is still unavailable, run the bundled Node helper once. To generate:

\`\`\`sh
${quote(nodePath)} ${quote(helperPath)} --prompt 'A complete image prompt' --size 1024x1024
\`\`\`

To edit, add --image-id with the exact source ID returned earlier and supply the editing prompt. Omit --size to preserve the source dimensions. This sends one edit_image call to the same service.

Quote the actual prompt safely for the shell. The helper uses the same local CCDX service and prints only the saved absolute image path to stdout; stderr reports CCDX image_id for subsequent edits. An optional --out argument selects a new output file; existing files are never overwritten. Include an absolute-path Markdown image for that saved file in the final chat reply, and retain its new ID. A viewer call alone does not replace the final thumbnail.

The helper needs loopback HTTP access. If the task reports restricted network access, use the execution tool's normal permission-request mechanism for this exact command before running it; localhost is also restricted. Keep the host's approval policy unchanged.

Only use the helper when the MCP tool is absent, not after generation or editing fails or times out: the first request may already have consumed a generation or edit. A helper error explicitly saying generation or editing has not started means no image request was submitted; resolve its stated local connection or permission issue before trying again. Otherwise report the failure once without switching providers, installing dependencies, or repeating the image request.

For arbitrary uploaded images, reference-image workflows, masks, transparent output, or explicitly requested other providers, keep the relevant native tools and skills; do not substitute a fresh CCDX generation.
`;
  const skillContent = skillBody.replace("# CCDX image generation", `<!-- ccdx:image-skill:${digest(skillBody)} -->\n# CCDX image generation`);
  const helperBody = `${fs.readFileSync(new URL("./image-tool-client.mjs", import.meta.url), "utf8")}\ntry {\n  await runImageToolClient({ endpoint: ${JSON.stringify(endpoint)} });\n} catch (error) {\n  console.error(String(error?.message || "Image generation failed").replace(/[\\u0000-\\u001f\\u007f-\\u009f]/g, " ").slice(0, 1000));\n  process.exitCode = 1;\n}\n`;
  const helperContent = `// ccdx:image-helper:${digest(helperBody)}\n${helperBody}`;
  if (previousSkill?.content === skillContent && previousHelper?.content === helperContent) {
    return { changed: false, skillPath, rollback: () => {} };
  }
  atomicWriteFilePairSync(helperPath, helperContent, skillPath, skillContent, { mode: 0o600 });
  touched.push([helperPath, previousHelper], [skillPath, previousSkill]);
  return { changed: true, skillPath, rollback };
}
