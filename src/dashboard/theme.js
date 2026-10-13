(() => {
  const key = "ccdx.dashboard.theme";
  let theme = "dark";
  try {
    if (localStorage.getItem(key) === "light") theme = "light";
  } catch { /* Private browsing may disable storage. */ }
  const applyTheme = () => {
    document.documentElement.dataset.theme = theme;
    const color = theme === "dark" ? "#a6f5a8" : "#176b3a";
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><g fill="none" stroke="${color}" stroke-width="3" stroke-linecap="round"><ellipse cx="32" cy="32" rx="26" ry="10"/><ellipse cx="32" cy="32" rx="26" ry="10" transform="rotate(60 32 32)"/><ellipse cx="32" cy="32" rx="26" ry="10" transform="rotate(120 32 32)"/></g><circle cx="32" cy="32" r="4.5" fill="${color}"/></svg>`;
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
