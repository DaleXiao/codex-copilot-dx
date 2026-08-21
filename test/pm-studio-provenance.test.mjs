import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  PM_STUDIO_OFFICIAL_REPOSITORY,
  comparePmStudioAppTrees,
  expectedPmStudioAssetName,
  selectOfficialPmStudioRelease,
  verifyOfficialPmStudioProvenance,
} from "../src/pm-studio-provenance.mjs";

const temporaryRoots = new Set();
const VERSION = "2.9.12";
const ARCH = "arm64";
const ASSET_NAME = `PM-Studio-${VERSION}-mac-${ARCH}.zip`;
const DOWNLOAD_URL = `https://github.com/gim-home/max-studio/releases/download/v${VERSION}/${ASSET_NAME}`;
const REDIRECT_URL = "https://release-assets.githubusercontent.com/github-production-release-asset/example?sig=redacted";

function temporaryRoot(prefix = "ccdx-pm-provenance-") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryRoots.add(root);
  return root;
}

after(() => {
  for (const root of temporaryRoots) fs.rmSync(root, { recursive: true, force: true });
});

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function writeFile(filePath, contents, mode = 0o644) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, { mode });
  fs.chmodSync(filePath, mode);
}

function createApp(root, name = "PM Studio.app") {
  const appPath = path.join(root, name);
  writeFile(path.join(appPath, "Contents", "MacOS", "PM Studio"), "executable", 0o755);
  writeFile(path.join(appPath, "Contents", "Resources", "app.asar"), "official-asar");
  fs.mkdirSync(path.join(appPath, "Contents", "Frameworks", "Shared.framework", "Versions", "A"), {
    recursive: true,
  });
  fs.symlinkSync("A", path.join(appPath, "Contents", "Frameworks", "Shared.framework", "Versions", "Current"));
  return appPath;
}

function copyApp(source, destination) {
  fs.cpSync(source, destination, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
}

function xattrOutput(appPath, relative, name, value) {
  const target = relative === "." ? appPath : path.join(appPath, ...relative.split("/"));
  const bytes = Buffer.from(value);
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join(" ");
  return `${target}: ${name}:\n00000000  ${hex}  |value|\n`;
}

function releaseFixture(archive, overrides = {}) {
  const asset = {
    name: ASSET_NAME,
    size: archive.length,
    digest: `sha256:${sha256(archive)}`,
    browser_download_url: DOWNLOAD_URL,
    ...overrides.asset,
  };
  return {
    tag_name: `v${VERSION}`,
    draft: false,
    prerelease: false,
    html_url: `https://github.com/gim-home/max-studio/releases/tag/v${VERSION}`,
    assets: [asset],
    ...overrides,
    assets: overrides.assets || [asset],
  };
}

function responseLike({ status = 200, headers = {}, body = null, json, redirected = false } = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    redirected,
    headers: new Headers(headers),
    body,
    json: json || (async () => {
      throw new Error("json was not expected");
    }),
    arrayBuffer: async () => {
      throw new Error("artifact download must be streamed");
    },
  };
}

function asyncBody(...chunks) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield Buffer.from(chunk);
    },
  };
}

function successfulFetch({ archive, release = releaseFixture(archive), calls = [] } = {}) {
  return async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).startsWith("https://api.github.com/")) {
      return responseLike({ status: 200, json: async () => release });
    }
    if (String(url) === DOWNLOAD_URL) {
      return responseLike({ status: 302, headers: { location: REDIRECT_URL } });
    }
    if (String(url) === REDIRECT_URL) {
      const split = Math.max(1, Math.floor(archive.length / 2));
      return responseLike({
        status: 200,
        headers: { "content-length": String(archive.length) },
        body: asyncBody(archive.subarray(0, split), archive.subarray(split)),
      });
    }
    throw new Error(`unexpected URL ${url}`);
  };
}

