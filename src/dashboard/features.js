(() => {
  function create({ element: el, change, localize }) {
    let saved = null, limitDirty = false, imageSignature = "";
    const dock = operation => change({ action: "image", operation: "dock-" + operation }, el("image-dock-enabled"));
    el("image-dock-enabled").addEventListener("change", () => {
      const enabled = el("image-dock-enabled").checked;
      if (enabled && !window.confirm(globalThis.ccdxLanguage.format("image_dock_scope"))) { el("image-dock-enabled").checked = false;return; }
      void dock(enabled ? "enable" : "disable");
    });
    el("image-dock-check").addEventListener("click", () => void dock("status"));
    el("image-dock-repair").addEventListener("click", () => void dock("repair"));
    const prediction = operation => change({ action: "prediction", operation }, el("prediction-continue"));
    el("setting-prediction_enabled").addEventListener("change", () => void prediction(el("setting-prediction_enabled").checked ? "enable" : "disable"));
    el("prediction-continue").addEventListener("click", () => void prediction(saved?.features?.prediction?.enabled ? "enable" : "disable"));
    el("fix-prediction").addEventListener("click", () => void prediction("repair"));
    el("prediction-open").addEventListener("click", () => void prediction("open"));
    el("prediction-setup").addEventListener("click", () => void prediction("setup"));
    el("prediction-remove").addEventListener("click", () => { if (window.confirm(globalThis.ccdxLanguage.format("prediction_remove_confirm"))) void prediction("remove"); });
    el("decoded-limit").addEventListener("input", () => { limitDirty = true; });
    const saveLimit = async mib => {
      const data = await change({ action: "decoded_limit", mib }, el(mib === null ? "decoded-limit-default" : "decoded-limit-save"));
      if (data?.decoded_body) { limitDirty = false;render(data); }
    };
    el("decoded-limit-save").addEventListener("click", () => void saveLimit(Number(el("decoded-limit").value)));
    el("decoded-limit-default").addEventListener("click", () => void saveLimit(null));
    el("install-update").addEventListener("click", () => {
      if (window.confirm(globalThis.ccdxLanguage.format("update_install_confirm"))) void change({ action: "update", confirmed: true }, el("install-update"));
    });
    function render(data, { notes = true } = {}) {
      if (!data) return;
      saved = data;
      const value = data.features?.prediction;
      el("setting-prediction_enabled").checked = value?.enabled === true;
      el("setting-prediction_enabled").disabled = !value || value.status === "unavailable";
      const pending = value?.display_pending || value?.enabled && (!value.configured || value.display?.enabled === false);
      el("prediction-continue").hidden = !pending;
      el("prediction-open").disabled = !value?.configured;
      el("prediction-remove").disabled = !value?.configured;
      if (notes) localize(el("prediction-action-note"), !value ? "feature_unavailable" : value.status === "unavailable" ? "feature_read_failed" : pending ? "prediction_quit_continue" : value.enabled && value.bridge !== "running" ? "prediction_bridge_missing" : value.enabled ? "prediction_ready" : "prediction_disabled");
      el("effect-prediction_enabled").hidden = !pending;
      if (pending) localize(el("effect-prediction_enabled"), "feature_pending");
      const image = data.features?.image, signature = JSON.stringify(image || null);
      const docking = image?.dock;
      el("image-dock-enabled").checked = docking?.saved === true;
      el("image-dock-enabled").disabled = !docking?.supported;
      el("image-dock-check").disabled = !docking?.supported;
      el("image-dock-repair").disabled = !docking?.supported || !docking.saved;
      localize(el("image-dock-status"), "image_dock_" + (docking?.state || "unsupported"));
      if (signature !== imageSignature) {
        imageSignature = signature;
        const list = el("image-models"), focus = list.contains(document.activeElement) ? document.activeElement.value : null;
        list.replaceChildren();
        for (const model of image?.models || []) {
          const label = document.createElement("label"), name = document.createElement("span");name.textContent = model.name || model.id;
          label.className = "image-model-choice";label.dataset.model = model.id;
          if (image.models.length > 1 || image.selected_model !== model.id) {
            const radio = document.createElement("input");radio.type = "radio";radio.name = "image-model";radio.value = model.id;radio.checked = image.selected_model === model.id;
            radio.addEventListener("change", () => { if (radio.checked) void change({ action: "image", operation: "select", model: model.id }, radio); });label.append(radio);
          }
          label.append(name);list.append(label);
        }
        const note = el("image-model-note");note.hidden = image?.availability === "ready";
        if (!note.hidden) localize(note, image?.availability === "needs_github_access" ? "image_needs_github" : image?.availability === "selected_unavailable" ? "image_selected_unavailable" : "image_no_models");
        if (focus) [...list.querySelectorAll("input")].find(input => input.value === focus)?.focus();
      }
      for (const radio of el("image-models").querySelectorAll('input[name="image-model"]')) radio.checked = radio.value === image?.selected_model;
      const limit = data.decoded_body;
      if (!limitDirty && document.activeElement !== el("decoded-limit")) el("decoded-limit").value = limit?.bytes / 1048576 || 128;
      el("decoded-limit").disabled = el("decoded-limit-save").disabled = el("decoded-limit-default").disabled = !limit || limit.source === "environment";
      localize(el("decoded-limit-note"), limit?.source === "environment" ? "controlled_by_environment" : "next_ccdx_start");
      el("install-update").disabled = !data.manual_update?.available;
      const update = data.nightly_update;
      if (notes) localize(el("manual-update-note"), !data.manual_update?.available ? "update_external_launch" : update?.manual ? `manual_update_${update.phase}` : "update_idle_switch");
    }
    return { render };
  }
  globalThis.ccdxDashboardFeatures = { create };
})();
