import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'smol-toml';
import { ensureCodexConfig } from "../src/config.mjs";
import { configureCodexApi } from '../src/codex-api-config.mjs';
import { accessSettingsPath } from '../src/access-settings.mjs';

function fixture(t, before = '') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccdx-native-config-')), env = {};
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const directory = path.join(home, '.codex'), file = path.join(directory, 'config.toml');fs.mkdirSync(directory);fs.writeFileSync(file, before);
  const journal = path.join(path.dirname(accessSettingsPath({ home, env })), 'codex-gateway-owner.json');
  const options = { home, env, native: true, baseUrl: 'http://127.0.0.1:2026/v1', model: 'gpt-replay' };
  return { options, file, journal, read: () => parse(fs.readFileSync(file, 'utf8')) };
}

test('native takeover owns the base URL, retains OpenAI identity and restores exact root declarations', t => {
  const before = '# unchanged\n"model" = "original"\nopenai_base_url = "https://previous.test/v1" # restore this\n[features]\ncontext_management = true\n';
  const f = fixture(t, before);
  assert.equal(configureCodexApi(f.options).state, 'configured');
  assert.equal(f.read().model_provider, undefined);assert.equal(f.read().model_providers, undefined);
  assert.equal(f.read().openai_base_url, f.options.baseUrl);assert.equal(f.read().model, 'gpt-replay');
  const owner = JSON.parse(fs.readFileSync(f.journal));assert.equal(owner.mode, 'openai');assert.match(owner.beforeBase, /previous.test/);
  assert.equal(configureCodexApi(f.options).changed, false);
  configureCodexApi({ ...f.options, restore: true });assert.equal(fs.readFileSync(f.file, 'utf8'), before);assert.equal(fs.existsSync(f.journal), false);
});

test('v1 gateways and the temporary manual OpenAI repair migrate without changing sign-in', t => {
  for (const manual of [false, true]) {
    const f = fixture(t, 'model = "original"\nopenai_base_url = "http://127.0.0.1:2026/v1"\n');
    const auth = path.join(path.dirname(f.file), 'auth.json'), bytes = '{"auth_mode":"chatgpt","tokens":{"access_token":"synthetic-only"}}';fs.writeFileSync(auth, bytes);
    configureCodexApi({ ...f.options, native: false, model: 'ccdx/model-123', apiKey: 'd'.repeat(64) });
    const owner = JSON.parse(fs.readFileSync(f.journal));owner.version = 1;delete owner.mode;fs.writeFileSync(f.journal, JSON.stringify(owner));
    if (manual) fs.writeFileSync(f.file, fs.readFileSync(f.file, 'utf8').replace('model_provider = "ccdx_gateway"\n', ''));
    assert.equal(configureCodexApi(f.options).state, 'configured');assert.equal(f.read().model_provider, undefined);assert.ok(f.read().model_providers?.ccdx_gateway);
    assert.equal(f.read().model, 'gpt-replay');assert.equal(fs.readFileSync(auth, 'utf8'), bytes);
    configureCodexApi({ ...f.options, restore: true });assert.equal(f.read().model, 'original');assert.equal(f.read().openai_base_url, f.options.baseUrl);
  }
});

test('native and private gateways can switch repeatedly and restore the original base URL', t => {
  const f = fixture(t, 'model_provider = "openai"\nmodel = "original"\nopenai_base_url = "https://previous.test/v1"\n');
  configureCodexApi(f.options);
  for (let i = 0; i < 2; i++) {
    configureCodexApi({ ...f.options, native: false, apiKey: 'd'.repeat(64), model: 'private-replay' });assert.equal(f.read().model_provider, 'ccdx_gateway');
    configureCodexApi(f.options);assert.equal(f.read().model_provider, 'openai');assert.ok(f.read().model_providers?.ccdx_gateway);
  }
  configureCodexApi({ ...f.options, restore: true });assert.equal(f.read().openai_base_url, 'https://previous.test/v1');assert.equal(f.read().model, 'original');
});

test('native synchronization preserves a user-edited model and refuses to overwrite a changed base', t => {
  const f = fixture(t);configureCodexApi(f.options);
  fs.writeFileSync(f.file, fs.readFileSync(f.file, 'utf8').replace('model = "gpt-replay"', 'model = "user-choice"'));
  assert.equal(configureCodexApi(f.options).state, 'preserved');assert.equal(f.read().model, 'user-choice');
  const edited = fs.readFileSync(f.file, 'utf8').replace(f.options.baseUrl, 'https://user-choice.test/v1');fs.writeFileSync(f.file, edited);
  assert.equal(configureCodexApi(f.options).state, 'preserved');assert.equal(configureCodexApi({ ...f.options, restore: true }).state, 'preserved');assert.equal(fs.readFileSync(f.file, 'utf8'), edited);
});

test('routing-only repair retains model ownership until restoration', t => {
  const f = fixture(t, 'model = "original"\n');configureCodexApi({ ...f.options, native: false, apiKey: 'd'.repeat(64) });
  configureCodexApi({ ...f.options, model: undefined });assert.equal(f.read().model, 'gpt-replay');assert.equal(f.read().model_provider, undefined);
  configureCodexApi({ ...f.options, restore: true });assert.equal(f.read().model, 'original');
});


test('normal startup defers an owned base URL to reconciliation and preserves user edits', t => {
  const f = fixture(t);configureCodexApi(f.options);
  fs.writeFileSync(f.file, fs.readFileSync(f.file, 'utf8').replace(f.options.baseUrl, 'https://user-edited.test/v1'));
  ensureCodexConfig(2026, { ...f.options, log() {} });assert.equal(f.read().openai_base_url, 'https://user-edited.test/v1');
  assert.equal(configureCodexApi(f.options).state, 'preserved');
});


test('native ID migration backs up only a complete recognized qualified model cache', t => {
  const f = fixture(t), cache = path.join(path.dirname(f.file), 'models_cache.json');
  const models = [{ route_id: 'ccdx/model-123', public_id: 'gpt-replay' }];
  const bytes = JSON.stringify({ client_version: '0.164.0', models: [{ slug: models[0].route_id }] });fs.writeFileSync(cache, bytes);
  configureCodexApi({ ...f.options, nativeModels: models });assert.equal(fs.existsSync(cache), false);assert.equal(fs.readFileSync(cache + '.ccdx-qualified.bak', 'utf8'), bytes);
  if (process.platform !== 'win32') assert.equal(fs.statSync(cache + '.ccdx-qualified.bak').mode & 0o777, 0o600);
  fs.writeFileSync(cache, JSON.stringify({ models: [{ slug: 'unrelated' }] }));const unrelated = fs.readFileSync(cache);
  configureCodexApi({ ...f.options, nativeModels: models });assert.ok(fs.readFileSync(cache).equals(unrelated));
});