function assertCode(expected) {
  return (error) => {
    assert.equal(error?.code, expected);
    return true;
  };
}

test("official release selection fixes repository, version, tag, arch, asset, and digest", () => {
  const archive = Buffer.from("official archive");
  assert.equal(PM_STUDIO_OFFICIAL_REPOSITORY, "gim-home/max-studio");
  assert.equal(expectedPmStudioAssetName(VERSION, ARCH), ASSET_NAME);
  assert.equal(expectedPmStudioAssetName(VERSION, "x64"), `PM-Studio-${VERSION}-mac-x64.zip`);
  assert.throws(() => expectedPmStudioAssetName("v2.9.12", ARCH), assertCode("PM_STUDIO_PROVENANCE_INPUT_INVALID"));
  assert.throws(() => expectedPmStudioAssetName("2.9", ARCH), assertCode("PM_STUDIO_PROVENANCE_INPUT_INVALID"));
  assert.throws(() => expectedPmStudioAssetName(VERSION, "universal"), assertCode("PM_STUDIO_PROVENANCE_INPUT_INVALID"));

  const selected = selectOfficialPmStudioRelease(releaseFixture(archive), { version: VERSION, arch: ARCH });
  assert.deepEqual(selected, {
    repository: "gim-home/max-studio",
    version: VERSION,
    tag: `v${VERSION}`,
    arch: ARCH,
    releaseUrl: `https://github.com/gim-home/max-studio/releases/tag/v${VERSION}`,
    asset: {
      name: ASSET_NAME,
      size: archive.length,
      sha256: sha256(archive),
      downloadUrl: DOWNLOAD_URL,
    },
  });
});

test("official release selection rejects metadata drift and ambiguous or unverifiable assets", () => {
  const archive = Buffer.from("official archive");
  const cases = [
    [releaseFixture(archive, { tag_name: "v2.9.11" }), "PM_STUDIO_PROVENANCE_RELEASE_INVALID"],
    [releaseFixture(archive, { draft: true }), "PM_STUDIO_PROVENANCE_RELEASE_INVALID"],
    [releaseFixture(archive, { prerelease: true }), "PM_STUDIO_PROVENANCE_RELEASE_INVALID"],
    [releaseFixture(archive, { html_url: "https://example.test/release" }), "PM_STUDIO_PROVENANCE_RELEASE_INVALID"],
    [releaseFixture(archive, { assets: [] }), "PM_STUDIO_PROVENANCE_ASSET_INVALID"],
    [releaseFixture(archive, {
      assets: [releaseFixture(archive).assets[0], releaseFixture(archive).assets[0]],
    }), "PM_STUDIO_PROVENANCE_ASSET_INVALID"],
    [releaseFixture(archive, { asset: { name: `PM-Studio-${VERSION}-mac-x64.zip` } }), "PM_STUDIO_PROVENANCE_ASSET_INVALID"],
    [releaseFixture(archive, { asset: { digest: undefined } }), "PM_STUDIO_PROVENANCE_ASSET_INVALID"],
    [releaseFixture(archive, { asset: { digest: `sha512:${"a".repeat(64)}` } }), "PM_STUDIO_PROVENANCE_ASSET_INVALID"],
    [releaseFixture(archive, { asset: { digest: "sha256:not-a-digest" } }), "PM_STUDIO_PROVENANCE_ASSET_INVALID"],
    [releaseFixture(archive, { asset: { size: 0 } }), "PM_STUDIO_PROVENANCE_ASSET_INVALID"],
    [releaseFixture(archive, { asset: { browser_download_url: "https://github.com/other/repo/releases/download/v2.9.12/file.zip" } }), "PM_STUDIO_PROVENANCE_ASSET_INVALID"],
  ];
  for (const [release, code] of cases) {
    assert.throws(() => selectOfficialPmStudioRelease(release, { version: VERSION, arch: ARCH }), assertCode(code));
  }
});

