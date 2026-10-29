// Builds a platform-specific npm tarball from the same source package and lock.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runtimeReleaseTarget } from "../src/release-install.mjs";

const root = fileURLToPath(new URL("../", import.meta.url)), output = process.argv[2];
if (!path.isAbsolute(output || "") || !process.env.npm_execpath) throw Error("Run through npm: npm run release:runtime -- /absolute/artifact-directory");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"))), target = runtimeReleaseTarget();
const sourceManifest = JSON.parse(fs.readFileSync(path.join(output, "package-manifest.json")));
if (sourceManifest.name !== pkg.name || sourceManifest.version !== pkg.version) throw Error("Build the matching source Release package first");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-runtime-pack-")), stage = path.join(directory, "package");
const names = new Set(), copied = new Set();
function copyDependency(name, importer, optional = false) {
  const search = createRequire(importer).resolve.paths(name) || [];
  const source = search.map(base => path.join(base, name)).find(base => fs.existsSync(path.join(base, "package.json")));
  if (!source) { if (optional) return;throw Error(`Missing runtime dependency ${name}`); }
  const relative = path.relative(root, source);
  if (!relative.startsWith("node_modules" + path.sep) || relative.split(path.sep).includes("..")) throw Error("Runtime dependencies must come from this locked installation");
  if (copied.has(source)) return;copied.add(source);names.add(name);
  const destination = path.join(stage, relative);fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(source, destination, { recursive: true, verbatimSymlinks: true });
  const metadata = JSON.parse(fs.readFileSync(path.join(source, "package.json")));
  for (const dependency of Object.keys(metadata.dependencies || {})) copyDependency(dependency, path.join(source, "package.json"));
  for (const dependency of Object.keys(metadata.optionalDependencies || {})) copyDependency(dependency, path.join(source, "package.json"), true);
}
try {
  const source = path.join(output, `codex-copilot-dx-${pkg.version}.tgz`), sourceBytes = fs.readFileSync(source);
  if (`sha512-${createHash("sha512").update(sourceBytes).digest("base64")}` !== sourceManifest.integrity) throw Error("Source package changed after packing");
  const tar = createRequire(process.env.npm_execpath)("tar");
  tar.x({ file: source, cwd: directory, sync: true, filter: name => name.startsWith("package/") && !name.split(/[\\/]/).includes("..") });
  const required = [...Object.keys(pkg.dependencies || {}), ...Object.keys(pkg.optionalDependencies || {})];
  for (const name of required) copyDependency(name, path.join(root, "package.json"));
  // The official Broker ships several OS/architecture binaries in one package.
  const native = path.join(stage, "node_modules/@azure/msal-node-runtime/dist"), keep = { darwin: "macos", win32: "windows" }[process.platform];
  for (const system of ["macos", "windows", "linux"]) if (system !== keep) fs.rmSync(path.join(native, system), { recursive: true, force: true });
  for (const arch of ["x64", "arm64", "x86"]) {
    if (arch !== process.arch) fs.rmSync(path.join(native, keep, arch), { recursive: true, force: true });
  }
  const metadata = { ...pkg, bundleDependencies: required, os: [process.platform], cpu: [process.arch],
    ccdx_runtime: { schema: 1, target, lock_sha256: createHash("sha256").update(fs.readFileSync(path.join(root, "package-lock.json"))).digest("hex") } };
  fs.writeFileSync(path.join(stage, "package.json"), JSON.stringify(metadata, null, 2) + "\n");
  const values = JSON.parse(execFileSync(process.execPath, [process.env.npm_execpath, "pack", "--ignore-scripts", "--json", "--pack-destination", directory], { cwd: stage, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }));
  const packed = (Array.isArray(values) ? values : Object.values(values))[0];
  for (const name of required) if (!packed.bundled?.includes(name)) throw Error(`Runtime pack omitted ${name}`);
  const name = `codex-copilot-dx-${pkg.version}-${target}.tgz`, bytes = fs.readFileSync(path.join(directory, packed.filename));
  if (bytes.length > 64 * 1024 * 1024 || packed.unpackedSize > 256 * 1024 * 1024) throw Error("Runtime pack exceeds the updater's bounded size");
  fs.writeFileSync(path.join(output, name), bytes);
  fs.writeFileSync(path.join(output, `${name}.manifest.json`), JSON.stringify({ ...packed, filename: name, target, runtime_dependencies: [...names].sort() }, null, 2) + "\n");
  fs.writeFileSync(path.join(output, `${name}.sha256`), `${createHash("sha256").update(bytes).digest("hex")}  ${name}\n`);
  console.log(`Complete ${target}: ${bytes.length} compressed bytes; ${packed.unpackedSize} unpacked bytes.`);
} finally { fs.rmSync(directory, { recursive: true, force: true }); }
