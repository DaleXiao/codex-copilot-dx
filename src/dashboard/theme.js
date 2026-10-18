(() => {
  const key = "ccdx.dashboard.theme", paletteKey = "ccdx.dashboard.palette";
  const valid = value => value === "green" || value === "klein";
  let theme = "dark", palette = "green", saved = true;
  try {
    if (localStorage.getItem(key) === "light") theme = "light";
    const value = localStorage.getItem(paletteKey);if (valid(value)) palette = value;
  } catch { saved = false; }
  const label = (node, message) => {
    if (!node) return;
    if (globalThis.ccdxLanguage) globalThis.ccdxLanguage.set(node, message);
    else node.textContent = message;
  };
  function sync() {
    const select = document.getElementById("web-color-theme");if (select) select.value = palette;
    label(document.getElementById("web-color-note"), saved ? "theme_saved_browser" : "theme_tab_only");
  }
  const applyTheme = () => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.palette = palette;
    const color = palette === "klein" ? theme === "dark" ? "#789aff" : "#002fa7" : theme === "dark" ? "#a6f5a8" : "#176b3a";
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><g fill="none" stroke="${color}" stroke-width="3" stroke-linecap="round"><ellipse cx="32" cy="32" rx="26" ry="10"/><ellipse cx="32" cy="32" rx="26" ry="10" transform="rotate(60 32 32)"/><ellipse cx="32" cy="32" rx="26" ry="10" transform="rotate(120 32 32)"/></g><circle cx="32" cy="32" r="4.5" fill="${color}"/></svg>`;
    document.getElementById("favicon").href = `data:image/svg+xml,${encodeURIComponent(svg)}`;
  };
  applyTheme();
  function persist() {
    try { localStorage.setItem(key, theme);localStorage.setItem(paletteKey, palette);saved = true; }
    catch { saved = false; }
    sync();
  }
  document.addEventListener("DOMContentLoaded", () => {
    const button = document.getElementById("theme-toggle");
    const updateLabel = () => {
      const value = `Switch to ${theme === "dark" ? "light" : "dark"} mode`;
      if (globalThis.ccdxLanguage) {
        globalThis.ccdxLanguage.set(button, value, {}, "aria-label");
        globalThis.ccdxLanguage.set(button, value, {}, "title");
      } else { button.setAttribute("aria-label", value);button.title = value; }
    };
    updateLabel();sync();
    button.addEventListener("click", () => {
      theme = theme === "dark" ? "light" : "dark";applyTheme();
      persist();
      updateLabel();
    });
    document.getElementById("web-color-theme")?.addEventListener("change", event => {
      if (!valid(event.target.value)) return;
      palette = event.target.value;applyTheme();
      persist();
    });
    globalThis.addEventListener?.("storage", event => {
      if (event.key !== paletteKey && event.key !== key) return;
      if (event.key === paletteKey) palette = valid(event.newValue) ? event.newValue : "green";
      else theme = event.newValue === "light" ? "light" : "dark";
      applyTheme();updateLabel();sync();
    });
  });
})();