test("verification streams an exact artifact through allowed redirects, compares the app, and cleans tmp", async () => {
  const root = temporaryRoot();
  const installedRoot = path.join(root, "installed");
  const officialTemplateRoot = path.join(root, "official-template");
  const tmpRoot = path.join(root, "tmp");
  fs.mkdirSync(tmpRoot);
  const installedAppPath = createApp(installedRoot);
  const officialAppPath = createApp(officialTemplateRoot);
  const archive = Buffer.from("streamed official zip bytes");
  const calls = [];
  let extractorCall;

  const result = await verifyOfficialPmStudioProvenance({
    installedAppPath,
    version: VERSION,
    arch: ARCH,
    tmpRoot,
    fetchImpl: successfulFetch({ archive, calls }),
    extractor: async (options) => {
      extractorCall = options;
      assert.deepEqual(fs.readFileSync(options.archivePath), archive);
      assert.equal(fs.statSync(options.archivePath).mode & 0o777, 0o600);
      assert.equal(fs.statSync(options.destination).mode & 0o777, 0o700);
      copyApp(officialAppPath, path.join(options.destination, "PM Studio.app"));
    },
  });

  assert.equal(result.verified, true);
  assert.equal(result.repository, "gim-home/max-studio");
  assert.equal(result.version, VERSION);
  assert.equal(result.tag, `v${VERSION}`);
  assert.equal(result.arch, ARCH);
  assert.equal(result.asset.name, ASSET_NAME);
  assert.equal(result.asset.sha256, sha256(archive));
  assert.equal(result.asset.size, archive.length);
  assert.deepEqual(result.comparison.ignoredMissing, []);
  assert.equal(result.comparison.comparedEntries > 3, true);
  assert.equal(path.basename(extractorCall.archivePath), ASSET_NAME);
  assert.equal(calls[0].url, `https://api.github.com/repos/gim-home/max-studio/releases/tags/v${VERSION}`);
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.redirect, "error");
  assert.equal(calls.length, 3);
  assert.equal(calls[1].url, DOWNLOAD_URL);
  assert.equal(calls[2].url, REDIRECT_URL);
  assert.equal(calls[1].init.redirect, "manual");
  assert.equal(calls[2].init.redirect, "manual");
  assert.deepEqual(fs.readdirSync(tmpRoot), []);
});

test("verification rejects metadata and streamed size limits before extraction and cleans tmp", async () => {
  const root = temporaryRoot();
  const installedAppPath = createApp(path.join(root, "installed"));
  const tmpRoot = path.join(root, "tmp");
  fs.mkdirSync(tmpRoot);
  const archive = Buffer.from("fives");
  let extracted = false;

  await assert.rejects(verifyOfficialPmStudioProvenance({
    installedAppPath,
    version: VERSION,
    arch: ARCH,
    tmpRoot,
    maxDownloadBytes: 4,
    fetchImpl: successfulFetch({ archive }),
    extractor: async () => { extracted = true; },
  }), assertCode("PM_STUDIO_PROVENANCE_DOWNLOAD_TOO_LARGE"));
  assert.equal(extracted, false);
  assert.deepEqual(fs.readdirSync(tmpRoot), []);

  const dishonestRelease = releaseFixture(archive, { asset: { size: 4 } });
  const dishonestFetch = async (url) => {
    if (String(url).startsWith("https://api.github.com/")) {
      return responseLike({ status: 200, json: async () => dishonestRelease });
    }
    return responseLike({ status: 200, body: asyncBody(archive.subarray(0, 2), archive.subarray(2)) });
  };
  await assert.rejects(verifyOfficialPmStudioProvenance({
    installedAppPath,
    version: VERSION,
    arch: ARCH,
    tmpRoot,
    maxDownloadBytes: 4,
    fetchImpl: dishonestFetch,
    extractor: async () => { extracted = true; },
  }), assertCode("PM_STUDIO_PROVENANCE_DOWNLOAD_TOO_LARGE"));
  assert.equal(extracted, false);
  assert.deepEqual(fs.readdirSync(tmpRoot), []);
});

