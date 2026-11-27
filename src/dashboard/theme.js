(() => {
  const key = "ccdx.dashboard.theme", paletteKey = "ccdx.dashboard.palette", fontKey = "ccdx.dashboard.font";
  const colors = { green: ["#a6f5a8", "#176b3a"], klein: ["#789aff", "#002fa7"], pink: ["#f3a8c8", "#a83e68"],
    mono: ["#ffffff", "#000000"], paper: ["#e4ceb0", "#4c493e"] };
  const valid = value => Object.hasOwn(colors, value);
  const validFont = value => ["inter", "system", "mono"].includes(value);
  let theme = "dark", palette = "green", saved = true;
  let font = "inter", fontSaved = true;
  try {
    if (localStorage.getItem(key) === "light") theme = "light";
    const value = localStorage.getItem(paletteKey);if (valid(value)) palette = value;
  } catch { saved = false; }
  try { const value = localStorage.getItem(fontKey);if (validFont(value)) font = value; } catch { fontSaved = false; }
  document.documentElement.dataset.webFont = font;
  const label = (node, message) => {
    if (!node) return;
    if (globalThis.ccdxLanguage) globalThis.ccdxLanguage.set(node, message);
    else node.textContent = message;
  };
  function sync() {
    const select = document.getElementById("web-color-theme");if (select) select.value = palette;
    label(document.getElementById("web-color-note"), saved ? "theme_saved_browser" : "theme_tab_only");
    const fontSelect = document.getElementById("web-font");if (fontSelect) fontSelect.value = font;
    label(document.getElementById("web-font-note"), fontSaved ? "theme_saved_browser" : "theme_tab_only");
  }
  const applyTheme = () => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.palette = palette;
    const color = colors[palette][theme === "dark" ? 0 : 1];
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><g fill="none" stroke="${color}" stroke-width="3" stroke-linecap="round"><ellipse cx="32" cy="32" rx="26" ry="10"/><ellipse cx="32" cy="32" rx="26" ry="10" transform="rotate(60 32 32)"/><ellipse cx="32" cy="32" rx="26" ry="10" transform="rotate(120 32 32)"/></g><circle cx="32" cy="32" r="4.5" fill="${color}"/></svg>`;
    document.getElementById("favicon").href = `data:image/svg+xml,${encodeURIComponent(svg)}`;
  };
  applyTheme();
  function persist(values = { theme, palette }) {
    try { localStorage.setItem(key, values.theme);localStorage.setItem(paletteKey, values.palette);saved = true; }
    catch { saved = false; }
    sync();
    return saved;
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
      if (!globalThis.ccdxSettingsPreferences?.appearanceChanged()) persist();
    });
    document.getElementById("web-font")?.addEventListener("change", event => {
      if (!validFont(event.target.value)) return;
      font = event.target.value;document.documentElement.dataset.webFont = font;
      try { localStorage.setItem(fontKey, font);fontSaved = true; } catch { fontSaved = false; }
      sync();
    });
    globalThis.ccdxDashboardTheme = {
      snapshot: () => ({ theme, palette }), persist, sync,
      read: () => ({ theme: localStorage.getItem(key) === "light" ? "light" : "dark", palette: valid(localStorage.getItem(paletteKey)) ? localStorage.getItem(paletteKey) : "green" }),
      preview(values) { if (["light", "dark"].includes(values.theme)) theme = values.theme;if (valid(values.palette)) palette = values.palette;applyTheme();updateLabel();sync(); },
    };
    globalThis.addEventListener?.("storage", event => {
      if (event.key === fontKey) {
        font = validFont(event.newValue) ? event.newValue : "inter";
        document.documentElement.dataset.webFont = font;sync();return;
      }
      if (event.key !== paletteKey && event.key !== key) return;
      if (globalThis.ccdxSettingsPreferences?.externalAppearance()) return;
      if (event.key === paletteKey) palette = valid(event.newValue) ? event.newValue : "green";
      else theme = event.newValue === "light" ? "light" : "dark";
      applyTheme();updateLabel();sync();
    });
  });
})();
