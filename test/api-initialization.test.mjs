import test from 'node:test';
import assert from 'node:assert/strict';
import { createApiSecretStore } from '../src/api-secrets.mjs';
import { createApiProvider } from '../src/providers/api.mjs';
const turn = () => new Promise(resolve => setImmediate(resolve));
const ref = 'a'.repeat(32);

test('cold credential reads join; clearing or replacing a key prevents late cache publication', async () => {
  let resolveRead, calls = 0;
  const store = createApiSecretStore({ platform: 'darwin', env: {}, run: async (_command, args) => {
    if (args[0] === '-i') return '';
    if (++calls === 1) return new Promise(resolve => { resolveRead = resolve; });
    return 'new-synthetic-key';
  } });
  const reads = Array.from({ length: 8 }, () => store.get(ref));await turn();assert.equal(calls, 1);
  await store.set(ref, 'new-synthetic-key');resolveRead('old-synthetic-key');
  assert.deepEqual(await Promise.all(reads), Array(8).fill('old-synthetic-key'));
  assert.equal(await store.get(ref), 'new-synthetic-key');assert.equal(calls, 2);
  store.close();assert.equal(await store.get(ref), 'new-synthetic-key');assert.equal(calls, 3);store.close();
});

test('credential read failures are shared but never cached', async () => {
  let calls = 0;
  const store = createApiSecretStore({ platform: 'darwin', env: {}, run: async () => { calls++;throw Error('synthetic failure'); } });
  assert.ok((await Promise.allSettled(Array.from({ length: 8 }, () => store.get(ref)))).every(value => value.status === 'rejected'));
  assert.equal(calls, 1);await assert.rejects(store.get(ref));assert.equal(calls, 2);store.close();
});

function provider(factory, secrets = { get: async () => 'synthetic-key' }) {
 return createApiProvider({ config: { id: 'api_probe', name: 'Probe', enabled: true, base_url: 'https://example.test/v1', endpoints: { messages: 'https://example.test/v1/messages' }, secret_ref: ref, auth_header: 'bearer', models: [{ id: 'claude-probe', protocols: ['messages'] }] }, env: {}, platform: 'linux', secrets, networkFactory: factory });
}
const body = { model: 'claude-probe', max_tokens: 1, messages: [{ role: 'user', content: 'synthetic' }] };
test('cancelling one network-setup waiter leaves another caller and its transport alive', async () => {
 let release, builds = 0, shared, closes = 0;
 const p = provider(async ({ signal }) => { builds++;shared = signal;return new Promise((resolve, reject) => {
  release = () => resolve({ healthy: () => true, close() { closes++; }, fetch: async () => Response.json({ ok: true }) });
  signal.addEventListener('abort', () => reject(signal.reason), { once: true });
 }); });
 const a = new AbortController(), b = new AbortController();
 const first = p.client.messages(body, { signal: a.signal }), second = p.client.messages(body, { signal: b.signal });
 await turn();assert.equal(builds, 1);const cancelled = assert.rejects(first, { name: 'AbortError' });a.abort();await cancelled;
 assert.equal(shared.aborted, false);release();assert.equal((await second).status, 200);assert.equal(closes, 0);p.close();assert.equal(closes, 1);
});
test('all setup waiters cancelling aborts their shared operation; a later caller can retry', async () => {
 let builds = 0, signals = [];
 const p = provider(async ({ signal }) => { builds++;signals.push(signal);if (builds > 1) return { close() {}, fetch: async () => Response.json({ ok: true }) };
  return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
 });
 const a = new AbortController(), call = p.client.messages(body, { signal: a.signal });await turn();const cancelled = assert.rejects(call, { name: 'AbortError' });a.abort();await cancelled;
 assert.equal(signals[0].aborted, true);assert.equal((await p.client.messages(body)).status, 200);assert.equal(builds, 2);p.close();
});

test('a cancelled credential waiter finishes promptly without cancelling another caller or forwarding late', async t => {
 let release, reads = 0, sends = 0, builds = 0;
 const credential = new Promise(resolve => { release = resolve; });
 const p = provider(async () => { builds++;return { close() {}, fetch: async () => { sends++;return Response.json({ ok: true }); } }; },
  { get: () => { reads++;return credential; } });
 t.after(() => { release('synthetic-key');p.close(); });
 const controller = new AbortController();let error;
 const first = p.client.messages(body, { signal: controller.signal }).catch(value => { error = value; });
 const second = p.client.messages(body);await turn();controller.abort();await turn();
 assert.equal(error?.name, 'AbortError');assert.equal(builds, 0);assert.equal(sends, 0);
 release('synthetic-key');await first;assert.equal((await second).status, 200);assert.equal(sends, 1);assert.equal(reads, 1);
});