test("verification rejects digest, length, and redirect drift without leaking upstream data", async () => {
  const root = temporaryRoot();
  const installedAppPath = createApp(path.join(root, "installed"));
  const tmpRoot = path.join(root, "tmp");
  fs.mkdirSync(tmpRoot);
  const archive = Buffer.from("official archive");

  const badDigestRelease = releaseFixture(archive, { asset: { digest: `sha256:${"0".repeat(64)}` } });
  await assert.rejects(verifyOfficialPmStudioProvenance({
    installedAppPath,
    version: VERSION,
    arch: ARCH,
    tmpRoot,
    fetchImpl: successfulFetch({ archive, release: badDigestRelease }),
    extractor: async () => assert.fail("extractor must not run"),
  }), assertCode("PM_STUDIO_PROVENANCE_DOWNLOAD_DIGEST_MISMATCH"));
  assert.deepEqual(fs.readdirSync(tmpRoot), []);

  const badLengthFetch = async (url) => {
    if (String(url).startsWith("https://api.github.com/")) {
      return responseLike({ status: 200, json: async () => releaseFixture(archive) });
    }
    return responseLike({
      status: 200,
      headers: { "content-length": String(archive.length + 1) },
      body: asyncBody(archive),
    });
  };
  await assert.rejects(verifyOfficialPmStudioProvenance({
    installedAppPath,
    version: VERSION,
    arch: ARCH,
    tmpRoot,
    fetchImpl: badLengthFetch,
    extractor: async () => assert.fail("extractor must not run"),
  }), assertCode("PM_STUDIO_PROVENANCE_DOWNLOAD_SIZE_MISMATCH"));
  assert.deepEqual(fs.readdirSync(tmpRoot), []);

  const secret = "sensitive-signed-query";
  const evilRedirectFetch = async (url) => {
    if (String(url).startsWith("https://api.github.com/")) {
      return responseLike({ status: 200, json: async () => releaseFixture(archive) });
    }
    return responseLike({
      status: 302,
      headers: { location: `https://evil.example/artifact?token=${secret}` },
    });
  };
  await assert.rejects(verifyOfficialPmStudioProvenance({
    installedAppPath,
    version: VERSION,
    arch: ARCH,
    tmpRoot,
    fetchImpl: evilRedirectFetch,
    extractor: async () => assert.fail("extractor must not run"),
  }), (error) => {
    assert.equal(error.code, "PM_STUDIO_PROVENANCE_REDIRECT_INVALID");
    assert.equal(error.message.includes(secret), false);
    return true;
  });
  assert.deepEqual(fs.readdirSync(tmpRoot), []);

  await assert.rejects(verifyOfficialPmStudioProvenance({
    installedAppPath,
    version: VERSION,
    arch: ARCH,
    tmpRoot,
    fetchImpl: successfulFetch({ archive }),
    extractor: async ({ destination }) => {
      const officialAppPath = createApp(destination);
      fs.writeFileSync(path.join(officialAppPath, "Contents", "Resources", "app.asar"), "changed");
    },
  }), assertCode("PM_STUDIO_PROVENANCE_TREE_MISMATCH"));
  assert.deepEqual(fs.readdirSync(tmpRoot), []);
});

