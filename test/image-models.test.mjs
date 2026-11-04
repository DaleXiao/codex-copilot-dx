import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { imageModelCatalog, imageModelSelection, DEFAULT_IMAGE_MODEL } from "../src/image-models.mjs";
import { createProviderRuntime } from "../src/provider-runtime.mjs";
import { createServiceControl } from "../src/service-control.mjs";
import { publicModelCatalog } from "../src/provider-metadata.mjs";
import { authProfilePaths } from "../src/auth-profile.mjs";
import { readAccessSettings, updateAccessSettings, checkedAccessSettings, defaultAccessSettings } from "../src/access-settings.mjs";
import { invokeAdapter } from "../test-support/adapter.mjs";

const image = (id, patch = {}) => ({ id, name: id.toUpperCase(), model_picker_enabled: false, capabilities: { type: "image" },
  supported_endpoints: ["/v1/images/generations", "/v1/images/edits"], ...patch });
const chat = { id: "gpt-conversation", model_picker_enabled: true, supported_endpoints: ["/responses"], capabilities: { type: "chat" } };
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccdx-image-models-")), env = { CCDX_M365: "0" };
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const token = authProfilePaths("codex", { home }).tokenPath;fs.mkdirSync(path.dirname(token), { recursive: true });fs.writeFileSync(token, "synthetic-only");
  const registry = { models: { data: [chat, image("render-one"), image("render-two")] } }, syncs = [];
  const runtime = createProviderRuntime({ home, env, platform: "linux", githubClient: {}, githubRegistry: registry,
    refreshGithubCatalog: async () => registry.models, inspectDesktop: async () => false,
    secretStore: { get: async () => null, close() {} }, configureCodex: input => { syncs.push(input);return { state: "configured" }; }, restoreClaude: () => ({ preserved: 0 }) });
  t.after(() => runtime.close());
  return { home, env, runtime, registry, syncs };
}

test("image discovery uses declared capability and generation endpoints, independent of chat picker visibility", () => {
  const models = imageModelCatalog({ data: [image("render-one"), image("restricted", { policy: { state: "disabled" } }),
    image("edit-only", { supported_endpoints: ["/v1/images/edits"] }), image("bad-endpoints", { supported_endpoints: {} }), { ...chat, id: "image-looking-chat" }] });
  assert.deepEqual(models.map(m => m.id), ["render-one"]);assert.equal(models[0].editing, true);
  const catalog = publicModelCatalog([image("render-one")]);assert.equal(catalog[0].kind, "image");assert.equal(catalog[0].state, "listed");assert.ok(catalog[0].endpoints.includes("images"));
  assert.equal(imageModelSelection([models[0], { id: DEFAULT_IMAGE_MODEL }]).selected_model, DEFAULT_IMAGE_MODEL);
  const unavailable = imageModelSelection(models, "saved-but-missing");assert.equal(unavailable.selected_model, "saved-but-missing");assert.equal(unavailable.selected_available, false);
});

test("source and Codex WebUI plans expose image models without adding conversation routes or defaults", async t => {
  const f = fixture(t), state = f.runtime.connections(), codex = state.clients.find(c => c.id === "codex");
  assert.deepEqual(codex.model_plan.image.models.map(m => m.id), ["render-one", "render-two"]);
  assert.ok(codex.model_plan.available.every(m => m.id === chat.id));
  const catalog = await f.runtime.dashboardCatalog({ provider: "github" });
  const listed = catalog.models.filter(m => m.kind === "image");assert.equal(listed.length, 2);
  assert.ok(listed.every(m => m.selectable && m.state !== "hidden" && m.clients.includes("codex")));
  assert.ok(listed.every(m => !m.client_visibility.some(v => v.client === "codex" && ["source_restricted", "protocol_unsupported"].includes(v.reason))));
  const response = await invokeAdapter({ providerRuntime: f.runtime, dashboardOptions: { home: f.home, env: f.env } }, { method: "GET", url: "/_ccdx/ui/models/live?provider=github", headers: { host: "127.0.0.1:2026", "x-ccdx-dashboard": "1" } });
  assert.equal(response.status, 200, response.text);
  const images = JSON.parse(response.text).models.filter(m => m.kind === "image");assert.equal(images.length, 2);
  assert.ok(images.every(m => m.endpoints.includes("images") && m.display_name));

});

test("image selection persists, appears in sync plans and leaves conversation binding and history isolation unchanged", async t => {
  const f = fixture(t), before = f.runtime.connections().clients.find(c => c.id === "codex"), control = createServiceControl({ home: f.home, env: f.env, providerRuntime: f.runtime });
  await control.action({ action: "image", operation: "select", model: "render-two" });
  const after = f.runtime.connections().clients.find(c => c.id === "codex");
  assert.equal(readAccessSettings(f).clients.codex.image_model, "render-two");
  for (const key of ["source", "model", "default_model", "deployments", "history_isolation", "auto_review_model"]) assert.deepEqual(after[key], before[key], key);
  assert.equal(after.model_plan.image.selected_model, "render-two");assert.equal(control.snapshot().features.image.selected_model, "render-two");
  assert.ok(f.syncs.length > 0);assert.ok(f.syncs.every(input => !["render-one", "render-two"].includes(input.model) && input.nativeModels?.every(m => m.id === chat.id)));
  await assert.rejects(control.action({ action: "image", operation: "select", model: "missing" }));assert.equal(readAccessSettings(f).clients.codex.image_model, "render-two");
  f.registry.models = { data: [chat, image("render-one")] };
  assert.equal(f.runtime.imageModels().selected_model, "render-two");assert.equal(f.runtime.imageModels().selected_available, false);
});

test("native alias uses the saved advertised image selection, and stale selections fail before dispatch", async t => {
  const f = fixture(t);updateAccessSettings(s => { s.clients.codex.image_model = "render-two";return s; }, f);
  const calls = [];
  const options = { env: f.env, dashboardOptions: { home: f.home }, imageModels: () => imageModelCatalog(f.registry.models), imagesEnabled: () => true,
    codexClient: { images: async (_op, body) => { calls.push(body);return new Response(JSON.stringify({ error: { message: "fixture quota" } }), { status: 429 }); } } };
  const body = { model: "gpt-image-2", prompt: "A circle" };
  assert.equal((await invokeAdapter(options, { url: "/v1/images/generations", body })).status, 429);assert.equal(calls[0].model, "render-two");
  f.registry.models = { data: [chat, image("render-one")] };
  assert.equal((await invokeAdapter(options, { url: "/v1/images/generations", body })).status, 503);assert.equal(calls.length, 1);
});

test("image selection schema rejects invalid IDs and non-Codex image fields", () => {
  for (const value of ["", null, 1, [], "bad\nmodel"]) {
    const settings = defaultAccessSettings();settings.clients.codex.image_model = value;
    assert.throws(() => checkedAccessSettings(settings));
  }
  const settings = defaultAccessSettings();settings.clients.claude_app.image_model = "render-one";
  assert.throws(() => checkedAccessSettings(settings));
});
