(() => {
  const entry = document.currentScript.src;
  function load(name) {
    const url = new URL(entry);
    url.pathname = `/${name}.js`;
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.setAttribute("src", url.pathname + url.search);
      script.addEventListener("load", resolve, { once: true });
      script.addEventListener("error", () => { script.remove();reject(new Error("Dashboard script unavailable")); }, { once: true });
      document.head.append(script);
    });
  }
  let chinese = false;
  try { chinese = localStorage.getItem("ccdx.dashboard.language") === "zh"; } catch {}
  globalThis.ccdxLoadDashboardLanguage = () => load("language");
  void load(chinese ? "language" : "language-en").then(() => load("dashboard")).catch(() => {
    const note = document.getElementById("connection");
    note.textContent = chinese ? "页面加载失败，请刷新。" : "Could not load the dashboard. Reload this page.";
    note.className = "badge bad";
  });
})();
