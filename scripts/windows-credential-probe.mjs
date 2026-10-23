import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { createApiSecretStore } from "../src/api-secrets.mjs";
const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-secret-proof-"));
const env = { ...process.env, XDG_CONFIG_HOME: path.join(home, ".config") };
const store = createApiSecretStore({ home, env });
try {
 const start=Date.now(), ref="f".repeat(32), key="synthetic-probe-only-!$&'()";
 await store.set(ref,key);store.close();assert.equal(await store.get(ref),key);
 await store.remove(ref);store.close();await assert.rejects(store.get(ref));
 console.log(JSON.stringify({roundtrip:true,cold_read:true,removed:true,elapsed_ms:Date.now()-start}));
} finally {store.close();fs.rmSync(home,{recursive:true,force:true});}
