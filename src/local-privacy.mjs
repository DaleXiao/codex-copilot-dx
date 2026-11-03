import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { readUserSettings, userSettingsPath } from "./user-settings.mjs";
import { withFileLockSync } from "./lock.mjs";
import { atomicWriteFileIfChangedSync } from "./atomic-file.mjs";
import { createChangeSignal } from "./activity-events.mjs";
import { createPrivacyModel, privacyFailure } from "./privacy-model.mjs";
import { maskPrivacyRequest, protectPrivacyResponse, createPrivacyRuleCache } from "./privacy-transform.mjs";
import { createPrivacyDetection } from "./privacy-detection.mjs";
import { markRequestObservation } from "./stream-performance.mjs";

export function createLocalPrivacy(options = {}) {
  const changes = createChangeSignal(), secret = randomBytes(32), responses = new WeakMap(), policies = new WeakMap();
  const model = options.model || createPrivacyModel({ ...options, changed: changes.changed });
  const rules = createPrivacyRuleCache();
  const detection = createPrivacyDetection(model, options);
  let generation = 0, pending = null, disposed = false, lastResponse = null;
  let keyLoaded = false, actionError = null, lastCheck = null;
  const settings = () => {
    const saved = readUserSettings({ ...options, strict: true });
    return { enabled: saved.privacy_enabled === true, personal: saved.privacy_personal === true };
  };
  const revision = saved => createHash("sha256").update(JSON.stringify(saved)).digest("hex");
  const snapshot = () => { const saved = settings(), detector = model.snapshot();return { ...detector, ...saved,
    effective_enabled: saved.enabled && detector.state === "ready", last_check: lastCheck && { ...lastCheck,
      ...(lastCheck.continuing ? { continuing: detection.busy() || detector.pending_checks > 0 } : {}) }, last_response: lastResponse && { ...lastResponse }, detection: detection.snapshot(), rule_cache: rules.stats(),
    ...(actionError ? { error: actionError } : {}), revision: revision(saved), action_pending: Boolean(pending), scope: "conversation_text" }; };
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
  const find = (texts, options) => detection.find(texts, options);
  async function prepare(body, { protocol, client, signal, res, policy } = {}) {
    const saved = policy || settings();if (!saved.enabled) return body;
    if (disposed) throw privacyFailure("engine_unavailable");
    loadKey();
    const start = performance.now();
    const deadline = new AbortController();let session, timer, budget = options.checkTimeoutMs ?? 15000;
    const arm = () => {
      clearTimeout(timer);timer = setTimeout(() => deadline.abort(privacyFailure("check_timeout", "waiting")), Math.max(1, budget - (performance.now() - start)));
      timer.unref?.();
    };
    const onPlan = plan => {
      if (options.checkTimeoutMs === undefined && plan.pending_bytes >= 64 * 1024) { budget = 60000;arm(); }
      markRequestObservation({ privacy_pending_bytes: plan.pending_bytes, privacy_new_bytes: plan.new_bytes, privacy_wait_budget_ms: budget });
    };
    arm();
    try { session = await maskPrivacyRequest(body, { protocol, client, personal: saved.personal, secret, find, rules: rules.find, onPlan,
      signal: signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal }); }
    catch (error) {
      const failure = deadline.signal.aborted && !signal?.aborted ? privacyFailure("check_timeout", "waiting") : error;
      const elapsed = Math.round(performance.now() - start), cancelled = signal?.aborted === true;
      lastCheck = { state: cancelled ? "cancelled" : "failed", at: new Date().toISOString(), elapsed_ms: elapsed,
        code: /^ccdx_privacy_[a-z_]+$/.test(failure?.code || "") ? failure.code : cancelled ? "ccdx_privacy_cancelled" : "ccdx_privacy_unavailable", continuing: !cancelled && failure?.retryAfter === 5, wait_budget_ms: budget };
      markRequestObservation({ privacy_ms: elapsed, privacy_state: cancelled ? "cancelled" : "failed" });changes.changed();throw failure;
    } finally { clearTimeout(timer); }
    if (signal?.aborted) { session.release();throw signal.reason; }
    markRequestObservation({ privacy_count: session.count, privacy_ms: Math.round(performance.now() - start), privacy_state: "checked" });
    actionError = null;lastCheck = { state: "checked", at: new Date().toISOString(), elapsed_ms: Math.round(performance.now() - start), count: session.count };changes.changed();
    if (res && session.count) {
      let current = responses.get(res);
      if (!current) {
        const sessions = [];
        current = { count: session.count, sessions,
          restoreText: value => sessions.reduce((text, item) => item.restoreText(text), value),
          restoreValue: value => sessions.reduce((text, item) => item.restoreValue(text), value),
          restoreToolValue: value => sessions.reduce((text, item) => item.restoreToolValue(text), value),
          release: () => { sessions.forEach(item => item.release());sessions.length = 0;responses.delete(res); } };
        responses.set(res, current);sessions.push(session);protectPrivacyResponse(res, current, {
          onFailure(details) { lastResponse = { state: "failed", at: new Date().toISOString(), ...details };changes.changed(); },
          onComplete() { lastResponse = { state: "completed", at: new Date().toISOString() };changes.changed(); },
        });
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
      generation++;actionError = null;save({ privacy_enabled: false }, input.revision);detection.cancelQueued();model.stop();
      if (input.action === "remove") await model.remove();
    } else if (input.action === "enable") {
      if (pending) return snapshot();
      const current = ++generation;
      const work = (async () => {
        actionError = null;loadKey();
        if (!await model.installed({ current: true })) await model.download({ background: model.snapshot().state === "ready" });
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
  return { snapshot, action, prepare, subscribe: changes.subscribe, busy: () => Boolean(pending || detection.busy() || model.busy()),
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
    close() { disposed = true;generation++;detection.close();model.close();rules.clear();secret.fill(0); } };
}
