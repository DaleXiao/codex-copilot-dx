import test from "node:test";
import assert from "node:assert/strict";

import {
  CCDX_PM_STUDIO_ORIGIN,
  PM_STUDIO_ORIGIN,
  PM_STUDIO_SPLIT_ORIGIN_MARKER,
  blockSha256,
  createCompatiblePmStudioRecipe,
  findAsarEntry,
  parseAsarBuffer,
  patchAsarBuffer,
  sha256Hex,
} from "../src/pm-studio-asar.mjs";

const SOURCE_MODULE = '47024(I,e,t){"use strict";t.d(e,{qn:()=>l});const l={CLIENT_ID:"Iv1.b507a08c87ecfe98",CLIENT_SECRET:void 0,API_ENDPOINT:"https://api.githubcopilot.com",DEVICE_CODE_URL:"https://github.com/login/device/code",ACCESS_TOKEN_URL:"https://github.com/login/oauth/access_token",COPILOT_TOKEN_URL:"https://api.github.com/copilot_internal/v2/token",USER_AGENT:"GitHubCopilotChat/0.26.7",EDITOR_VERSION:"vscode/1.99.3",EDITOR_PLUGIN_VERSION:"copilot-chat/0.26.7",INTEGRATION_ID:"vscode-chat",STANDARD_HEADERS:{Accept:"application/json","Content-Type":"application/json","User-Agent":"GitHubCopilotChat/0.26.7","Editor-Version":"vscode/1.99.3","Editor-Plugin-Version":"copilot-chat/0.26.7","Copilot-Integration-Id":"vscode-chat","X-Request-Id":()=>`req_${Date.now()}_${Math.random().toString(36).substr(2,9)}`}};class c{constructor(){this.config={...l}}static getInstance(){return c.instance||(c.instance=new c),c.instance}getConfig(){return{...this.config}}updateConfig(I){this.config={...this.config,...I}}resetConfig(){this.config={...l}}validateConfig(){return function(){const I=[];return l.CLIENT_ID||I.push("GitHub Copilot Client ID is required"),l.API_ENDPOINT||I.push("GitHub Copilot API endpoint is required"),{valid:0===I.length,errors:I}}()}getStandardHeaders(I){return function(I){const e={Accept:l.STANDARD_HEADERS.Accept,"Content-Type":l.STANDARD_HEADERS["Content-Type"],"User-Agent":l.STANDARD_HEADERS["User-Agent"],"Editor-Version":l.STANDARD_HEADERS["Editor-Version"],"Editor-Plugin-Version":l.STANDARD_HEADERS["Editor-Plugin-Version"],"Copilot-Integration-Id":l.STANDARD_HEADERS["Copilot-Integration-Id"],"X-Request-Id":"function"==typeof l.STANDARD_HEADERS["X-Request-Id"]?l.STANDARD_HEADERS["X-Request-Id"]():l.STANDARD_HEADERS["X-Request-Id"]};return I&&(e.Authorization=`Bearer ${I}`),e}(I)}getCopilotTokenHeaders(I){return function(I){return{Authorization:`Bearer ${I}`,Accept:"application/json","User-Agent":l.USER_AGENT,"Editor-Version":l.EDITOR_VERSION,"Editor-Plugin-Version":l.EDITOR_PLUGIN_VERSION}}(I)}getDeviceCodeHeaders(){return{Accept:"application/json","User-Agent":l.USER_AGENT}}}c.getInstance()}';
const NEXT_MODULE = ',47124(I,e,t){"use strict";t.d(e,{yH:()=>0})}';
const PREFIX = "webpack-bootstrap,";
const SUFFIX = ",webpack-runtime";

function align4(value) {
  return (value + 3) & ~3;
}

function addHeaderEntry(header, filePath, entry) {
  const parts = filePath.split("/");
  let files = header.files;
  for (let index = 0; index < parts.length - 1; index += 1) {
    files[parts[index]] ||= { files: {} };
    files = files[parts[index]].files;
  }
  files[parts.at(-1)] = entry;
}

