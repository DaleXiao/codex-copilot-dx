(() => {
  const routeNeedsEditor = () => ["#models", "#codex", "#claude"].includes(location.hash);
  const asset = new URL(document.currentScript.src);
  asset.pathname = "/connections.js";
  let pending, latestMemory;
  const bootstrap = {
    load() {
      if (!routeNeedsEditor() || pending) return pending;
      pending = new Promise(resolve => {
        const script = document.createElement("script");
        script.src = asset.href;
        script.addEventListener("load", () => {
          const feature = globalThis.ccdxConnections;
          if (feature === bootstrap) {
            pending = null;
            script.remove();
            resolve();
            return;
          }
          Promise.resolve(feature.ready).then(() => feature.updateMemory(latestMemory)).finally(resolve);
        }, { once: true });
        script.addEventListener("error", () => {
          pending = null;
          script.remove();
          resolve();
        }, { once: true });
        document.head.append(script);
      });
      return pending;
    },
    updateMemory(snapshot) { latestMemory = snapshot; },
  };
  globalThis.ccdxConnections = bootstrap;
  window.addEventListener("hashchange", () => { if (globalThis.ccdxConnections === bootstrap) void bootstrap.load(); });
  void bootstrap.load();
})();
