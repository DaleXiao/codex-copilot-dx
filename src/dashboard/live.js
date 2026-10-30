(() => {
  function create({ visible, apply, state, tick = () => {}, eventSource = url => new EventSource(url), setTimer = setTimeout, clearTimer = clearTimeout }) {
    let source = null, automatic = true, suspended = false, expiry = null, clock = null, last = null;
    function stop() {
      const previous = source;source = null;previous?.close();
      clearTimer(expiry);clearTimer(clock);expiry = null;clock = null;last = null;
    }
    function animate() {
      clearTimer(clock);clock = null;
      if (!source || !last?.model_activity.active || !visible()) return;
      clock = setTimer(() => { tick();animate(); }, 1000);
    }
    function alive() {
      clearTimer(expiry);
      expiry = setTimer(() => { stop();state("connecting");sync(); }, 45000);
    }
    function sync() {
      if (!automatic || suspended || !visible()) { stop();state("paused");return; }
      if (source) return;
      state("connecting");
      try {
        const current = source = eventSource("/_ccdx/activity");
        current.addEventListener("activity", event => {
          if (current !== source) return;
          try {
            const value = JSON.parse(event.data), active = value.model_activity?.active;
            if (value.scope !== "activity" || value.ok !== true || value.name !== "codex-copilot-dx"
              || !Number.isSafeInteger(active) || active < 0 || !Array.isArray(value.stream_performance?.active_requests)) throw Error("Invalid activity snapshot");
            last = value;alive();apply(value);state("live");animate();
          } catch { last = null;clearTimer(clock);clock = null;state("connecting"); }
        });
        current.addEventListener("heartbeat", () => { if (current === source && last) { alive();state("live"); } });
        current.onerror = () => {
          if (current !== source) return;
          clearTimer(clock);clock = null;last = null;state("connecting");
          if (current.readyState === 2) {
            clearTimer(expiry);expiry = setTimer(() => { stop();sync(); }, 5000);
          }
        };
        alive();
      } catch { source = null;state("unavailable"); }
    }
    return {
      sync,
      setAutomatic(value) { automatic = value === true;sync(); },
      suspend() { suspended = true;sync(); },
      resume() { suspended = false;sync(); },
      get current() { return last; },
    };
  }
  globalThis.ccdxLive = { create };
})();