function archiveWithMain(mainSource, { blockSize = 64 } = {}) {
  const main = Buffer.from(`${PREFIX}${mainSource}${NEXT_MODULE}${SUFFIX}`);
  const header = { files: {} };
  addHeaderEntry(header, "dist/main/main.js", {
    size: main.length,
    offset: "0",
    integrity: {
      algorithm: "SHA256",
      hash: sha256Hex(main),
      blockSize,
      blocks: blockSha256(main, blockSize),
    },
  });
  const headerBytes = Buffer.from(JSON.stringify(header));
  const headerPayloadSize = align4(4 + headerBytes.length);
  const headerPickleSize = 4 + headerPayloadSize;
  const dataOffset = 8 + headerPickleSize;
  const archive = Buffer.alloc(dataOffset + main.length);
  archive.writeUInt32LE(4, 0);
  archive.writeUInt32LE(headerPickleSize, 4);
  archive.writeUInt32LE(headerPayloadSize, 8);
  archive.writeUInt32LE(headerBytes.length, 12);
  headerBytes.copy(archive, 16);
  main.copy(archive, dataOffset);
  return { archive, main, dataOffset };
}

function recipeOptions(version = "99.123-local") {
  return {
    version,
    build: version,
    bundleIdentifier: "com.pm-studio.app",
    sourceTeamIdentifier: "internal-tool",
    executable: "PM Studio",
    sourceExecutableSha256: "fixture-main-executable",
    electronFrameworkPath: "Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework",
    sourceElectronFrameworkSha256: "fixture-electron-framework",
    embeddedAsarIntegrity: "absent",
    asarPath: "Contents/Resources/app.asar",
    infoPlistPath: "Contents/Info.plist",
    integrityKey: "ElectronAsarIntegrity.Resources/app.asar",
  };
}

function replaceModuleId(source, moduleId) {
  return source.replace(/^\d+/, moduleId);
}

function swapIAndE(source) {
  return source.replace(/(?<![$\w])(?:I|e)(?![$\w])/g, (identifier) => (
    identifier === "I" ? "\0" : "I"
  )).replaceAll("\0", "e");
}

function renameAlphaIdentifiers(source, names) {
  return source.replace(/(?<![$\w])(?:I|e|t|l|c)(?![$\w])/g, (identifier) => (
    names[identifier] || identifier
  ));
}

function targetBytes(archive) {
  const parsed = parseAsarBuffer(archive);
  const entry = findAsarEntry(parsed.header, "dist/main/main.js");
  const offset = parsed.dataOffset + Number(entry.offset);
  return {
    bytes: archive.subarray(offset, offset + entry.size),
    entry,
  };
}

