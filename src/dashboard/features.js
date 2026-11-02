(() => {
  function create({ element: el, change, localize }) {
    let saved = null, imageDirty = false, limitDirty = false;
    const prediction = operation => change({ action: "prediction", operation }, el("prediction-continue"));
    el("setting-prediction_enabled").addEventListener("change", () => void prediction(el("setting-prediction_enabled").checked ? "enable" : "disable"));
    el("prediction-continue").addEventListener("click", () => void prediction(saved?.features?.prediction?.enabled ? "enable" : "disable"));
    el("fix-prediction").addEventListener("click", () => void prediction("repair"));
    el("prediction-open").addEventListener("click", () => void prediction("open"));
    el("prediction-setup").addEventListener("click", () => void prediction("setup"));
    el("prediction-remove").addEventListener("click", () => { if (window.confirm(globalThis.ccdxLanguage.format("prediction_remove_confirm"))) void prediction("remove"); });
    const imageInput = operation => ({ action: "image", operation, endpoint: el("image-setup-endpoint").value,
      key: el("image-setup-key").value, model: el("image-setup-model").value || undefined });
    el("image-setup-form").addEventListener("input", () => { imageDirty = true; });
    el("image-setup-inspect").addEventListener("click", async () => {
      const data = await change(imageInput("inspect"), el("image-setup-inspect"));
      const result = data?.last_operation?.result;
      if (!Array.isArray(result?.models)) return;
      imageDirty = true;
      const current = el("image-setup-model").value;
      el("image-setup-model").replaceChildren(...result.models.map(id => { const item = document.createElement("option");item.value = item.textContent = id;return item; }));
      if (result.models.includes(current)) el("image-setup-model").value = current;
      localize(el("image-setup-note"), "image_models_ready");
    });
    el("image-setup-form").addEventListener("submit", async event => {
      event.preventDefault();
      const data = await change(imageInput("setup"), el("image-setup-save"));
      if (data?.last_operation?.result?.configured) { imageDirty = false;el("image-setup-key").value = "";render(data);localize(el("image-setup-note"), "image_setup_saved"); }
    });
    el("image-setup-remove").addEventListener("click", async () => {
      if (!window.confirm(globalThis.ccdxLanguage.format("image_remove_confirm"))) return;
      const data = await change({ action: "image", operation: "remove" }, el("image-setup-remove"));
      if (data) { imageDirty = false;el("image-setup-key").value = "";render(data); }
    });
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
      localize(el("effect-prediction_enabled"), pending ? "feature_pending" : value?.enabled ? "on" : "off");
      const image = data.features?.image;
      if (!imageDirty) {
        el("image-setup-endpoint").value = image?.endpoint || "";
        const option = document.createElement("option");option.value = option.textContent = image?.model || "";el("image-setup-model").replaceChildren(option);
      }
      el("image-setup-remove").disabled = !image?.configured;
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
