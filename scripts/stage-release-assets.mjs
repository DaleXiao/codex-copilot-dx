import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export function stageReleaseAssets({ directory, repository, run = execFileSync, ciRun = process.env.CCDX_CI_RUN, resumeRun = process.env.CCDX_RESUME_RUN }) {
  if (!path.isAbsolute(directory || "") || !/^[\w.-]+\/[\w.-]+$/.test(repository || "")) throw Error("Supply the release directory and repository");
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, "package-manifest.json"))), version = manifest.version;
  const commit = run("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (!/^\d+\.\d+\.\d+$/.test(version) || !/^\d+$/.test(ciRun || "") || manifest.commit !== commit || manifest.ci_run !== ciRun) throw Error("Release artifact provenance differs from the verified checkout or CI run");
  const sha = bytes => createHash("sha256").update(bytes).digest("hex"), expected = new Map();
  for (const line of fs.readFileSync(path.join(directory, "SHA256SUMS"), "utf8").trim().split("\n")) {
    const match = /^([a-f0-9]{64})  ([A-Za-z0-9][A-Za-z0-9._-]{0,180})$/.exec(line);
    if (!match || expected.has(match[2]) || sha(fs.readFileSync(path.join(directory, match[2]))) !== match[1]) throw Error("Invalid original shipping checksums");
    expected.set(match[2], match[1]);
  }
  expected.set("SHA256SUMS", sha(fs.readFileSync(path.join(directory, "SHA256SUMS"))));
  const tag = `v${version}`;let release;
  try { release = JSON.parse(run("gh", ["api", `repos/${repository}/releases/tags/${tag}`], { encoding: "utf8" })); }
  catch (error) {
    if (!/HTTP 404|release not found/i.test(String(error.stderr || error.message))) throw error;
    run("gh", ["release", "create", tag, "--repo", repository, "--draft", "--verify-tag", "--title", `CCDX ${version}`, "--notes-file", "docs/RELEASE.md"], { stdio: "inherit" });
    release = { draft: true, assets: [] };
  }
  if (!release.draft && !/^\d+$/.test(resumeRun || "")) throw Error("This release is already public. Use the original publication run's verification-only recovery; do not publish npm again.");
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-stage-check-")), missing = [];
  try {
    // Validate every existing asset before uploading anything. A resumed run
    // never replaces published bytes, even if its builder produced new bytes.
    for (const [name, digest] of expected) {
      const asset = release.assets.find(entry => entry.name === name), bytes = fs.statSync(path.join(directory, name)).size;
      if (!asset) {
        if (!release.draft) throw Error(`Published shipping asset is missing: ${name}; original assets were not changed`);
        missing.push(path.join(directory, name));continue;
      }
      if (asset.size !== bytes) throw Error(`Existing shipping asset differs: ${name}`);
      if (asset.digest) {
        if (asset.digest !== `sha256:${digest}`) throw Error(`Existing shipping asset differs: ${name}`);
      } else {
        run("gh", ["release", "download", tag, "--repo", repository, "--pattern", name, "--dir", temporary], { stdio: "inherit" });
        if (sha(fs.readFileSync(path.join(temporary, name))) !== digest) throw Error(`Existing shipping asset differs: ${name}`);
      }
    }
    if (missing.length) run("gh", ["release", "upload", tag, "--repo", repository, ...missing], { stdio: "inherit" });
    return { version, uploaded: missing.length, preserved: expected.size - missing.length };
  } finally { fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 3 }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(stageReleaseAssets({ directory: process.argv[2], repository: process.env.GITHUB_REPOSITORY })));
}
