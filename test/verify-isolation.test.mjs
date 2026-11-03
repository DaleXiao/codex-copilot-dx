import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("every verification check gets an isolated profile while packing retains npm policy", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-verify-env-test-"));t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const preload = path.join(root, "preload.cjs"), calls = path.join(root, "calls.json"), config = path.join(root, "policy.npmrc");
  fs.writeFileSync(config, "registry=https://synthetic.registry.example/\n");
  fs.writeFileSync(preload, [
    "const cp=require('node:child_process'),fs=require('node:fs');",
    "cp.spawnSync=(node,args,options)=>{const env=options.env;const file=process.env.CALLS;",
    "const rows=fs.existsSync(file)?JSON.parse(fs.readFileSync(file)):[];rows.push({node,args,home:env.HOME,code:env.CODEX_HOME,xdg:env.XDG_CONFIG_HOME,",
    "credential:!!env.OPENAI_API_KEY||!!env.GH_TOKEN,policy:env.npm_config_userconfig,registry:env.npm_config_registry,path:env.PATH});",
    "fs.writeFileSync(file,JSON.stringify(rows));return{status:0};};require('node:module').syncBuiltinESMExports();",
  ].join("\n"));
  const script = fileURLToPath(new URL("../scripts/verify.mjs", import.meta.url));
  const run = spawnSync(process.execPath, ["--require", preload, script], { env: { ...process.env, CALLS: calls,
    HOME: root, USERPROFILE: root, TMPDIR: root, OPENAI_API_KEY: "synthetic-only", GH_TOKEN: "synthetic-only",
    npm_execpath: path.join(root, "fake-npm.js"), npm_node_execpath: process.execPath, npm_config_userconfig: config,
    npm_config_registry: "https://synthetic.registry.example/" }, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const rows = JSON.parse(fs.readFileSync(calls));assert.equal(rows.length, 6);
  for (const row of rows) {
    assert.notEqual(row.home, root);assert.ok(row.code.startsWith(row.home));assert.ok(row.xdg.startsWith(row.home));
    assert.equal(row.node, process.execPath);assert.equal(row.credential, false);assert.ok(row.path.startsWith(path.dirname(process.execPath)));
  }
  const pack = rows.at(-1);assert.equal(pack.policy, config);assert.equal(pack.registry, "https://synthetic.registry.example/");
  assert.equal(fs.existsSync(rows[0].home), false, "The temporary verification profile was not cleaned");
});
