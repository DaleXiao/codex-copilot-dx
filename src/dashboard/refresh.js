(() => {
  const interval = 30 * 60 * 1000;
  const freshness = 30 * 1000;

  function createController({ resources, visible, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
    const states = new Map(Object.keys(resources).map(key => [key, {
      value: undefined, signature: undefined, variant: undefined, pending: null,
      updatedAt: null, attemptedAt: null, error: null, generation: 0, abort: null,
    }]));
    let timer = null;
    let active = true;
    let automatic = true;
    const state = key => states.get(key);
    const stopTimer = () => { if (timer !== null) clearTimer(timer); timer = null; };
    const notify = key => resources[key].state?.(state(key));

    function schedule() {
      stopTimer();
      if (!active || !automatic || !visible()) return;
      timer = setTimer(() => {
        timer = null;
        refreshVisible();
        schedule();
      }, interval);
    }

    async function refresh(key, { force = false } = {}) {
      if (!active) return;
      const resource = resources[key];
      const entry = state(key);
      const variant = resource.variant?.() || "";
      if (entry.pending) {
        const pending = entry.pending;
        const generation = entry.generation;
        if (entry.pendingVariant === variant) return pending;
        await pending;
        if (!active || generation !== entry.generation) return entry.pending;
        return refresh(key, { force: true });
      }
      if (!force && entry.attemptVariant === variant && entry.attemptedAt !== null && now() - entry.attemptedAt < freshness) return entry.value;
      const generation = ++entry.generation;
      const abort = new AbortController();
      entry.abort = abort;
      entry.attemptedAt = now();
      entry.attemptVariant = variant;
      entry.pendingVariant = variant;
      entry.error = null;
      entry.pending = Promise.resolve().then(async () => {
        try {
          const value = await resource.load({ variant, signal: abort.signal });
          if (!active || generation !== entry.generation) return;
          const signature = JSON.stringify(resource.project ? resource.project(value) : value);
          const changed = signature !== entry.signature;
          resource.apply(value, { changed });
          entry.value = value;
          entry.signature = signature;
          entry.variant = variant;
          entry.updatedAt = now();
          return value;
        } catch (error) {
          if (active && generation === entry.generation) entry.error = error;
        } finally {
          if (generation === entry.generation) {
            entry.pending = null;
            entry.abort = null;
            notify(key);
          }
        }
      });
      notify(key);
      return entry.pending;
    }

    function refreshVisible({ force = false } = {}) {
      if (!active || !visible()) return Promise.resolve([]);
      return Promise.all(Object.keys(resources).filter(key => resources[key].visible())
        .filter(key => force || state(key).attemptedAt === null || now() - state(key).attemptedAt >= interval)
        .map(key => refresh(key, { force })));
    }

    function invalidate(key) {
      const entry = state(key);
      entry.generation += 1;
      entry.abort?.abort();
      entry.pending = null;
      entry.abort = null;
      entry.attemptedAt = null;
      entry.variant = undefined;
      notify(key);
    }

    return {
      refresh, refreshVisible, state, invalidate,
      setAutomatic(value) { automatic = value === true; if (automatic) refreshVisible(); schedule(); },
      visibilityChanged() { if (automatic && visible()) refreshVisible(); schedule(); },
      resume() { active = true; if (automatic) refreshVisible(); schedule(); },
      suspend() { active = false; stopTimer(); for (const key of states.keys()) if (state(key).pending) invalidate(key); },
      get automatic() { return automatic; },
    };
  }

  globalThis.ccdxRefresh = { createController };
})();
