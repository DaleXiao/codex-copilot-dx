import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const output = process.argv[2], target = process.argv[3] || `${process.platform}-${process.arch}`, go = process.env.CCDX_BUILD_GO || "go";
if (!output || !path.isAbsolute(output) || !/^(darwin|win32)-(arm64|x64)$/.test(target)) throw Error("Supply an absolute output directory and supported target");
await fs.mkdir(output, { recursive: true });
const [platform, arch] = target.split("-"), name = `ccdx-privacy-guard-1-${target}${platform === "win32" ? ".exe" : ""}`, file = path.join(output, name);
await promisify(execFile)(go, ["build", "-mod=vendor", "-trimpath", "-buildvcs=false", "-ldflags", "-s -w", "-o", file, "."], {
  cwd: fileURLToPath(new URL("../native/privacy-guard/", import.meta.url)),
  env: { ...process.env, GOTOOLCHAIN: "local", GOOS: platform === "darwin" ? "darwin" : "windows", GOARCH: arch === "x64" ? "amd64" : "arm64", CGO_ENABLED: platform === "darwin" ? "1" : "0" },
  timeout: 180000, maxBuffer: 65536,
});
const bytes = await fs.readFile(file), digest = createHash("sha256").update(bytes).digest("hex");
await fs.writeFile(file + ".sha256", `${digest}  ${name}\n`);
console.log(JSON.stringify({ target, name, bytes: bytes.length, sha256: digest }));