test("verification sanitizes release failures and rejects fetch implementations that auto-follow redirects", async () => {
  const root = temporaryRoot();
  const installedAppPath = createApp(path.join(root, "installed"));
  const tmpRoot = path.join(root, "tmp");
  fs.mkdirSync(tmpRoot);
  const archive = Buffer.from("official archive");
  const secret = "upstream-secret-value";

  await assert.rejects(verifyOfficialPmStudioProvenance({
    installedAppPath,
    version: VERSION,
    arch: ARCH,
    tmpRoot,
    fetchImpl: async () => { throw new Error(secret); },
    extractor: async () => assert.fail("extractor must not run"),
  }), (error) => {
    assert.equal(error.code, "PM_STUDIO_PROVENANCE_RELEASE_FETCH_FAILED");
    assert.equal(error.message.includes(secret), false);
    return true;
  });
  assert.deepEqual(fs.readdirSync(tmpRoot), []);

  const autoRedirectFetch = async (url) => {
    if (String(url).startsWith("https://api.github.com/")) {
      return responseLike({ status: 200, json: async () => releaseFixture(archive) });
    }
    return responseLike({ status: 200, redirected: true, body: asyncBody(archive) });
  };
  await assert.rejects(verifyOfficialPmStudioProvenance({
    installedAppPath,
    version: VERSION,
    arch: ARCH,
    tmpRoot,
    fetchImpl: autoRedirectFetch,
    extractor: async () => assert.fail("extractor must not run"),
  }), assertCode("PM_STUDIO_PROVENANCE_REDIRECT_INVALID"));
  assert.deepEqual(fs.readdirSync(tmpRoot), []);
});

test("verification requires one ordinary extracted PM Studio.app and sanitizes extractor failures", async () => {
  const root = temporaryRoot();
  const installedAppPath = createApp(path.join(root, "installed"));
  const tmpRoot = path.join(root, "tmp");
  fs.mkdirSync(tmpRoot);
  const archive = Buffer.from("official archive");

  for (const extractor of [
    async () => {},
    async ({ destination }) => {
      createApp(path.join(destination, "one"));
      createApp(path.join(destination, "two"));
    },
    async ({ destination }) => {
      const outer = createApp(destination);
      createApp(path.join(outer, "Contents", "Nested"));
    },
    async ({ destination }) => {
      fs.symlinkSync(installedAppPath, path.join(destination, "PM Studio.app"));
    },
  ]) {
    await assert.rejects(verifyOfficialPmStudioProvenance({
      installedAppPath,
      version: VERSION,
      arch: ARCH,
      tmpRoot,
      fetchImpl: successfulFetch({ archive }),
      extractor,
    }), assertCode("PM_STUDIO_PROVENANCE_EXTRACT_INVALID"));
    assert.deepEqual(fs.readdirSync(tmpRoot), []);
  }

  const secret = "extractor-secret-path";
  await assert.rejects(verifyOfficialPmStudioProvenance({
    installedAppPath,
    version: VERSION,
    arch: ARCH,
    tmpRoot,
    fetchImpl: successfulFetch({ archive }),
    extractor: async () => { throw new Error(secret); },
  }), (error) => {
    assert.equal(error.code, "PM_STUDIO_PROVENANCE_EXTRACT_FAILED");
    assert.equal(error.message.includes(secret), false);
    return true;
  });
  assert.deepEqual(fs.readdirSync(tmpRoot), []);
});

test("tree comparison covers type, mode, content, symlink, missing, and extra drift", async () => {
  const root = temporaryRoot();
  const officialAppPath = createApp(path.join(root, "official"));

  const mutations = [
    (installed) => fs.chmodSync(path.join(installed, "Contents", "MacOS", "PM Studio"), 0o700),
    (installed) => fs.writeFileSync(path.join(installed, "Contents", "Resources", "app.asar"), "changed"),
    (installed) => {
      const target = path.join(installed, "Contents", "Resources", "app.asar");
      fs.rmSync(target);
      fs.mkdirSync(target);
    },
    (installed) => {
      const link = path.join(installed, "Contents", "Frameworks", "Shared.framework", "Versions", "Current");
      fs.rmSync(link);
      fs.symlinkSync("..", link);
    },
    (installed) => fs.rmSync(path.join(installed, "Contents", "Resources", "app.asar")),
    (installed) => writeFile(path.join(installed, "Contents", "Resources", "extra.txt"), "extra"),
  ];

  for (const mutate of mutations) {
    const installedAppPath = path.join(root, `installed-${Math.random()}`);
    copyApp(officialAppPath, installedAppPath);
    mutate(installedAppPath);
    await assert.rejects(comparePmStudioAppTrees(installedAppPath, officialAppPath),
      assertCode("PM_STUDIO_PROVENANCE_TREE_MISMATCH"));
  }
});

