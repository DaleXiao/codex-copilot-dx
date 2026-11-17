import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { discoverSourceImport, previewDiscoveredProviders, sourceImportLocation } from "../src/source-discovery.mjs";

const secret = "fixture-not-a-real-credential";
const row = (name = "Example", extra = {}) => ({ id: name, app_type: "claude", name,
  settings: { env: { ANTHROPIC_BASE_URL: "https://example.test/v1", ANTHROPIC_AUTH_TOKEN: secret, permissions: { bypass: true } } }, meta: {}, ...extra });
async function home(t) { const root = await fs.mkdtemp(path.join(os.tmpdir(), "ccdx-source-discovery-"));t.after(() => fs.rm(root, { recursive: true, force: true }));return root; }
async function database(file, rows, { wal = false } = {}) {
  await fs.mkdir(path.dirname(file), { recursive: true });const { DatabaseSync } = await import("node:sqlite"), db = new DatabaseSync(file);
  if (wal) db.exec("PRAGMA journal_mode=WAL");
  db.exec("CREATE TABLE providers(id TEXT,app_type TEXT,name TEXT,settings_config TEXT,meta TEXT,PRIMARY KEY(id,app_type))");
  const insert = db.prepare("INSERT INTO providers VALUES(?,?,?,?,?)");
  for (const r of rows) insert.run(r.id, r.app_type, r.name, JSON.stringify(r.settings), JSON.stringify(r.meta));
  return db;
}
const digest = async file => createHash("sha256").update(await fs.readFile(file)).digest("hex");

test("discovery projects declared protocols and omits credentials, permissions and foreign model aliases", () => {
  const value = previewDiscoveredProviders("cc-switch", [row(), row("Chat", { meta: { apiFormat: "openai_chat" } }),
    row("Responses", { meta: { apiFormat: "openai_responses" } }), row("OAuth", { meta: { providerType: "codex_oauth" } }),
    row("Gemini", { meta: { apiFormat: "gemini_native" } }), row("Codex", { app_type: "codex", settings: { auth: { OPENAI_API_KEY: secret }, config: 'model_provider="relay"\n[model_providers.relay]\nbase_url="https://codex.test/v1"\nwire_api="responses"\n' } })]);
  assert.equal(value.drafts.length, 4);assert.equal(value.discovery.skipped, 2);
  assert.equal(value.drafts[0].config.endpoints.messages, "https://example.test/v1/messages");
  assert.equal(value.drafts[1].config.endpoints.chat, "https://example.test/v1/chat/completions");
  assert.equal(value.drafts[2].config.endpoints.responses, "https://example.test/v1/responses");
  assert.equal(value.drafts[3].config.endpoints.responses, "https://codex.test/v1/responses");
  const apiKey = previewDiscoveredProviders("cc-switch", [row("Native key", { settings: { env: { ANTHROPIC_BASE_URL: "https://native.test", ANTHROPIC_API_KEY: secret } } })]);
  assert.equal(apiKey.drafts[0].config.auth_header, "x-api-key");assert.doesNotMatch(JSON.stringify(apiKey), /fixture-not-a-real/);
  for (const item of value.drafts) { assert.deepEqual(item.allowed, []);assert.deepEqual(item.config.models, []);assert.equal(item.credential, "private_input_required"); }
  assert.doesNotMatch(JSON.stringify(value), /fixture-not-a-real|permissions|OPENAI_API_KEY|ANTHROPIC_AUTH_TOKEN/);
});

test("cc-switch discovery reads actual SQLite without changing configuration and reports conflicts", async t => {
  const root = await home(t), file = path.join(root, ".cc-switch/cc-switch.db");(await database(file, [row()])).close();const before = await digest(file);
  const value = await discoverSourceImport("cc-switch", { home: root, env: {} }, [{ name: "Example", base_url: "https://example.test/v1" }]);
  assert.equal(value.discovery.state, "ready");assert.equal(value.drafts.length, 1);assert.equal(await digest(file), before);
  assert.ok(value.drafts[0].warnings.includes("name_exists"));assert.ok(value.drafts[0].warnings.includes("endpoint_exists"));
  assert.doesNotMatch(JSON.stringify(value), /fixture-not-a-real/);assert.deepEqual((await fs.readdir(path.dirname(file))).sort(), ["cc-switch.db"]);
});

test("known custom directories and XDG paths follow each tool without scanning other folders", async t => {
  const root = await home(t), custom = path.join(root, "custom"), appData = path.join(root, "roaming");await fs.mkdir(custom);
  for (const platform of ["darwin", "win32"]) {
    const data = platform === "win32" ? appData : path.join(root, "Library/Application Support");
    await fs.mkdir(path.join(data, "com.ccswitch.desktop"), { recursive: true });
    await fs.writeFile(path.join(data, "com.ccswitch.desktop/app_paths.json"), JSON.stringify({ app_config_dir_override: "~/custom" }));
    assert.equal(await sourceImportLocation("cc-switch", { home: root, platform, env: { APPDATA: appData } }), path.join(custom, "cc-switch.db"));
  }
  const xdg = path.join(root, "xdg");assert.equal(await sourceImportLocation("magpie", { home: root, env: { XDG_CONFIG_HOME: xdg } }), path.join(xdg, "magpie/providers.json"));
});

test("a live WAL is read without losing its newer providers or modifying database content", async t => {
  const root = await home(t), file = path.join(root, ".cc-switch/cc-switch.db"), db = await database(file, [row()], { wal: true });
  try {
    const before = await digest(file), wal = await digest(file + "-wal"), value = await discoverSourceImport("cc-switch", { home: root, env: {} });
    assert.equal(value.discovery.state, "ready");assert.equal(value.drafts.length, 1);assert.equal(await digest(file), before);assert.equal(await digest(file + "-wal"), wal);
  } finally { db.close(); }
});

test("missing, malformed and locked stores fail without exposing their contents", async t => {
  const root = await home(t), options = { home: root, env: {} }, file = path.join(root, ".cc-switch/cc-switch.db");
  assert.equal((await discoverSourceImport("cc-switch", options)).discovery.state, "not_found");
  await fs.mkdir(path.dirname(file), { recursive: true });await fs.writeFile(file, secret);
  const invalid = await discoverSourceImport("cc-switch", options);assert.equal(invalid.discovery.state, "unreadable");assert.doesNotMatch(JSON.stringify(invalid), /fixture-not-a-real/);
  await fs.unlink(file);const db = await database(file, [row()]);
  try { db.exec("BEGIN EXCLUSIVE");assert.equal((await discoverSourceImport("cc-switch", options)).discovery.state, "busy"); }
  finally { db.exec("ROLLBACK"); }
  try { db.exec("DROP TABLE providers");assert.equal((await discoverSourceImport("cc-switch", options)).discovery.state, "unsupported"); } finally { db.close(); }
  await assert.rejects(discoverSourceImport("shell", options), /ccdx_import_discovery_invalid/);
});

test("Magpie discovery is metadata-only, bounded and leaves provider and credential files unchanged", async t => {
  const root = await home(t), file = path.join(root, ".config/magpie/providers.json");await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ providers: Array.from({ length: 20 }, (_, id) => ({ id: String(id), name: "Provider " + id, anthropic: "https://api.test", key: secret, keys: [{ key: secret }] })) }));
  const before = await digest(file), value = await discoverSourceImport("magpie", { home: root, env: {} });
  assert.equal(value.drafts.length, 16);assert.equal(value.discovery.truncated, true);assert.equal(await digest(file), before);
  assert.doesNotMatch(JSON.stringify(value), /fixture-not-a-real|"keys"/);
});
