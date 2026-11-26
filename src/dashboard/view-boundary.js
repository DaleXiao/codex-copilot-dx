(() => {
  const entry = globalThis.document?.currentScript?.src;
  const scripts = new Map();
  function load(name) {
    if (scripts.has(name)) return scripts.get(name);
    const asset = new URL(entry);
    asset.pathname = `/${name}.js`;
    const pending = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = asset.href;
      script.addEventListener('load', resolve, { once: true });
      script.addEventListener('error', () => { script.remove();reject(new Error('Page script unavailable')); }, { once: true });
      document.head.append(script);
    }).catch(error => { scripts.delete(name);throw error; });
    scripts.set(name, pending);
    return pending;
  }

  // One optional view owns its failure and retry; the shell and other views keep running.
  function create(rootId, factory, methods, asset) {
    let view, failure, notice;
    const lazy = Boolean(asset);
    const wrappers = new Map(), pending = new Map();
    const fetchView = () => entry ? load(asset) : Promise.resolve();
    function flush() {
      const calls = [...pending];pending.clear();
      for (const [name, args] of calls) invoke(name, args);
    }
    function failed() {
      if (notice) return;
      const root = document.getElementById(rootId);if (!root) return;
      notice = document.createElement('div');notice.className = 'view-error';notice.setAttribute('role', 'alert');
      const message = document.createElement('span'), retry = document.createElement('button');retry.type = 'button';
      globalThis.ccdxLanguage.set(message, 'view_unavailable');globalThis.ccdxLanguage.set(retry, 'view_retry');
      retry.addEventListener('click', async () => {
        failure = false;notice.remove();notice = null;
        if (lazy) try { await fetchView(); } catch { failure = true;failed();return; }
        if (!initialize()) return;
        flush();
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
    if (!lazy) initialize();
    return new Proxy({}, { get(_target, name) {
      if (asset && name === 'loadView') return () => fetchView().then(() => {
        if (!initialize()) return false;
        if (!failure) flush();
        return true;
      }).catch(() => { failure = true;failed();return false; });
      if (!methods.includes(name)) return view?.[name];
      if (!wrappers.has(name)) wrappers.set(name, (...args) => {
        if (lazy && !view && !failure) { pending.set(name, args);return; }
        return invoke(name, args);
      });
      return wrappers.get(name);
    } });
  }
  globalThis.ccdxViewBoundary = { create, load };
})();
