(() => {
  const el = id => document.getElementById(id), root = el("connection-sources");if (!root) return;
  const words = (node, key, args) => globalThis.ccdxLanguage.set(node, key, args), format = key => globalThis.ccdxLanguage.format(key);
  let data = null, editing = null, editingClient = null, disabling = null, models = [], selectedModels = new Set(), busy = false, generation = 0;
  let claudeClient = "claude_app", bindingSelection = new Set(), bindingDefault = null, bindingDirty = false;
  let memoryAction = null, memoryOrigin = null;
  let disableRevision = null;
  const drafts = new Map();let editorOrigin = null, discovery = null, desiredSource = null;
  const apiForm = el("connection-api-form"), clientForm = el("connection-client-form");
  const node = (tag, text, className) => { const item = document.createElement(tag);if (text !== undefined) item.textContent = text;if (className) item.className = className;return item; };
  const source = id => data.providers.find(item => item.id === id), client = id => data.clients.find(item => item.id === id);
  let accessDraft = null, accessError = null, accessRefresh = [], accessReview = [];
  const accessForm = el("m365-app-access");
  function renderAccess() {
    if (!accessForm) return;accessForm.hidden = selectedProvider !== "m365";
    const saved = data.clients.filter(c => c.allowed.includes("m365")).map(c => c.id), selected = accessDraft || saved;
    const area = el("m365-allowed-apps"), focus = area.contains(document.activeElement) ? document.activeElement.value : null;
    area.replaceChildren(...data.clients.filter(c => c.enabled).map(c => {
      const item = check("m365-app", c.id, selected.includes(c.id), c.name);
      item.firstChild.disabled = busy;item.firstChild.addEventListener("change", () => {
        accessDraft = [...selected.filter(id => !data.clients.find(c => c.id === id)?.enabled), ...[...area.querySelectorAll("input:checked")].map(input => input.value)];
        accessError = null;
        renderAccess();[...area.querySelectorAll("input")].find(input => input.value === c.id)?.focus();
      });return item;
    }));
    const dirty = JSON.stringify([...saved].sort()) !== JSON.stringify([...selected].sort());el("m365-access-save").disabled = busy || !dirty;
    words(el("m365-access-state"), accessError || (dirty ? "cap_unsaved" : accessReview.length ? "source_apps_review" : accessRefresh.length ? "source_apps_reopen" : saved.length ? "cap_saved" : "source_apps_none"),
      { apps: (accessReview.length ? [...new Set([...accessReview, ...accessRefresh])] : accessRefresh).map(id => data.clients.find(c => c.id === id)?.name || id).join(" / ") });
    const affected = data.clients.filter(c => !selected.includes(c.id) && (c.source === "m365" || c.deployments?.some(item => item.source === "m365")));
    el("m365-access-warning").hidden = !affected.length;words(el("m365-access-warning"), "source_apps_pause", { apps: affected.map(c => c.name).join(" / ") });
    if (focus) [...area.querySelectorAll("input")].find(input => input.value === focus)?.focus();
  }
  accessForm?.addEventListener("submit", event => { event.preventDefault();accessError = null;void change({ operation: "source_access", id: "m365", allowed: accessDraft || [] }, result => { accessDraft = null;accessRefresh = result.client_refresh || [];accessReview = result.client_review || [];renderAccess(); }); });
  const compatible = (provider, id) => provider.protocols.includes(id === "codex" ? "responses" : "messages");
  const selectableSource = (provider, id) => compatible(provider, id)
    && (provider.builtin || provider.models?.some(model => model.protocols.includes(id === "codex" ? "responses" : "messages")));
  const message = (key, values) => words(el("connection-note"), key, values);
  function button(key, action) { const item = node("button");item.type = "button";words(item, key);item.addEventListener("click", action);return item; }
  function check(name, value, checked, text) { const label = node("label"), input = node("input");input.type = "checkbox";input.name = name;input.value = value;input.checked = checked;label.append(input, node("span", text));return label; }
  async function api(input, signal) {
    const response = await fetch("/_ccdx/ui/connections", { method: input ? "POST" : "GET", headers: { "X-CCDX-Dashboard": "1", ...(input ? { "Content-Type": "application/json" } : {}) },
      cache: "no-store", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(35000)]) : AbortSignal.timeout(35000), ...(input ? { body: JSON.stringify(input) } : {}) });
    const result = await response.json();if (!response.ok) throw new Error(result.error || "ccdx_connections_action_failed");
    if (result.source !== "connections" || !Array.isArray(result.providers) || !Array.isArray(result.clients)) throw new Error("ccdx_connections_unavailable");return result;
  }
  function panels(which = "list") {
    if (which !== "api") stopDiscovery();
    root.hidden = which !== "list";
    el("source-account-panel").hidden = el("model-providers").hidden = which !== "list";
    el("connection-editor").hidden = which !== "api";el("connection-disable-editor").hidden = which !== "disable";
    (which === "api" ? el("connection-editor") : which === "disable" ? el("connection-disable-editor") : root).append(el("connection-note"));
    apiForm.elements.key.value = "";
  }
  function choice(options, selected, pause = true) {
    const select = node("select");if (pause) { const item = node("option");item.value = "";words(item, "api_pause");select.append(item); }
    for (const value of options) { const item = node("option", value.name);item.value = value.id;select.append(item); }select.value = selected || "";return select;
  }
  function list() {
    const providerList = el("connection-source-list"), clientList = el("connection-client-list"), disabledSources = el("connection-disabled-source-list"), disabledClients = el("connection-disabled-client-list");
    providerList.replaceChildren();clientList.replaceChildren();disabledSources.replaceChildren();disabledClients.replaceChildren();
    for (const provider of data.providers) {
      const row = node("div", undefined, "connection-row"), info = node("div"), actions = node("div", undefined, "connection-actions");info.append(node("h3", provider.name));
      if (!provider.builtin) info.append(node("p", provider.base_url, "hint"));
      if (provider.enabled) {
        const allowed = data.clients.filter(c => c.enabled && c.allowed.includes(provider.id)).map(c => c.name).join(" / ");
        const line = node("p", undefined, "hint");words(line, "api_allowed_summary", { clients: allowed || format("api_none") });info.append(line);
        if (provider.discovery?.state === "stale") { const warning = node("p", undefined, "hint");words(warning, "cap_catalog_stale");warning.append(" ", provider.discovery.code);info.append(warning); }
        if (!provider.builtin) actions.append(button("api_manage", () => editApi(provider)));
        const toggle = node("input");toggle.type = "checkbox";toggle.checked = true;toggle.setAttribute("role", "switch");toggle.setAttribute("aria-label", format("api_disable_source") + " " + provider.name);
        toggle.addEventListener("change", () => { toggle.checked = true;disableSource(provider); });const hit = node("label", undefined, "switch-hit");hit.append(toggle);actions.append(hit);
      } else actions.append(button("api_restore", () => void change({ operation: "provider", id: provider.id, enabled: true })));
      row.append(info, actions);if (!provider.enabled) disabledSources.append(row);else if (provider.id === selectedProvider) providerList.append(row);
    }
    const current = editingClient && client(editingClient);
    if (current) {
      const row = node("div", undefined, "connection-row"), title = node("strong", current.name), toggle = node("input");
      toggle.type = "checkbox";toggle.checked = current.enabled;toggle.setAttribute("role", "switch");toggle.setAttribute("aria-label", current.name);
      toggle.addEventListener("change", () => void change({ operation: "client", id: current.id, enabled: toggle.checked,
        source: toggle.checked ? current.source : null, allowed: current.allowed, ...(Array.isArray(current.deployments) ? { deployments: current.deployments, default_model: current.default_model, auto_sync: current.auto_sync } : {}) }));
      const hit = node("label", undefined, "switch-hit");hit.append(toggle);row.append(title, hit);clientList.append(row);
    }
    for (const c of data.clients.filter(c => !c.enabled)) {
      const row = node("div", undefined, "connection-row");row.append(node("span", c.name), button("api_restore", () => void change({ operation: "client", id: c.id, enabled: true, source: null, allowed: c.allowed })));disabledClients.append(row);
    }
    el("connection-disabled-sources").hidden = !disabledSources.children.length;
    el("connection-disabled-clients").hidden = !disabledClients.children.length;
    // App pages remain reachable while disabled, so access can be restored there.
    for (const route of ["codex", "claude"]) { const link = document.querySelector(`[data-route="${route}"]`);if (link) link.hidden = false; }
    const m365Toggle = el("m365-enabled")?.closest(".setting-row");if (m365Toggle) m365Toggle.hidden = true;
    for (const link of document.querySelectorAll("[data-source-link]")) { const id = link.dataset.sourceLink;if (["m365", "github"].includes(id)) link.hidden = !source(id)?.enabled; }
    globalThis.ccdxConnectionNames = Object.fromEntries(data.providers.map(p => [p.id, p.name]));
    renderAccess();
  }
  async function load() {
    if (busy) return;const current = ++generation;
    try { const result = await api();if (current !== generation) return;data = result;mountClient();list(); }
    catch (error) { if (!data) message(error.message); }
  }
  async function change(input, done) {
    if (busy) return;busy = true;generation++;
    const trigger = input.operation === "client" ? clientForm.querySelector('button[type="submit"]') : input.operation === "preview_client" ? el("connection-sync-preview")
      : input.operation === "save_api" ? apiForm.querySelector('button[type="submit"]') : document.activeElement;
    const oldKey = trigger?.dataset.i18n, oldText = trigger?.textContent;
    if (trigger?.tagName === "BUTTON") { trigger.setAttribute("aria-busy", "true");trigger.disabled = true;words(trigger, input.operation === "preview_client" ? "api_reading" : "api_saving"); }
    try { if (input.operation === "save_api") await stopDiscovery();data = await api(input);if (input.operation === "client") { drafts.delete(input.id);if (editingClient === input.id) bindingDirty = false; }mountClient();list();done?.(data);if (!done) {
      if (input.operation === "save_api") {
        desiredSource = input.id || data.providers.find(p => !p.builtin && p.name === input.config.name)?.id;
        stopDiscovery();
      } else if (input.operation === "provider" && input.enabled) desiredSource = input.id;
      panels();let key = input.operation === "save_api" ? "api_config_saved" : input.operation === "provider" ? input.enabled ? "api_provider_enabled" : "api_provider_disabled"
        : !input.enabled ? "api_client_disabled" : !input.source ? "api_client_enabled" : "api_saved";
      const setup = data.clients.find(c => c.id === input.id)?.setup;
      if (input.operation === "client" && ["preserved", "partially_preserved"].includes(setup)) key = "api_client_preserved";
      if (input.operation === "client" && setup === "configuration_unavailable") key = "api_client_config_failed";
      if (input.operation === "client" && setup === "not_installed") key = "api_client_not_installed";
      if (input.operation === "client" && setup === "configured") key = "sync_config_written";
      if (input.operation === "client" && setup === "manual_sync") key = "sync_manual";
      if (input.operation === "client") words(el("connection-client-note"), key);else message(key);
      if (input.operation === "save_api" && input.config.models.length) for (const c of data.clients.filter(c => c.enabled && input.allowed.includes(c.id))) {
        const link = node("a", c.name, "section-link");link.href = c.id === "codex" ? "#codex" : "#claude";link.addEventListener("click", event => { event.preventDefault();editClient(c); });el("connection-note").append(" ", link);
      }
    }window.dispatchEvent(new CustomEvent("ccdx:connections"));void dashboardRefresh.refresh("auth", { force: true });void dashboardRefresh.refresh("status", { force: true }); }
    catch (error) {
      if (input.operation === "provider" && !input.enabled && error.message === "ccdx_connections_conflict") {
        try { data = await api();list();disableSource(source(input.id));message("api_impact_changed"); } catch { message(error.message); }return;
      }
      if (input.operation === "source_access") accessError = error.message;else if (input.operation === "client") words(el("connection-client-note"), error.message);else message(error.message);return;
    }
    finally { busy = false;if (trigger?.tagName === "BUTTON") { trigger.removeAttribute("aria-busy");trigger.disabled = false;if (oldKey) words(trigger, oldKey);else trigger.textContent = oldText; }
      if (["client", "preview_client"].includes(input.operation)) bindingRows();
      if (input.operation === "source_access") renderAccess();
      if (input.operation === "save_api") words(apiForm.querySelector('button[type="submit"]'), editing ? "api_save" : "api_save_read");
    }
    return true;
  }
  const resolved = (model, protocol = model.protocols.includes("messages") ? "messages" : model.protocols[0]) => {
    const metadata = model.metadata?.deployment === source(editing)?.deployment_revision ? model.metadata : null;
    const values = { ...metadata?.values, ...metadata?.protocols?.[protocol], ...(model.context_window === undefined ? {} : { context_window: model.context_window }),
      ...(model.reasoning_efforts === undefined ? {} : { reasoning_efforts: model.reasoning_efforts }), ...(model.capabilities || {}) };
    if (values.reasoning_format && values.reasoning_format !== protocol) for (const key of Object.keys(values).filter(key => key.startsWith("reasoning"))) delete values[key];
    if (values.reasoning === false) delete values.reasoning_efforts;
    return values;
  };
  const count = value => !value ? format("cap_unknown") : value >= 1000000 ? `${Number((value / 1000000).toFixed(2))}M` : value >= 1000 ? `${Number((value / 1000).toFixed(1))}K` : String(value);
  const reasoningText = values => values.reasoning === false ? format("cap_unsupported") : values.reasoning_efforts?.length ? values.reasoning_efforts.join(" / ") : values.reasoning === true ? format("cap_supported") : format("cap_unknown");
  const searchText = values => values.web_search === undefined ? format("cap_unknown") : values.web_search.length ? values.web_search.map(protocol => protocol === "messages" ? "Messages" : protocol === "responses" ? "Responses" : "Chat").join(" / ") : format("cap_unsupported");
  function closeModelDetail() {
    const detail = el("connection-model-detail");
    const row = detail.closest(".connection-detail-row");
    detail.hidden = true;
    el("connection-models").closest("fieldset").append(detail);
    row?.remove();
    for (const button of el("connection-models").querySelectorAll("[data-model-details]")) button.setAttribute("aria-expanded", "false");
  }
  function modelDetail(model, modelRow, trigger) {
    if (trigger.getAttribute("aria-expanded") === "true") { closeModelDetail();return; }
    closeModelDetail();
    const detail = el("connection-model-detail");detail.hidden = false;detail.replaceChildren();
    const row = node("tr", undefined, "connection-detail-row"), cell = node("td");
    cell.colSpan = modelRow.children.length;
    cell.append(detail);row.append(cell);modelRow.after(row);
    trigger.setAttribute("aria-expanded", "true");
    const heading = node("div", undefined, "panel-heading");heading.append(node("h3", model.id), button("close", () => { closeModelDetail();trigger.focus(); }));detail.append(heading);
    const protocol = choice(model.protocols.map(id => ({ id, name: id === "messages" ? "Messages" : id === "responses" ? "Responses" : "Chat" })), model.protocols.includes("messages") ? "messages" : model.protocols[0], false);
    protocol.setAttribute("aria-label", format("cap_api"));detail.append(protocol);
    const status = node("p", undefined, "hint"), table = node("table"), body = node("tbody");table.append(body);detail.append(status, table);
    const maker = model.display || source(editing)?.model_display?.[model.id] || {};
    const identity = node("dl", undefined, "model-identity");
    for (const [label, value] of [["vendor", maker.publisher || maker.vendor || format("cap_unknown")], ["model_owner", maker.owned_by]]) {
      if (!value) continue;const term = node("dt");words(term, label);identity.append(term, node("dd", value));
    }
    detail.insertBefore(identity, protocol);
    const advanced = node("details"), summary = node("summary");words(summary, "cap_manual");advanced.append(summary);detail.append(advanced);
    const note = node("p", undefined, "hint");words(note, "cap_metadata_scope");advanced.append(note);
    const fields = node("div", undefined, "connection-fields");
    const numeric = ["context_window", "max_input_tokens", "max_output_tokens", "reasoning_budget_min", "reasoning_budget_max"];
    const flags = ["reasoning", "reasoning_required", "reasoning_adaptive", "tools", "parallel_tools", "streaming", "structured_output"];
    const arrays = ["reasoning_efforts", "thinking_modes", "input_modalities", "web_search"];
    for (const key of [...numeric, ...flags, ...arrays, "reasoning_format"]) {
      const label = node("label"), title = node("span");words(title, "cap_field_" + key);label.append(title);
      let input;
      if (flags.includes(key) || key === "reasoning_format") {
        input = node("select");for (const [value, text] of [["", "cap_follow_catalog"], ...(key === "reasoning_format" ? [["messages", "Messages"], ["responses", "Responses"], ["chat", "Chat"]] : [["true", "cap_supported"], ["false", "cap_unsupported"]])]) {
          const option = node("option");option.value = value;words(option, text);input.append(option);
        }
      } else { input = node("input");input.type = numeric.includes(key) ? "number" : "text";if (numeric.includes(key)) { input.min = "1";input.max = "100000000";input.step = "1"; } }
      input.dataset.capability = key;
      const manual = model.capabilities?.[key] ?? (key === "context_window" ? model.context_window : key === "reasoning_efforts" ? model.reasoning_efforts : undefined);
      input.value = manual === undefined ? "" : Array.isArray(manual) ? manual.length ? manual.join(", ") : "[]" : String(manual);
      const evidence = node("span", undefined, "hint");words(evidence, manual !== undefined ? "cap_manual" : "cap_follow_catalog");label.append(input, evidence);fields.append(label);
    }
    function showCapabilities() {
      const values = resolved(model, protocol.value), fresh = model.metadata?.deployment === source(editing)?.deployment_revision;
      words(status, fresh ? "cap_catalog_" + (model.metadata.state || "reported") : "cap_unknown");
      if (fresh && model.metadata.checked_at) status.append(" · ", new Date(model.metadata.checked_at).toLocaleString());
      body.replaceChildren();
      for (const key of ["context_window", "max_input_tokens", "max_output_tokens", "reasoning_efforts", "reasoning_adaptive", "tools", "input_modalities", "web_search"]) {
        const row = node("tr"), label = node("th");words(label, ({ reasoning_efforts: "cap_reasoning", input_modalities: "cap_input_types", web_search: "cap_search" })[key] || "cap_field_" + key);
        const value = values[key], text = key === "reasoning_efforts" ? reasoningText(values) : key === "web_search" ? searchText(values)
          : value === undefined ? format("cap_unknown") : typeof value === "boolean" ? format(value ? "cap_supported" : "cap_unsupported") : Array.isArray(value) ? value.join(" / ") || format("cap_unsupported") : count(value);
        row.append(label, node("td", text));body.append(row);
      }
      for (const input of fields.querySelectorAll("input[data-capability]")) { const value = values[input.dataset.capability];input.placeholder = value === undefined ? format("cap_unknown") : Array.isArray(value) ? value.join(", ") : String(value); }
    }
    protocol.addEventListener("change", showCapabilities);showCapabilities();advanced.append(fields);
    const save = button("cap_apply_details", () => {
      const override = {};
      for (const input of fields.querySelectorAll("[data-capability]")) {
        const key = input.dataset.capability, text = input.value.trim();if (!text) continue;
        override[key] = numeric.includes(key) ? Number(text) : flags.includes(key) ? text === "true" : arrays.includes(key) ? text === "[]" ? [] : text.split(/[,，]\s*/).filter(Boolean) : text;
      }
      model.capabilities = override;delete model.context_window;delete model.reasoning_efforts;modelRows();detail.hidden = true;message("cap_details_draft");
    });advanced.append(save);
  }
  function syncPreview(preview) {
    const c = client(editingClient), result = el("connection-sync-result");result.hidden = false;result.replaceChildren();
    const table = node("table"), head = node("tr");for (const key of ["model", "cap_context", "cap_current_budget", "cap_proposed_budget", "cap_reasoning", "cap_search"]) { const cell = node("th");words(cell, key);head.append(cell); }
    const thead = node("thead"), body = node("tbody");thead.append(head);table.append(thead, body);
    for (const item of c.model_plan?.available || []) if (bindingSelection.has(bindingKey(item.source, item.id))) {
      const values = item.capability?.values || {}, row = node("tr"), proposed = preview?.models.find(model => model.id === item.id && model.source === item.source);
      row.append(node("td", item.id), node("td", count(values.context_window)), node("td", count(preview?.current?.budgets?.[proposed?.public_id])),
        node("td", count(preview?.shared?.budgets?.[proposed?.public_id])), node("td", reasoningText(values)), node("td", searchText(values)));body.append(row);
    }
    const wrap = node("div", undefined, "table-wrap");wrap.append(table);result.append(wrap);
    const note = node("p", undefined, "hint");words(note, "cap_preview_scope");result.append(note);
    const sync = preview?.shared || c.model_plan?.sync;
    if (c.credential_state === "encrypted_unverified") { const kept = node("p", undefined, "hint");words(kept, "client_key_encrypted_kept");result.append(kept); }
    if (sync) { const status = node("p", undefined, "hint");words(status, "cap_sync_" + sync.state);result.append(status);
      for (const limitation of sync.limitations || []) { const line = node("p", undefined, "hint");words(line, "cap_limit_" + limitation.code);if (limitation.model) line.prepend(limitation.model + ": ");result.append(line); }
    }
  }
  function modelRows() {
    closeModelDetail();
    const body = el("connection-models");body.replaceChildren();
    for (const model of models) {
      const tr = node("tr"), name = node("td"), apis = node("td"), actions = node("td"), group = node("div", undefined, "connection-checks");
      tr.dataset.model = model.id;
      const selection = check("selected-model", model.id, selectedModels.has(model.id), model.id);
      selection.firstChild.addEventListener("change", e => { if (e.target.checked) selectedModels.add(model.id);else selectedModels.delete(model.id); });name.append(selection);
      const maker = model.display || source(editing)?.model_display?.[model.id];
      if (maker?.publisher || maker?.vendor) name.append(node("span", maker.publisher || maker.vendor, "model-maker"));
      for (const protocol of ["messages", "responses", "chat"]) {
        const label = check("model-api", protocol, model.protocols.includes(protocol), protocol === "chat" ? "Chat" : protocol === "messages" ? "Messages" : "Responses");
        label.firstChild.disabled = !apiForm.querySelector(`[name="protocol"][value="${protocol}"]`).checked;
        label.firstChild.addEventListener("change", e => {
          model.protocols = [...new Set([...model.protocols.filter(api => api !== protocol), ...(e.target.checked ? [protocol] : [])])];
          if (e.target.checked) { selectedModels.add(model.id);selection.firstChild.checked = true; }
        });group.append(label);
      }
      const capability = resolved(model);
      const context = node("td", count(capability.context_window)), reasoning = node("td", reasoningText(capability)), search = node("td", searchText(capability));
      const details = button("cap_details", () => modelDetail(model, tr, details));
      details.dataset.modelDetails = "";
      details.setAttribute("aria-expanded", "false");
      details.setAttribute("aria-controls", "connection-model-detail");
      apis.append(group);actions.append(details, button("api_remove_model", () => { models = models.filter(item => item !== model);selectedModels.delete(model.id);modelRows(); }));tr.append(name, apis, context, reasoning, search, actions);body.append(tr);
    }
  }
  function setEndpoints(base, endpoints) { for (const [api, path] of [["messages", "messages"], ["responses", "responses"], ["chat", "chat/completions"]]) apiForm.elements[api + "_url"].value = endpoints?.[api] || base.replace(/\/+$/, "") + "/" + path; }
  function editApi(provider) {
    stopDiscovery();editorOrigin = document.activeElement;editing = provider?.id || null;panels("api");apiForm.reset();words(el("connection-editor-title"), provider ? "api_manage" : "api_add");
    apiForm.elements.name.value = provider?.name || "";apiForm.elements.base.value = provider?.base_url || "";
    apiForm.elements.key.required = !provider;globalThis.ccdxLanguage.set(apiForm.elements.key, provider ? "api_key_keep" : "api_key_enter", {}, "placeholder");
    apiForm.elements.auth_header.value = provider?.auth_header || "x-api-key";
    apiForm.elements.key_env.value = provider?.key_env || "";keyMode();
    for (const input of apiForm.querySelectorAll('[name="protocol"]')) input.checked = provider ? Boolean(provider.endpoints?.[input.value]) : input.value !== "chat";
    setEndpoints(provider?.base_url || "", provider?.endpoints);
    const allowed = el("connection-allowed-clients");allowed.replaceChildren(...data.clients.filter(c => c.enabled).map(c => check("allowed", c.id, c.allowed.includes(editing), c.name)));
    el("connection-model-detail").hidden = true;
    models = structuredClone(provider?.models || []);selectedModels = new Set(models.map(model => model.id));modelRows();el("connection-manual-model").open = false;el("connection-discover").disabled = !editing;el("connection-model-id").value = "";apiForm.elements.name.focus();
    words(apiForm.querySelector('button[type="submit"]'), provider ? "api_save" : "api_save_read");
  }
  apiForm.elements.base.addEventListener("change", () => setEndpoints(apiForm.elements.base.value));
  for (const input of apiForm.querySelectorAll('[name="protocol"]')) input.addEventListener("change", () => {
    const available = new Set([...apiForm.querySelectorAll('[name="protocol"]:checked')].map(item => item.value));
    for (const model of models) model.protocols = model.protocols.filter(api => available.has(api));modelRows();
  });
  function keyMode() { const external = Boolean(apiForm.elements.key_env.value.trim());apiForm.elements.key.disabled = external;apiForm.elements.key.required = !external && !editing;if (external) apiForm.elements.key.value = ""; }
  apiForm.elements.key_env.addEventListener("input", keyMode);
  apiForm.addEventListener("submit", e => {
    e.preventDefault();if (busy || !apiForm.reportValidity()) return;
    const chosenModels = models.filter(model => selectedModels.has(model.id)).map(({ display, ...model }) => model);
    const invalid = chosenModels.find(model => !model.protocols.length);
    if (invalid) {
      message("api_model_protocol_required", { model: invalid.id });
      [...el("connection-models").children].find(row => row.dataset.model === invalid.id)?.querySelector('input[name="model-api"]:not(:disabled)')?.focus();return;
    }
    const endpoints = Object.fromEntries([...apiForm.querySelectorAll('[name="protocol"]:checked')].map(input => [input.value, apiForm.elements[input.value + "_url"].value.trim()]));
    const key = apiForm.elements.key.value;apiForm.elements.key.value = "";
    const first = !editing;
    const input = { operation: "save_api", ...(editing ? { id: editing } : {}), key,
      config: { name: apiForm.elements.name.value.trim(), base_url: apiForm.elements.base.value.trim().replace(/\/+$/, ""), endpoints, auth_header: apiForm.elements.auth_header.value, models: chosenModels,
        ...(apiForm.elements.key_env.value.trim() ? { key_env: apiForm.elements.key_env.value.trim() } : {}) },
      allowed: [...apiForm.querySelectorAll('[name="allowed"]:checked')].map(input => input.value).concat(data.clients.filter(c => !c.enabled && c.allowed.includes(editing)).map(c => c.id)) };
    void (async () => {
      const saved = await change(input, first ? result => { const provider = result.providers.find(p => !p.builtin && p.name === input.config.name);if (provider) editApi(provider); } : undefined);
      if (saved && first && editing) await discoverModels();
    })();
  });
  el("connection-model-add").addEventListener("click", () => {
    const id = el("connection-model-id").value.trim();if (!id || models.some(model => model.id === id) || models.length >= 500) return;
    models.push({ id, protocols: [] });selectedModels.add(id);el("connection-model-id").value = "";modelRows();
  });
  function stopDiscovery() {
    const previous = discovery;if (!previous) return;discovery = null;previous.controller.abort();
    const cancelled = api({ operation: "cancel_discovery", id: previous.id }).catch(() => {});
    el("connection-discover").disabled = !editing;el("connection-discover").removeAttribute("aria-busy");words(el("connection-discover"), "api_read_models");el("connection-discover-cancel").hidden = true;return cancelled;
  }
  el("connection-discover-cancel").addEventListener("click", () => { stopDiscovery();message("api_read_cancelled");el("connection-discover").focus(); });
  async function discoverModels() {
    if (discovery || !editing) return;
    const read = { id: editing, controller: new AbortController() };discovery = read;
    const trigger = el("connection-discover");trigger.disabled = true;trigger.setAttribute("aria-busy", "true");words(trigger, "api_reading");el("connection-discover-cancel").hidden = false;
    try {
      const result = await api({ operation: "discover", id: read.id }, read.controller.signal);if (discovery !== read || editing !== read.id) return;
      data = result;
      const known = new Map(models.map(model => [model.id, model]));for (const model of result.discovered || []) { const previous = known.get(model.id);known.set(model.id, previous ? { ...previous, ...(model.display ? { display: model.display } : {}), ...(model.metadata ? { metadata: model.metadata } : {}) } : model); }
      models = [...known.values()].slice(0, 500);modelRows();message("api_models_read");
    } catch (error) { if (discovery === read) message("api_read_failed", { code: error.message }); }
    finally { if (discovery === read) { discovery = null;trigger.disabled = false;trigger.removeAttribute("aria-busy");words(trigger, "api_read_models");el("connection-discover-cancel").hidden = true; } }
  }
  el("connection-discover").addEventListener("click", () => void discoverModels());
  function memoryMatches(item) {
    const model = client("codex")?.memory_model?.model;
    return Boolean(model && [item.id, item.model, item.route_id, item.public_id].includes(model));
  }
  function memoryRender() {
    const area = el("connection-memory-model");if (!area || !data) return;
    area.hidden = editingClient !== "codex";if (area.hidden) return;
    const c = client("codex"), dep = c.memory_model || {};
    el("connection-memory-name").textContent = dep.model || format(dep.enabled === true ? "memory_codex_default" : dep.enabled === false ? "memory_generation_off" : "memory_not_detected");
    words(el("connection-memory-basis"), dep.model ? `memory_basis_${dep.basis}` : dep.enabled === true ? "memory_default_unknown" : "");
    const selected = (c.deployments || c.model_plan?.models || []).some(memoryMatches);
    const draft = dep.model && [...bindingSelection].some(key => {
      const [source, id] = key.split("\0");return memoryMatches({ id, route_id: c.model_plan?.available?.find(x => x.source === source && x.id === id)?.route_id });
    });
    const pending = bindingDirty && Boolean(draft) !== selected;
    const label = !dep.model ? "memory_not_detected" : dep.enabled === false ? "memory_generation_off" : pending ? draft ? "memory_pending_on" : "memory_pending_off" : selected ? "memory_model_on" : "memory_model_off";
    const state = el("connection-memory-state");state.hidden = !dep.model;
    if (globalThis.ccdxIcons) globalThis.ccdxIcons.set(state, label, dep.enabled === false ? "unavailable" : !selected || pending && !draft ? "warning" : "ok");else words(state, label);
    const warning = el("connection-memory-warning");warning.hidden = !dep.model || dep.enabled === false || selected && !pending;
    words(warning, selected && pending && !draft ? "memory_pending_warning" : "memory_off_warning");
  }
  function confirmMemory(action) {
    memoryAction = action;memoryOrigin = document.activeElement;
    el("connection-memory-confirm").showModal();el("connection-memory-keep").focus();
  }
  function closeMemory(confirm) {
    const action = memoryAction;memoryAction = null;el("connection-memory-confirm").close();
    if (confirm) action?.();else if (memoryOrigin?.isConnected) memoryOrigin.focus();
  }
  el("connection-memory-keep").addEventListener("click", () => closeMemory(false));
  el("connection-memory-close").addEventListener("click", () => closeMemory(true));
  el("connection-memory-confirm").addEventListener("cancel", () => { memoryAction = null; });
  const bindingKey = (source, model) => source + "\0" + model;
  const routeId = item => item.route_id || item.public_id;
  function rememberDraft() {
    if (editingClient && bindingDirty) drafts.set(editingClient, { selection: new Set(bindingSelection), defaultModel: bindingDefault, autoSync: el("connection-auto-sync").checked });
  }
  function mountClient(force = false) {
    if (!data) return;
    const route = location.hash.slice(1), id = route === "claude" ? claudeClient : "codex";
    if (!["codex", "claude"].includes(route)) return;
    rememberDraft();
    const mount = el(route === "claude" ? "claude-model-management" : "codex-model-management");
    mount.append(el("connection-clients"), el("connection-client-editor"));
    const c = client(id);el("connection-client-editor").hidden = !c.enabled;
    if (editingClient !== id || force || !bindingDirty) {
      editingClient = id;const draft = drafts.get(id);bindingDirty = Boolean(draft);
      const selected = Array.isArray(c.deployments) ? c.deployments : (c.model_plan?.models || []).map(model => ({ source: model.source, model: model.id }));
      bindingSelection = draft ? new Set(draft.selection) : new Set(selected.map(item => bindingKey(item.source, item.model)));
      bindingDefault = draft ? draft.defaultModel : c.default_model || c.model_plan?.models.find(model => model.public_id === c.model_plan?.default_model)?.route_id || null;
      el("connection-auto-sync").checked = draft ? draft.autoSync : c.auto_sync !== false;
      el("connection-sync-result").hidden = true;el("connection-client-note").textContent = "";
    }
    bindingRows(document.activeElement?.name === "binding-model" ? { kind: "selection", key: document.activeElement.value } : document.activeElement?.dataset.binding ? { kind: "default", key: document.activeElement.dataset.binding } : null);words(el("connection-client-title"), "cap_visible_model");list();
  }
  function bindingRows(focus) {
    memoryRender();
    el("connection-client-cancel").disabled = !bindingDirty;
    const body = el("connection-bindings"), c = client(editingClient);body.replaceChildren();
    const available = c.model_plan?.available || [], availableKeys = new Set(available.map(item => bindingKey(item.source, item.id)));
    const missing = [...bindingSelection].filter(key => !availableKeys.has(key)).map(key => { const [source, id] = key.split("\0"), saved = c.model_plan?.unavailable?.find(item => item.source === source && item.id === id);return { source, id, route_id: saved?.route_id, reason: saved?.reason, unavailable: true }; });
    for (const item of [...available, ...missing]) {
      const key = bindingKey(item.source, item.id), row = node("tr"), name = node("td"), capability = item.capability?.values || {};
      const selection = check("binding-model", key, bindingSelection.has(key), item.display_name || item.id);
      selection.firstChild.addEventListener("change", event => {
        const checked = event.target.checked;
        const apply = () => {
          bindingDirty = true;if (checked) { bindingSelection.add(key);bindingDefault ||= routeId(item); }
          else { bindingSelection.delete(key);if (bindingDefault === routeId(item) || !bindingSelection.size) bindingDefault = null; }
          rememberDraft();bindingRows({ kind: "selection", key });
        };
        if (!checked && editingClient === "codex" && client("codex").memory_model?.enabled !== false && memoryMatches(item)) { event.target.checked = true;confirmMemory(apply); }
        else apply();
      });name.append(selection);
      if (editingClient === "codex" && memoryMatches(item)) { const badge = node("span", undefined, "memory-model-badge");words(badge, "memory_extract_role");name.append(badge); }
      const action = button(bindingDefault === routeId(item) && bindingSelection.has(key) ? "cap_default" : "cap_set_default", () => { bindingDirty = true;bindingSelection.add(key);bindingDefault = routeId(item);rememberDraft();bindingRows({ kind: "default", key }); });
      action.setAttribute("aria-pressed", String(bindingDefault === routeId(item) && bindingSelection.has(key)));
      action.dataset.binding = key;action.disabled = Boolean(item.unavailable);action.setAttribute("aria-label", item.id + " · " + format(bindingDefault === routeId(item) ? "cap_default" : "cap_set_default"));
      if (item.unavailable) { const warning = node("span", undefined, "hint binding-unavailable");words(warning, item.reason ? "visibility_" + item.reason : "cap_model_unavailable");name.append(warning); }
      const cell = node("td");cell.append(action);
      const details = [node("td", source(item.source)?.name || item.source), node("td", count(capability.context_window)), node("td", reasoningText(capability))];
      details.forEach((cell, i) => cell.dataset.label = format(["source", "cap_context", "cap_reasoning"][i]));
      row.append(name, ...details, cell);body.append(row);
    }
    const unavailableDefault = bindingSelection.size > 0 && !available.some(item => routeId(item) === bindingDefault && bindingSelection.has(bindingKey(item.source, item.id)));
    const warning = el("connection-default-note");warning.hidden = !unavailableDefault;words(warning, "cap_default_unavailable");
    clientForm.querySelector('button[type="submit"]').disabled = unavailableDefault || busy;
    words(el("connection-draft-state"), bindingDirty ? "cap_unsaved" : "cap_saved");
    const setup = c.setup || "not_configured", syncKey = setup === "configured" ? "sync_config_written" : setup === "manual_sync" ? "sync_manual"
      : ["preserved", "partially_preserved"].includes(setup) ? "sync_preserved" : setup === "configuration_unavailable" ? "sync_failed"
        : setup === "default_unavailable" ? "cap_default_unavailable" : "sync_not_configured";
    globalThis.ccdxIcons.set(el("connection-setup-state"), syncKey, setup === "configured" ? "ok" : ["configuration_unavailable", "default_unavailable"].includes(setup) ? "warning" : "unavailable");
    const capabilityNote = el("connection-capability-state");capabilityNote.hidden = !c.model_plan?.sync?.limitations?.some(item => item.code === "client_version_unknown");
    if (!capabilityNote.hidden) words(capabilityNote, "sync_capability_unverified");
    words(clientForm.querySelector('button[type="submit"]'), el("connection-auto-sync").checked ? "cap_save_sync" : "api_save");
    if (focus) { const selector = focus.kind === "selection" ? 'input[name="binding-model"]' : 'button[data-binding]';[...body.querySelectorAll(selector)].find(input => (input.value || input.dataset.binding) === focus.key)?.focus(); }
    if (!body.children.length) { const row = node("tr"), cell = node("td");cell.colSpan = 5;words(cell, "cap_no_models");const link = node("a");link.href = "#models";words(link, "model_services");cell.append(" ", link);row.append(cell);body.append(row); }
  }
  function editClient(c) { location.hash = c.id === "codex" ? "codex" : "claude";if (c.id !== "codex") claudeClient = c.id;mountClient(true); }
  for (const segment of document.querySelectorAll("[data-claude-client]")) segment.addEventListener("click", () => {
    rememberDraft();claudeClient = segment.dataset.claudeClient;
    for (const button of document.querySelectorAll("[data-claude-client]")) button.setAttribute("aria-pressed", String(button === segment));mountClient(true);
  });
  el("connection-auto-sync").addEventListener("change", () => { bindingDirty = true;rememberDraft();el("connection-client-cancel").disabled = false;words(el("connection-draft-state"), "cap_unsaved");words(clientForm.querySelector('button[type="submit"]'), el("connection-auto-sync").checked ? "cap_save_sync" : "api_save"); });
  el("connection-client-cancel").addEventListener("click", () => { drafts.delete(editingClient);bindingDirty = false;mountClient(true); });
  function bindingInput(operation) {
    const c = client(editingClient);return { operation, id: c.id, enabled: true, allowed: c.allowed,
      deployments: [...bindingSelection].map(key => { const [source, model] = key.split("\0");return { source, model }; }),
      default_model: bindingDefault, auto_sync: el("connection-auto-sync").checked };
  }
  clientForm.addEventListener("submit", event => { event.preventDefault();void change(bindingInput("client")); });
  el("connection-sync-preview").addEventListener("click", () => void change(bindingInput("preview_client"), result => syncPreview(result.preview)));
  function disableSource(provider, confirmed = false) {
    const c = client("codex");
    if (!confirmed && c?.enabled && c.memory_model?.enabled !== false && c.model_plan?.models.some(item => item.source === provider.id && memoryMatches(item))) {
      confirmMemory(() => disableSource(provider, true));return;
    }
    const impact = data.source_impacts?.[provider.id];
    if (!impact) { message("api_impact_unavailable");void load();return; }
    const affected = impact.clients;disableRevision = impact.revision;
    if (!affected.length) { void change({ operation: "provider", id: provider.id, enabled: false, impact_revision: disableRevision });return; }
    disabling = provider.id;panels("disable");const area = el("connection-replacements");area.replaceChildren();
    for (const item of affected) {
      const c = client(item.id), section = node("div", undefined, "source-impact");section.append(node("strong", c.name));
      const count = node("p");words(count, "api_impact_models", { before: item.removed + item.remaining, after: item.remaining, removed: item.removed });section.append(count);
      const note = node("p", undefined, "hint");words(note, item.needs_replacement ? "api_choose_replacements" : "api_impact_default_kept");section.append(note);
      if (item.needs_replacement) { const label = node("label"), select = choice(data.providers.filter(p => p.id !== provider.id && p.enabled && c.allowed.includes(p.id) && selectableSource(p, c.id)));select.name = c.id;select.setAttribute("aria-label", c.name);label.append(select);section.append(label); }
      area.append(section);
    }
  }
  el("connection-disable-form").addEventListener("submit", e => { e.preventDefault();void change({ operation: "provider", id: disabling, enabled: false,
    impact_revision: disableRevision,
    replacements: Object.fromEntries([...el("connection-replacements").querySelectorAll("select")].map(select => [select.name, select.value || null])) }); });
  el("connection-add").addEventListener("click", () => { if (data) editApi(); });
  for (const id of ["connection-cancel", "connection-disable-cancel"]) el(id).addEventListener("click", () => { panels();(editorOrigin?.isConnected ? editorOrigin : el("connection-source-list").querySelector("button") || el("connection-add")).focus(); });
  el("refresh").addEventListener("click", () => { if (["#models", "#codex", "#claude"].includes(location.hash)) void load(); });
  window.addEventListener("hashchange", () => { apiForm.elements.key.value = "";mountClient();if (["#models", "#claude", "#codex"].includes(location.hash)) void load(); });
  window.addEventListener("ccdx:choose-source", event => { if (typeof event.detail?.id === "string" && providerEntries.some(p => p.id === event.detail.id)) chooseProvider(event.detail.id); });
  window.addEventListener("ccdx:source-view", () => { if (data) list(); });
  window.addEventListener("ccdx:providers", () => { if (desiredSource && providerEntries.some(p => p.id === desiredSource)) { const id = desiredSource;desiredSource = null;chooseProvider(id); }if (data) list(); });
  new MutationObserver(() => { if (data) list(); }).observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
  globalThis.ccdxConnections = { load,
    updateMemory(snapshot) { const c = snapshot?.clients?.find(c => c.id === "codex");if (data && c?.memory_model) { client("codex").memory_model = c.memory_model;memoryRender(); } }, editClient: id => { if (data && client(id)) { editClient(client(id)); } } };
  for (const button of document.querySelectorAll("[data-client-access]")) button.addEventListener("click", () => globalThis.ccdxConnections.editClient(button.dataset.clientAccess));
  void load();
})();
