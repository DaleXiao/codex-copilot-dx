(() => {
  function create({ element: el, change, localize }) {
    let saved = null, limitDirty = false;
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