test("semantic locator accepts the PM Studio 2.9.14 alpha-renaming and a different module id", () => {
  const sourceModule = replaceModuleId(swapIAndE(SOURCE_MODULE), "91234");
  const fixture = archiveWithMain(sourceModule);
  const recipe = createCompatiblePmStudioRecipe(fixture.archive, recipeOptions());
  const edit = recipe.targets[0].edit;

  assert.equal(edit.offset, Buffer.byteLength(PREFIX));
  assert.equal(edit.length, Buffer.byteLength(sourceModule));
  assert.equal(edit.anchor, "91234(");
  assert.equal(edit.sourceSha256, sha256Hex(sourceModule));
  assert.equal(Buffer.byteLength(edit.replacement), edit.length);
  assert.match(edit.replacement, /^91234\(I,e,t\)\{/);
  assert.equal(edit.replacement.match(new RegExp(PM_STUDIO_ORIGIN, "g"))?.length, 1);
  assert.equal(edit.replacement.match(new RegExp(CCDX_PM_STUDIO_ORIGIN, "g"))?.length, 1);
  assert.equal(edit.replacement.match(new RegExp(PM_STUDIO_SPLIT_ORIGIN_MARKER, "g"))?.length, 1);

  const result = patchAsarBuffer(fixture.archive, recipe);
  assert.equal(result.changed, true);
  assert.equal(result.after.state, "patched");
  const beforeTarget = targetBytes(fixture.archive).bytes;
  const after = targetBytes(result.buffer);
  assert.deepEqual(after.bytes.subarray(0, edit.offset), beforeTarget.subarray(0, edit.offset));
  assert.deepEqual(after.bytes.subarray(edit.offset + edit.length), beforeTarget.subarray(edit.offset + edit.length));
  assert.equal(after.entry.integrity.hash, sha256Hex(after.bytes));
  assert.deepEqual(after.entry.integrity.blocks, blockSha256(after.bytes, after.entry.integrity.blockSize));
});

test("semantic replacement remains exactly source-sized for a one-digit module id", () => {
  const sourceModule = replaceModuleId(SOURCE_MODULE, "7");
  const fixture = archiveWithMain(sourceModule);
  const recipe = createCompatiblePmStudioRecipe(fixture.archive, recipeOptions("unversioned-internal"));
  const edit = recipe.targets[0].edit;

  assert.equal(edit.length, Buffer.byteLength(sourceModule));
  assert.equal(Buffer.byteLength(edit.replacement), edit.length);
  assert.match(edit.replacement, /^7\(I,e,t\)\{/);
  assert.equal(patchAsarBuffer(fixture.archive, recipe).after.state, "patched");
});

test("semantic locator permits d as a binding name while keeping the fixed .d property exact", () => {
  const sourceModule = renameAlphaIdentifiers(SOURCE_MODULE, {
    I: "d",
    e: "I",
    t: "e",
    l: "t",
    c: "l",
  });
  const fixture = archiveWithMain(sourceModule);
  const recipe = createCompatiblePmStudioRecipe(fixture.archive, recipeOptions());

  assert.match(sourceModule, /^47024\(d,I,e\)\{"use strict";e\.d\(I,/);
  assert.equal(recipe.targets[0].edit.sourceSha256, sha256Hex(sourceModule));
  assert.equal(patchAsarBuffer(fixture.archive, recipe).after.state, "patched");
});

test("semantic locator ignores an unrelated second endpoint sentinel", () => {
  const unrelated = `,unrelated={API_ENDPOINT:"${PM_STUDIO_ORIGIN}"}`;
  const fixture = archiveWithMain(`${SOURCE_MODULE}${unrelated}`);
  const recipe = createCompatiblePmStudioRecipe(fixture.archive, recipeOptions());

  assert.equal(recipe.targets[0].edit.offset, Buffer.byteLength(PREFIX));
  assert.equal(patchAsarBuffer(fixture.archive, recipe).after.state, "patched");
});

test("semantic locator rejects missing, ambiguous, and non-alpha candidates", () => {
  const cases = [
    ["missing sentinel", SOURCE_MODULE.replace(PM_STUDIO_ORIGIN, "https://copilot.invalid")],
    ["duplicate module", `${SOURCE_MODULE}${NEXT_MODULE},${SOURCE_MODULE}`],
    ["fixed property drift", SOURCE_MODULE.replace(".d(e", ".x(e")],
    ["method drift", SOURCE_MODULE.replace("getDeviceCodeHeaders", "getDeviceCodeHeaderz")],
    ["literal drift", SOURCE_MODULE.replace("GitHubCopilotChat/0.26.7", "GitHubCopilotChat/0.27.0")],
    ["non-bijective rename", SOURCE_MODULE.replace(/(?<![$\w])I(?![$\w])/g, "e")],
  ];

  for (const [name, mainSource] of cases) {
    const fixture = archiveWithMain(mainSource);
    assert.throws(
      () => createCompatiblePmStudioRecipe(fixture.archive, recipeOptions()),
      (error) => error?.code === "PM_STUDIO_ASAR_INCOMPATIBLE",
      name,
    );
  }
});
