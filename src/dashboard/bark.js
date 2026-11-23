(() => {
  function create({ api, element: el }) {
    const form = el("bark-settings");
    if (!form) return null;
    const fieldset = form.querySelector("fieldset"), status = el("bark-status"), fields = form.elements;
    let dirty = false, saving = false, notice;
    const words = (node, key, prop) => globalThis.ccdxLanguage.set(node, key, {}, prop);
    function sync(data) {
      if (!data || dirty || saving) return;
      for (const key of ["minutes", "title", "body"]) fields[key].value = data[key];
      fields.enabled.checked = data.enabled;
      fields.url.value = "";
      const apps = (data.sources || []).map(id => globalThis.ccdxLanguage.format("bark_source_" + id)).join(", ");
      if (apps) globalThis.ccdxLanguage.set(el("bark-sources"), "bark_active_sources", { apps });
      if (data.configured) words(fields.url, "bark_url_saved", "placeholder");
      else { fields.url.removeAttribute("data-i18n-placeholder");fields.url.placeholder = "https://bark.example/…"; }
      const message = data.delivery === "sent" ? "bark_sent" : data.delivery === "failed" ? "bark_failed"
        : data.enabled && !data.watching ? "bark_waiting" : notice;
      if (message) words(status, message);
      else { status.removeAttribute("data-i18n");status.textContent = ""; }
      fieldset.disabled = false;
    }
    form.addEventListener("input", () => { dirty = true;notice = null; });
    form.addEventListener("submit", async event => {
      event.preventDefault();
      if (saving) return;
      saving = true;fieldset.disabled = true;
      let data;
      try {
        data = await api({ action: "bark", enabled: fields.enabled.checked, minutes: fields.minutes.valueAsNumber,
          title: fields.title.value, body: fields.body.value, url: fields.url.value,
          language: document.documentElement.lang.startsWith("zh") ? "zh" : "en" });
        dirty = false;notice = "api_saved";
      } catch (error) { words(status, error.message === "ccdx_bark_invalid" ? "bark_invalid" : "bark_save_failed"); }
      finally { saving = false;fieldset.disabled = false; }
      if (data) sync(data.bark);
    });
    return { sync };
  }
  globalThis.ccdxBarkSettings = { create };
})();