test("tree comparison includes stable extended attributes and ignores only the frozen volatile set", async () => {
  const root = temporaryRoot();
  const officialAppPath = createApp(path.join(root, "official"));
  const installedAppPath = path.join(root, "installed.app");
  copyApp(officialAppPath, installedAppPath);
  const relative = "Contents/Resources/app.asar";
  const stable = "com.example.stable";
  const outputs = new Map();
  const readXattrOutput = async (appPath) => outputs.get(appPath) || "";

  outputs.set(installedAppPath, xattrOutput(installedAppPath, relative, stable, "same"));
  outputs.set(officialAppPath, xattrOutput(officialAppPath, relative, stable, "same"));
  await comparePmStudioAppTrees(installedAppPath, officialAppPath, { readXattrOutput });

  outputs.set(installedAppPath, xattrOutput(installedAppPath, relative, stable, "changed"));
  await assert.rejects(comparePmStudioAppTrees(installedAppPath, officialAppPath, { readXattrOutput }),
    assertCode("PM_STUDIO_PROVENANCE_TREE_MISMATCH"));

  outputs.set(installedAppPath, "");
  await assert.rejects(comparePmStudioAppTrees(installedAppPath, officialAppPath, { readXattrOutput }),
    assertCode("PM_STUDIO_PROVENANCE_TREE_MISMATCH"));

  outputs.set(installedAppPath,
    xattrOutput(installedAppPath, relative, "com.apple.quarantine", "local"));
  outputs.set(officialAppPath, "");
  await comparePmStudioAppTrees(installedAppPath, officialAppPath, { readXattrOutput });
});

test("tree comparison rejects hardlinks and unsafe symlinks", async () => {
  const root = temporaryRoot();
  const officialAppPath = createApp(path.join(root, "official"));

  const hardlinkedApp = path.join(root, "hardlinked.app");
  copyApp(officialAppPath, hardlinkedApp);
  fs.linkSync(
    path.join(hardlinkedApp, "Contents", "Resources", "app.asar"),
    path.join(hardlinkedApp, "Contents", "Resources", "app-copy.asar"),
  );
  await assert.rejects(comparePmStudioAppTrees(hardlinkedApp, officialAppPath),
    assertCode("PM_STUDIO_PROVENANCE_HARDLINK_INVALID"));

  for (const target of ["/tmp", "../../../../../../tmp"] ) {
    const unsafeApp = path.join(root, `unsafe-${Math.random()}.app`);
    copyApp(officialAppPath, unsafeApp);
    const link = path.join(unsafeApp, "Contents", "Frameworks", "Shared.framework", "Versions", "Current");
    fs.rmSync(link);
    fs.symlinkSync(target, link);
    await assert.rejects(comparePmStudioAppTrees(unsafeApp, officialAppPath),
      assertCode("PM_STUDIO_PROVENANCE_SYMLINK_INVALID"));
  }
});

