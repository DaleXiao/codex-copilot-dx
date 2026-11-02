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
    if (args[1].includes('/jobs?')) { const names=['codex-client','privacy-native-windows','macos','windows-prediction','dashboard-browsers','runtime-packages / runtime'];const jobs=Array.from({length:24},(_,i)=>({name:names[i%6],conclusion:mode==='failed'&&i===0?'failure':'success'}));return JSON.stringify({total_count:mode==='incomplete'?25:24,jobs}); }
    return JSON.stringify({head_sha:(mode==='wrong'?'b':'a').repeat(40),path:'.github/workflows/ci.yml',status:'completed',conclusion:'success',event:mode==='pr'?'pull_request':'push',head_branch:'main'});
  };require('node:module').syncBuiltinESMExports();`);
  for (const mode of ["valid", "pr", "wrong", "incomplete", "failed"]) {
    const result = spawnSync(process.execPath, ["--require", preload, fileURLToPath(new URL("../scripts/release-gate.mjs", import.meta.url))], { env: { ...process.env, CCDX_CI_RUN: "123", GITHUB_REPOSITORY: "fixture/ccdx", FIXTURE_GATE: mode }, encoding: "utf8" });
    assert.equal(result.status, mode === "valid" ? 0 : 1, `${mode}: ${result.stderr}`);
  }
});
