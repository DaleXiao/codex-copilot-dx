import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { readUserSettings, userSettingsPath } from "./user-settings.mjs";
import { withFileLockSync } from "./lock.mjs";
import { atomicWriteFileIfChangedSync } from "./atomic-file.mjs";
import { createChangeSignal } from "./activity-events.mjs";
import { createPrivacyModel, privacyFailure } from "./privacy-model.mjs";
import { maskPrivacyRequest, protectPrivacyResponse } from "./privacy-transform.mjs";
import { markRequestObservation } from "./stream-performance.mjs";

export function createLocalPrivacy(options = {}) {
  const changes = createChangeSignal(), secret = randomBytes(32), cache = new Map(), flights = new Map(), responses = new WeakMap(), policies = new WeakMap();
  const model = options.model || createPrivacyModel({ ...options, changed: changes.changed });
  let cacheBytes = 0, generation = 0, pending = null, disposed = false;
  let keyLoaded = false, actionError = null;
  const settings = () => {
    const saved = readUserSettings({ ...options, strict: true });
    return { enabled: saved.privacy_enabled === true, personal: saved.privacy_personal === true };
  };
  const revision = saved => createHash("sha256").update(JSON.stringify(saved)).digest("hex");
  const snapshot = () => { const saved = settings();return { ...model.snapshot(), ...saved, ...(actionError ? { error: actionError } : {}), revision: revision(saved), action_pending: Boolean(pending), scope: "conversation_text" }; };
  function loadKey() {
    if (keyLoaded) return;
    const file = path.join(path.dirname(userSettingsPath(options)), "privacy-key");fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    withFileLockSync(file + ".lock", () => {
      try { const bytes = fs.readFileSync(file);if (bytes.length !== 32) throw privacyFailure("key_invalid");bytes.copy(secret); }
      catch (error) { if (error.code !== "ENOENT") throw error;fs.writeFileSync(file, secret, { mode: 0o600, flag: "wx" }); }
    });keyLoaded = true;
  }
  function save(values, expected) {
    const file = userSettingsPath(options);fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    withFileLockSync(file + ".lock", () => {
      const saved = readUserSettings({ ...options, strict: true });
      if (expected && revision(settings()) !== expected) throw privacyFailure("settings_changed");
      atomicWriteFileIfChangedSync(file, JSON.stringify({ ...saved, ...values }, null, 2) + "\n", { mode: 0o600 });
    });changes.changed();
  }
  async function find(texts, { signal } = {}) {
    const waiting = [], fresh = [], entries = [];
    for (const text of texts) {
      const key = createHash("sha256").update(text).digest("hex");
      if (cache.has(key)) {
        const saved = cache.get(key);cache.delete(key);cache.set(key, saved);waiting.push(Promise.resolve(saved.found));
      } else if (flights.has(key)) waiting.push(flights.get(key).promise);
      else {
        const entry = Promise.withResolvers();entry.key = key;flights.set(key, entry);
        waiting.push(entry.promise);fresh.push(text);entries.push(entry);
      }
    }
    if (fresh.length) void model.find(fresh).then(found => {
      if (!Array.isArray(found) || found.length !== fresh.length) throw privacyFailure("engine_invalid");
      for (let i = 0; i < found.length; i++) {
        const cost = Buffer.byteLength(JSON.stringify(found[i] || [])) + 128, entry = entries[i];
        if (cost <= 1024 * 1024) {
          const previous = cache.get(entry.key);if (previous) cacheBytes -= previous.bytes;
          cache.set(entry.key, { found: found[i] || [], bytes: cost });cacheBytes += cost;
          while (cache.size > 5000 || cacheBytes > 4 * 1024 * 1024) { const oldest = cache.keys().next().value;cacheBytes -= cache.get(oldest).bytes;cache.delete(oldest); }
        }
        entry.resolve(found[i] || []);
      }
    }).catch(error => entries.forEach(entry => entry.reject(error))).finally(() => entries.forEach(entry => { if (flights.get(entry.key) === entry) flights.delete(entry.key); }));
    let listener;
    const aborted = new Promise((_, reject) => { listener = () => reject(signal.reason);if (signal?.aborted) listener();else signal?.addEventListener("abort", listener, { once: true }); });
    try { return await (signal ? Promise.race([Promise.all(waiting), aborted]) : Promise.all(waiting)); }
    finally { signal?.removeEventListener("abort", listener); }
  }
  async function prepare(body, { protocol, client, signal, res, policy } = {}) {
    const saved = policy || settings();if (!saved.enabled) return body;
    if (disposed) throw privacyFailure("engine_unavailable");
    loadKey();
    const start = performance.now();
    const deadline = AbortSignal.timeout(15000);let session;
    try { session = await maskPrivacyRequest(body, { protocol, client, personal: saved.personal, secret, find, signal: signal ? AbortSignal.any([signal, deadline]) : deadline }); }
    catch (error) { if (deadline.aborted && !signal?.aborted) throw privacyFailure("check_timeout");throw error; }
    if (signal?.aborted) { session.release();throw signal.reason; }
    markRequestObservation({ privacy_count: session.count, privacy_ms: Math.round(performance.now() - start), privacy_state: "checked" });
    if (res && session.count) {
      let current = responses.get(res);
      if (!current) {
        const sessions = [];
        current = { count: session.count, sessions,
          restoreText: value => sessions.reduce((text, item) => item.restoreText(text), value),
          restoreValue: value => sessions.reduce((text, item) => item.restoreValue(text), value),
          release: () => { sessions.forEach(item => item.release());sessions.length = 0;responses.delete(res); } };
        responses.set(res, current);sessions.push(session);protectPrivacyResponse(res, current);
      } else current.sessions.push(session);
    }
    return session.body;
  }
  async function action(input) {
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !["action", "revision", "personal", "text"].includes(key))) throw privacyFailure("action_invalid");
    if (input.action === "try") {
      if (typeof input.text !== "string" || Buffer.byteLength(input.text) > 8192 || model.snapshot().state !== "ready") throw privacyFailure("preview_unavailable");
      const start = performance.now(), session = await maskPrivacyRequest({ input: input.text }, { protocol: "responses", client: "preview", personal: settings().personal, secret, find });
      const output = { text: session.body.input, count: session.count, elapsed_ms: Math.round(performance.now() - start) };session.release();return output;
    }
    const before = settings();if (input.revision !== revision(before)) throw privacyFailure("settings_changed");
    if (input.action === "personal") {
      if (typeof input.personal !== "boolean") throw privacyFailure("action_invalid");save({ privacy_personal: input.personal }, input.revision);
    } else if (input.action === "disable" || input.action === "remove") {
      generation++;actionError = null;save({ privacy_enabled: false }, input.revision);model.stop();
      if (input.action === "remove") await model.remove();
    } else if (input.action === "enable") {
      if (pending) return snapshot();
      const current = ++generation;
      const work = (async () => {
        actionError = null;loadKey();
        if (!await model.installed()) await model.download();
        if (current !== generation) return;
        await model.load();if (current !== generation) return;
        save({ privacy_enabled: true }, input.revision);
      })();pending = work;
      void work.catch(error => { if (current === generation) actionError = /^ccdx_privacy_[a-z_]+$/.test(error.code || "") ? error.code : "ccdx_privacy_unavailable"; }).finally(() => { if (pending === work) pending = null;changes.changed(); });
    } else throw privacyFailure("action_invalid");
    changes.changed();return snapshot();
  }
  function warm() { const current = generation;if (settings().enabled) void model.load().catch(error => { if (current !== generation || !settings().enabled) return;actionError = /^ccdx_privacy_[a-z_]+$/.test(error.code || "") ? error.code : "ccdx_privacy_unavailable";changes.changed(); }); }
  try { warm(); } catch { /* Invalid preferences remain visible and are never rewritten. */ }
  return { snapshot, action, prepare, subscribe: changes.subscribe, busy: () => Boolean(pending || flights.size || model.busy()),
    wrap(fn, context) {
      if (!fn) return fn;
      const policy = context.res && policies.get(context.res) || settings();if (context.res) policies.set(context.res, policy);
      if (!policy.enabled) return fn;
      return async (body, options = {}) => {
        const masked = await prepare(body, { ...context, policy, signal: options.signal });
        if (options.signal?.aborted) throw options.signal.reason;
        if (!settings().enabled) model.stop();
        return fn(masked, masked === body ? options : { ...options, bodyText: undefined });
      };
    },
    restoreResponse: (res, value) => responses.get(res)?.restoreValue(value) || value,
    settingsChanged() { actionError = null;if (!settings().enabled) { generation++;model.stop(); }else warm();changes.changed(); },
    close() { disposed = true;generation++;model.close();cache.clear();cacheBytes = 0;secret.fill(0); } };
}
