import path from 'node:path';
import { createHash } from 'node:crypto';
import { serialize } from 'node:v8';
import { codexPaths } from './codex-paths.mjs';
import { claudeClientPaths } from './claude-client-config.mjs';
import { accessSettingsPath } from './access-settings.mjs';
import { userSettingsPath } from './user-settings.mjs';
import { readBoundedFileSync } from './bounded-file.mjs';
import { authProfilePaths, readAuthProfileCredentials } from './auth-profile.mjs';
import { m365Paths } from './m365-settings.mjs';

export const HANDOFF_MAX_BYTES = 64 * 1024 * 1024;
export function clientStateFingerprint(options = {}) {
  const codex = codexPaths(options), connections = accessSettingsPath(options);
  const github = authProfilePaths('codex', options);
  const files = [codex.config, path.join(codex.directory, 'auth.json'), connections, userSettingsPath(options),
    github.tokenPath, m365Paths(options).settings, m365Paths(options).gateway,
    path.join(path.dirname(connections), 'client-gateway-keys.json'), path.join(path.dirname(connections), 'codex-gateway-owner.json'), ...Object.values(claudeClientPaths(options))];
  const hash = createHash('sha256');
  const credentials = readAuthProfileCredentials('codex', options);
  hash.update(JSON.stringify([credentials.valid, credentials.identity?.id ?? null, credentials.identity?.login ?? null]));
  for (const file of files) {
    hash.update(file);try { hash.update(readBoundedFileSync(file, { maxBytes: 8 * 1024 * 1024 })); }
    catch (error) { if (error.code !== 'ENOENT') throw error;hash.update('missing'); }
  }
  return hash.digest('hex');
}
export function serviceBusinessState(runtime) {
  const graph = runtime.connections();
  return graph.clients.map(client => ({ id: client.id, enabled: client.enabled, source: client.source, default_model: client.default_model ?? client.model ?? null,
    scopes: runtime.privateScopes?.(client.id) || [],
    models: client.model_plan?.models.map(model => [model.source, model.public_id]).sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) || [],
    default_unavailable: client.model_plan?.default_unavailable === true }));
}

export async function createServiceWorker({ processObj = process } = {}) {
  let preserving = false, draining = false, warming = false, handlers, stopRequested = false, updateStatus = { phase: 'watching' };
  const boot = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { processObj.off('message', receive);reject(new Error('Supervisor initialization timed out')); }, 15000);
    function receive(message) {
      if (message?.type !== 'ccdx:init' || message.protocol !== 1) return;
      clearTimeout(timer);processObj.off('message', receive);resolve(message);
    }
    processObj.on('message', receive);processObj.send({ type: 'ccdx:boot', protocol: 1 });
  });
  preserving = boot.preserve === true;
  warming = boot.warm === true;
  draining = preserving;
  const stop = () => { stopRequested = true;void handlers?.stop(); };
  processObj.once('disconnect', stop);
  processObj.on('message', async message => {
    if (message?.type === 'ccdx:stop') { stop();return; }
    if (!message || !handlers) return;
    if (message.type === 'ccdx:notice' && /^[a-z_]{1,64}$/.test(message.code || '')) { handlers.notice?.(message.code);return; }
    if (message.type === 'ccdx:update-status') { updateStatus = message.value;return; }
    if (message.type !== 'ccdx:call' || !Number.isSafeInteger(message.id)) return;
    try {
      let value;
      if (message.action === 'inspect') value = handlers.inspect();
      else if (message.action === 'commit') { value = handlers.inspect();await handlers.activate?.();preserving = false;draining = false; }
      else if (message.action === 'resume') { await handlers.resume?.();draining = false;value = handlers.inspect(); }
      else if (message.action === 'release') { if (!draining) throw new Error('service_busy');await handlers.release();value = handlers.inspect(); }
      else if (message.action === 'import') { if (!warming) throw new Error('service_busy');await handlers.importState(message.value);value = handlers.inspect(); }
      else if (message.action === 'promote') { if (!warming) throw new Error('service_busy');await handlers.promote();warming = false;value = handlers.inspect(); }
      else if (message.action === 'quiesce') {
        if (handlers.inspect().busy) throw new Error('service_busy');
        draining = true;
        const state = await handlers.exportState();
        if (state.history.bytes + state.optional.bytes + (state.providers?.bytes || 0) > HANDOFF_MAX_BYTES || serialize(state).byteLength > HANDOFF_MAX_BYTES) { draining = false;throw new Error('state_too_large'); }
        value = { ...handlers.inspect(), state };
      } else throw new Error('unknown_action');
      processObj.send({ type: 'ccdx:reply', id: message.id, value });
    } catch (error) {
      const code = ['service_busy', 'state_too_large', 'unknown_action'].includes(error.message) ? error.message : 'handoff_unavailable';
      processObj.send({ type: 'ccdx:reply', id: message.id, error: code });
    }
  });
  return {
    get preserving() { return preserving; }, get draining() { return draining; }, get warming() { return warming; },
    get needsGithub() { return warming && Array.isArray(boot.sources) && boot.sources.includes('github'); },
    takeState() { const state = boot.state;boot.state = undefined;return state; },
    status: () => updateStatus,
    preferenceChanged(enabled) { if (processObj.connected !== false) processObj.send({ type: 'ccdx:preference', enabled }, () => {}); },
    reused() { processObj.send({ type: 'ccdx:ready', protocol: 1, value: { reused: true } }); },
    async ready(value) { handlers = value;if (stopRequested) { await handlers.stop();return; }processObj.send({ type: 'ccdx:ready', protocol: 1, value: handlers.inspect() }); },
  };
}
