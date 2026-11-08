export function createSourceLifecycle({ legacy, secrets, log }) {
  const active = new Map(), retired = new Set(), sourceSecrets = new WeakMap(), retiredSecrets = new Map(), cleanups = new Set();

  function cleanSecrets(id) {
    const refs = retiredSecrets.get(id);
    if (!refs) return;
    for (const ref of refs) {
      if ([...active.keys()].some(source => sourceSecrets.get(source) === ref)) continue;
      refs.delete(ref);
      const task = secrets
        .remove(ref)
        .catch(() => {
          log("warn", "Previous API credential cleanup needs review");
        })
        .finally(() => cleanups.delete(task));
      cleanups.add(task);
    }
    if (!refs.size) retiredSecrets.delete(id);
  }

  function retire(source) {
    if (active.get(source)) retired.add(source);
    else source.close();
  }

  function track(source) {
    const finishLegacy = legacy.track(source);
    active.set(source, (active.get(source) || 0) + 1);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      finishLegacy?.();
      const count = (active.get(source) || 1) - 1;
      if (count) active.set(source, count);
      else {
        active.delete(source);
        if (retired.delete(source)) source.close();
        cleanSecrets(source.id);
      }
    };
  }

  return {
    track,
    retire,
    rememberSource: (source, ref) => sourceSecrets.set(source, ref),
    retireSecret(id, ref) {
      if (!retiredSecrets.has(id)) retiredSecrets.set(id, new Set());
      retiredSecrets.get(id).add(ref);
      cleanSecrets(id);
    },
    busy: () => active.size > 0,
    close() {
      for (const source of retired) source.close();
      active.clear();
      for (const id of retiredSecrets.keys()) cleanSecrets(id);
      return Promise.allSettled([...cleanups]);
    },
  };
}
