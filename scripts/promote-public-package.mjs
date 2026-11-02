import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { stableVersion } from "../src/release-install.mjs";
import { verificationTag, waitForPublicPackage } from "./public-npm-state.mjs";

export async function promotePublicPackage({ manifest, receipt, assets, run, verify = waitForPublicPackage }) {
  const version = manifest.version, source = assets.assets?.find(asset => asset.name === manifest.filename);
  if (manifest.name !== "codex-copilot-dx" || !stableVersion(version) || manifest.filename !== `${manifest.name}-${version}.tgz`
    || !Number.isSafeInteger(manifest.size) || !source || receipt.version !== version || receipt.integrity !== manifest.integrity
    || receipt.installed_cli !== true || receipt.native_modules !== true || assets.version !== version || !assets.verified || assets.assets?.length !== 14
    || source?.sha256 !== receipt.sha256 || source?.bytes !== manifest.size) throw Error("Public package installation and all assets must be verified before promotion");
  const tags = JSON.parse(run(["view", manifest.name, "dist-tags", "--registry=https://registry.npmjs.org/", "--json"]));
  if (tags.latest && !stableVersion(tags.latest)) throw Error("The existing npm latest version cannot be compared safely");
  if (tags.latest && tags.latest !== version) {
    const before = tags.latest.split(".").map(Number), after = version.split(".").map(Number);
    const at = before.findIndex((value, index) => value !== after[index]);
    if (at >= 0 && before[at] > after[at]) throw Error("A newer npm latest version exists; refusing to downgrade it");
  }
  if (tags.latest !== version) run(["dist-tag", "add", `${manifest.name}@${version}`, "latest"]);
  await verify({ name: manifest.name, version, integrity: manifest.integrity,
    onWait: () => console.log("Waiting for the verified npm latest tag") });
  let cleanup = "not_present";
  if (tags[verificationTag(version)] === version) {
    try { run(["dist-tag", "rm", manifest.name, verificationTag(version)]);cleanup = "removed"; }
    catch (error) {
      if (error.statusCode !== 403 && !/\bE403\b|403 Forbidden|HTTP 403/.test(String(error.stderr || ""))) throw error;
      cleanup = "denied";console.warn("npm denied verification-tag cleanup; the verified latest version is retained. No permission or policy change was attempted.");
    }
  }
  return { ...receipt, latest: version, latest_verified: true, verification_tag_cleanup: cleanup };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const directory = process.argv[2];if (!path.isAbsolute(directory || "")) throw Error("Supply the verified artifact directory");
  const read = name => JSON.parse(fs.readFileSync(path.join(directory, name))), npm = process.env.npm_execpath || path.resolve(path.dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js");
  const receipt = await promotePublicPackage({ manifest: read("package-manifest.json"), receipt: read("public-npm-receipt.json"), assets: read("public-assets-receipt.json"),
    run: args => execFileSync(process.execPath, [npm, ...args], { encoding: "utf8", timeout: 60000 }) });
  fs.writeFileSync(path.join(directory, "public-npm-receipt.json"), JSON.stringify(receipt, null, 2) + "\n");console.log(JSON.stringify(receipt));
}