test("tree comparison permits only strict missing Electron locale paths", async () => {
  const root = temporaryRoot();
  const officialAppPath = createApp(path.join(root, "official"));
  const localeRoot = path.join(
    officialAppPath,
    "Contents", "Frameworks", "Electron Framework.framework", "Versions", "A", "Resources",
  );
  writeFile(path.join(localeRoot, "en.lproj", "locale.pak"), "en");
  writeFile(path.join(localeRoot, "zh_CN.lproj", "locale.pak"), "zh");
  writeFile(path.join(localeRoot, "af_MASCULINE.lproj", "locale.pak"), "af");
  fs.mkdirSync(path.join(officialAppPath, "Contents", "Resources", "af.lproj"), { recursive: true });

  const missingDirectoryApp = path.join(root, "missing-directory.app");
  copyApp(officialAppPath, missingDirectoryApp);
  fs.rmSync(path.join(
    missingDirectoryApp,
    "Contents", "Frameworks", "Electron Framework.framework", "Versions", "A", "Resources", "en.lproj",
  ), { recursive: true });
  const directoryResult = await comparePmStudioAppTrees(missingDirectoryApp, officialAppPath);
  assert.deepEqual(directoryResult.ignoredMissing, [
    "Contents/Frameworks/Electron Framework.framework/Versions/A/Resources/en.lproj",
    "Contents/Frameworks/Electron Framework.framework/Versions/A/Resources/en.lproj/locale.pak",
  ]);

  const missingGenderLocaleApp = path.join(root, "missing-gender-locale.app");
  copyApp(officialAppPath, missingGenderLocaleApp);
  fs.rmSync(path.join(
    missingGenderLocaleApp,
    "Contents", "Frameworks", "Electron Framework.framework", "Versions", "A", "Resources", "af_MASCULINE.lproj",
  ), { recursive: true });
  const genderResult = await comparePmStudioAppTrees(missingGenderLocaleApp, officialAppPath);
  assert.deepEqual(genderResult.ignoredMissing, [
    "Contents/Frameworks/Electron Framework.framework/Versions/A/Resources/af_MASCULINE.lproj",
    "Contents/Frameworks/Electron Framework.framework/Versions/A/Resources/af_MASCULINE.lproj/locale.pak",
  ]);

  const missingAppLocaleApp = path.join(root, "missing-app-locale.app");
  copyApp(officialAppPath, missingAppLocaleApp);
  fs.rmSync(path.join(missingAppLocaleApp, "Contents", "Resources", "af.lproj"), { recursive: true });
  const appLocaleResult = await comparePmStudioAppTrees(missingAppLocaleApp, officialAppPath);
  assert.deepEqual(appLocaleResult.ignoredMissing, ["Contents/Resources/af.lproj"]);

  const missingPakApp = path.join(root, "missing-pak.app");
  copyApp(officialAppPath, missingPakApp);
  fs.rmSync(path.join(
    missingPakApp,
    "Contents", "Frameworks", "Electron Framework.framework", "Versions", "A", "Resources", "zh_CN.lproj", "locale.pak",
  ));
  const pakResult = await comparePmStudioAppTrees(missingPakApp, officialAppPath);
  assert.deepEqual(pakResult.ignoredMissing, [
    "Contents/Frameworks/Electron Framework.framework/Versions/A/Resources/zh_CN.lproj/locale.pak",
  ]);

  for (const relative of [
    "Contents/Frameworks/Electron Framework.framework/Versions/B/Resources/en.lproj/locale.pak",
    "Contents/Frameworks/Electron Framework.framework/Versions/A/Resources/secrets.lproj/locale.pak",
    "Contents/Frameworks/Electron Framework.framework/Versions/A/Resources/en.lproj/other.pak",
    "Contents/Resources/secrets.lproj",
    "Contents/Resources/en.lproj/other.pak",
  ]) {
    const strictOfficial = path.join(root, `strict-official-${Math.random()}.app`);
    const strictInstalled = path.join(root, `strict-installed-${Math.random()}.app`);
    copyApp(officialAppPath, strictOfficial);
    writeFile(path.join(strictOfficial, ...relative.split("/")), "must-not-be-ignored");
    copyApp(strictOfficial, strictInstalled);
    fs.rmSync(path.join(strictInstalled, ...relative.split("/")));
    await assert.rejects(comparePmStudioAppTrees(strictInstalled, strictOfficial),
      assertCode("PM_STUDIO_PROVENANCE_TREE_MISMATCH"));
  }
});
