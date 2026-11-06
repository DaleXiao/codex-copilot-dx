(() => {
  function create({ element: el, change, localize }) {
    let saved = null, limitDirty = false, imageSignature = "", imageApp = { status: "unknown" }, appInspectionStarted = false;
    function renderImageApp() {
      const connected = imageApp.status === "running" && imageApp.host === "connected";
      const restart = imageApp.status === "running" && (imageApp.needs_restart === true || saved?.features?.prediction?.display_pending === true);
      const action = restart ? "image_restart" : imageApp.status === "running" ? "image_focus" : imageApp.status === "stopped" ? "image_open" : "image_inspect";
      localize(el("image-open"), action);
      localize(el("prediction-open"), imageApp.status === "unsupported" ? "prediction_open" : action);
      el("image-restart-warning").hidden = !restart;
      el("prediction-restart-warning").hidden = !restart;
      localize(el("image-host-note"), imageApp.status === "stopped" ? "image_app_stopped" : imageApp.status === "multiple" ? "image_action_multiple_apps"
        : connected ? imageApp.tool_registration === "observed" ? "image_host_registered" : "image_host_connected" : "image_host_unconfirmed");
    }
    async function codexAction(operation, intent, button, { quiet = false } = {}) {
      const data = await change({ action: "codex_app", operation, intent, ...(operation === "restart" ? { confirmed: true } : {}) }, button);
      const result = data?.last_operation?.feature === "codex_app" ? data.last_operation.result : null;
      if (!result) return;
      if (result.app) imageApp = result.app;
      if (!quiet) {
        const note = el(intent === "prediction" ? "prediction-action-note" : "image-action-note");
        note.dataset.operation = operation;note.hidden = false;
        const key = operation === "check" ? "codex_action_checked" : result.status === "opened_with_pending"
          ? result.prediction_pending && result.image_pending ? "codex_action_both_pending" : result.prediction_pending ? "codex_action_prediction_pending" : "codex_action_image_pending"
          : result.status === "already_connected" ? "codex_action_ready"
            : result.status === "opened_new_chat_required" && intent === "prediction" ? "codex_action_opened" : "image_action_" + result.status;
        localize(note, key);
      }
      renderImageApp();
    }
    async function imageAction(operation, button, { quiet = false } = {}) {
      const data = await change({ action: "image", operation, ...(operation === "restart" ? { confirmed: true } : {}) }, button);
      const result = data?.last_operation?.feature === "image" ? data.last_operation.result : null;
      if (result) {
        if (result.app) imageApp = result.app;
        if (!quiet) {
          el("image-action-note").dataset.operation = operation;
          el("image-action-note").hidden = false;
          localize(el("image-action-note"), operation === "check" ? "image_connection_" + result.connection?.state : "image_action_" + result.status);
        }
        renderImageApp();
      }
    }
    el("image-check").addEventListener("click", () => void imageAction("check", el("image-check")));
    el("image-repair").addEventListener("click", () => void imageAction("repair", el("image-repair")));
    const appButton = (intent, button) => {
      if (imageApp.status === "unsupported" && intent === "prediction") { void prediction("open");return; }
      const operation = imageApp.status === "running" ? imageApp.needs_restart || saved?.features?.prediction?.display_pending ? "restart" : "focus"
        : imageApp.status === "stopped" ? "open" : "check";
      void codexAction(operation, intent, button);
    };
    el("image-open").addEventListener("click", () => appButton("image", el("image-open")));
    el("additional-capabilities").addEventListener("toggle", () => {
      if (el("additional-capabilities").open) void codexAction("check", "image", el("image-check"), { quiet: true });
    });
    const prediction = operation => change({ action: "prediction", operation }, el("prediction-continue"));
    el("setting-prediction_enabled").addEventListener("change", () => void prediction(el("setting-prediction_enabled").checked ? "enable" : "disable"));
    el("prediction-continue").addEventListener("click", () => void prediction(saved?.features?.prediction?.enabled ? "enable" : "disable"));
    el("fix-prediction").addEventListener("click", () => void prediction("repair"));
    el("prediction-open").addEventListener("click", () => appButton("prediction", el("prediction-open")));
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
      el("prediction-open").disabled = !value?.configured && !value?.display_pending;
      el("prediction-remove").disabled = !value?.configured;
      if (notes) localize(el("prediction-action-note"), !value ? "feature_unavailable" : value.status === "unavailable" ? "feature_read_failed" : pending ? "prediction_quit_continue" : value.enabled && value.bridge !== "running" ? "prediction_bridge_missing" : value.enabled ? "prediction_ready" : "prediction_disabled");
      el("effect-prediction_enabled").hidden = !pending;
      if (pending) localize(el("effect-prediction_enabled"), "feature_pending");
      renderImageApp();
      const image = data.features?.image, signature = JSON.stringify(image ? { ...image, runtime: undefined } : null);
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
      if (!appInspectionStarted && el("prediction-open").closest('[data-view="codex"]')?.hidden === false) {
        appInspectionStarted = true;setTimeout(() => void codexAction("check", "prediction", el("prediction-open"), { quiet: true }), 0);
      }
    }
    return { render };
  }
  globalThis.ccdxDashboardFeatures = { create };
})();
