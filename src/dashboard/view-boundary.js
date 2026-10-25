(() => {
  // One optional view owns its failure and retry; the shell and other views keep running.
  function create(rootId, factory, methods) {
    let view, failure, notice;
    const wrappers = new Map(), pending = new Map();
    function failed() {
      if (notice) return;
      const root = document.getElementById(rootId);if (!root) return;
      notice = document.createElement('div');notice.className = 'view-error';notice.setAttribute('role', 'alert');
      const message = document.createElement('span'), retry = document.createElement('button');retry.type = 'button';
      globalThis.ccdxLanguage.set(message, 'view_unavailable');globalThis.ccdxLanguage.set(retry, 'view_retry');
      retry.addEventListener('click', () => {
        failure = false;notice.remove();notice = null;
        if (!initialize()) return;
        const calls = [...pending];pending.clear();
        for (const [name, args] of calls) invoke(name, args);
      });
      notice.append(message, retry);root.append(notice);
    }
    function initialize() {
      if (view) return true;
      try { view = factory();return true; } catch { failure = true;failed();return false; }
    }
    function invoke(name, args) {
      if (failure && !['stop', 'stopMotion'].includes(name)) { pending.set(name, args);return; }
      if (!initialize()) { pending.set(name, args);return; }
      const fail = () => { pending.set(name, args);failure = true;failed(); };
      try {
        const value = view[name](...args);
        return value?.then ? value.catch(fail) : value;
      } catch { fail(); }
    }
    initialize();
    return new Proxy({}, { get(_target, name) {
      if (!methods.includes(name)) return view?.[name];
      if (!wrappers.has(name)) wrappers.set(name, (...args) => invoke(name, args));
      return wrappers.get(name);
    } });
  }
  globalThis.ccdxViewBoundary = { create };
})();
