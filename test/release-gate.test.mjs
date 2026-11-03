import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("publication rejects a green PR, wrong source bytes or incomplete job evidence", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-release-gate-"));t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const preload = path.join(directory, "fake-gh.cjs");
  fs.writeFileSync(preload, `const cp = require('node:child_process');cp.execFileSync = (command,args) => {
    if (command === 'git') return 'a'.repeat(40);
    if (command !== 'gh') throw Error('Unexpected external command');
    const mode = process.env.FIXTURE_GATE;
    if(args[1].endsWith('/runs/456'))return JSON.stringify({path:mode==='wrong_resume'?'.github/workflows/ci.yml':'.github/workflows/publish.yml',event:'workflow_dispatch',status:'completed'});
    if (args[1].includes('/jobs?')) {
      const names=['codex-client','privacy-native-windows','macos (22.15.0)','macos (24.x)','windows-prediction (22.15.0)','windows-prediction (24.x)',
        'prediction-browsers (macos-latest)','prediction-browsers (windows-latest)','npm12-install (macos-latest)','npm12-install (windows-latest)','bootstrap (macos-latest)','bootstrap (windows-latest)',
        'dashboard-browsers (chromium, green)','dashboard-browsers (chromium, klein)','dashboard-browsers (chromium, pink)','dashboard-browsers (chromium, mono)',
        'dashboard-browsers (webkit, green)','dashboard-browsers (webkit, klein)','dashboard-browsers (webkit, pink)','dashboard-browsers (webkit, mono)',
        'runtime-packages / runtime (macos-latest, darwin-arm64)','runtime-packages / runtime (windows-latest, win32-x64)','runtime-packages / runtime (windows-11-arm, win32-arm64)'];
      if(mode==='missing_platform')names[22]=names[21];
      const jobs=names.map((name,i)=>({name,conclusion:mode==='failed'&&i===0?'failure':'success'}));return JSON.stringify({total_count:mode==='incomplete'?24:23,jobs});
    }
    return JSON.stringify({head_sha:(mode==='wrong'?'b':'a').repeat(40),path:'.github/workflows/ci.yml',status:'completed',conclusion:'success',event:mode==='pr'?'pull_request':'push',head_branch:'main'});
  };require('node:module').syncBuiltinESMExports();`);
  for (const mode of ["valid", "pr", "wrong", "incomplete", "failed", "missing_platform", "resume", "wrong_resume"]) {
    const result = spawnSync(process.execPath, ["--require", preload, fileURLToPath(new URL("../scripts/release-gate.mjs", import.meta.url))], { env: { ...process.env, CCDX_CI_RUN: "123", CCDX_RESUME_RUN: mode.includes("resume") ? "456" : "", GITHUB_REPOSITORY: "fixture/ccdx", FIXTURE_GATE: mode }, encoding: "utf8" });
    assert.equal(result.status, ["valid", "resume"].includes(mode) ? 0 : 1, `${mode}: ${result.stderr}`);
  }
});
