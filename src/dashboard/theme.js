(() => {
  const key = "ccdx.dashboard.theme";
  let theme = "dark";
  try {
    if (localStorage.getItem(key) === "light") theme = "light";
  } catch { /* Private browsing may disable storage. */ }
  const applyTheme = () => {
    document.documentElement.dataset.theme = theme;
    const color = theme === "dark" ? "#a6f5a8" : "#176b3a";
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path d="M7 27v10M12 22v20M17 14v36M22 19v26M27 25v14M32 28v8M37 25v14M42 19v26M47 14v36M52 22v20M57 27v10" fill="none" stroke="${color}" stroke-width="3.5" stroke-linecap="round"/></svg>`;
    document.getElementById("favicon").href = `data:image/svg+xml,${encodeURIComponent(svg)}`;
  };
  applyTheme();

  document.addEventListener("DOMContentLoaded", () => {
    const button = document.getElementById("theme-toggle");
    const updateLabel = () => {
      const label = `Switch to ${theme === "dark" ? "light" : "dark"} mode`;
      if (globalThis.ccdxLanguage) {
        globalThis.ccdxLanguage.set(button, label, {}, "aria-label");
        globalThis.ccdxLanguage.set(button, label, {}, "title");
      } else {
        button.setAttribute("aria-label", label);
        button.title = label;
      }
    };
    updateLabel();
    button.addEventListener("click", () => {
      theme = theme === "dark" ? "light" : "dark";
      applyTheme();
      try { localStorage.setItem(key, theme); } catch { /* Keep the current selection. */ }
      updateLabel();
    });
  });
})();
