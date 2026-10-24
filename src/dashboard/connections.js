(() => {
  const el = id => document.getElementById(id), root = el("connection-sources");if (!root) return;
  const words = (node, key, args) => globalThis.ccdxLanguage.set(node, key, args), format = key => globalThis.ccdxLanguage.format(key);
  let data = null, editing = null, editingClient = null, disabling = null, models = [], selectedModels = new Set(), busy = false, generation = 0;
  let claudeClient = "claude_app", bindingSelection = new Set(), bindingDefault = null, bindingDirty = false;
  const apiForm = el("connection-api-form"), clientForm = el("connection-client-form");
  const node = (tag, text, className) => { const item = document.createElement(tag);if (text !== undefined) item.textContent = text;if (className) item.className = className;return item; };
  const source = id => data.providers.find(item => item.id === id), client = id => data.clients.find(item => item.id === id);
  const compatible = (provider, id) => provider.protocols.includes(id === "codex" ? "responses" : "messages");
  const selectableSource = (provider, id) => compatible(provider, id)
    && (provider.builtin || provider.models?.some(model => model.protocols.includes(id === "codex" ? "responses" : "messages")));
  const message = (key, values) => words(el("connection-note"), key, values);
  function button(key, action) { const item = node("button");item.type = "button";words(item, key);item.addEventListener("click", action);return item; }
  function check(name, value, checked, text) { const label = node("label"), input = node("input");input.type = "checkbox";input.name = name;input.value = value;input.checked = checked;label.append(input, node("span", text));return label; }
  async function api(input) {
    const response = await fetch("/_ccdx/ui/connections", { method: input ? "POST" : "GET", headers: { "X-CCDX-Dashboard": "1", ...(input ? { "Content-Type": "application/json" } : {}) },
      cache: "no-store", signal: AbortSignal.timeout(35000), ...(input ? { body: JSON.stringify(input) } : {}) });
    const result = await response.json();if (!response.ok) throw new Error(result.error || "ccdx_connections_action_failed");
    if (result.source !== "connections" || !Array.isArray(result.providers) || !Array.isArray(result.clients)) throw new Error("ccdx_connections_unavailable");return result;
  }
  function panels(which = "list") {
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
        actions.append(button(provider.builtin ? "api_account" : "api_manage", () => provider.builtin ? (location.hash = "models", window.dispatchEvent(new CustomEvent("ccdx:choose-source", { detail: { id: provider.id } }))) : editApi(provider)));
        const toggle = node("input");toggle.type = "checkbox";toggle.checked = true;toggle.setAttribute("role", "switch");toggle.setAttribute("aria-label", format("api_disable_source") + " " + provider.name);
        toggle.addEventListener("change", () => { toggle.checked = true;disableSource(provider); });actions.append(toggle);
      } else actions.append(button("api_restore", () => void change({ operation: "provider", id: provider.id, enabled: true })));
      row.append(info, actions);(provider.enabled ? providerList : disabledSources).append(row);
    }
    const current = editingClient && client(editingClient);
    if (current) {
      const row = node("div", undefined, "connection-row"), title = node("h3", current.name), toggle = node("input");
      toggle.type = "checkbox";toggle.checked = current.enabled;toggle.setAttribute("role", "switch");toggle.setAttribute("aria-label", current.name);
      toggle.addEventListener("change", () => void change({ operation: "client", id: current.id, enabled: toggle.checked,
        source: toggle.checked ? current.source : null, allowed: current.allowed, ...(Array.isArray(current.deployments) ? { deployments: current.deployments, default_model: current.default_model, auto_sync: current.auto_sync } : {}) }));
      row.append(title, toggle);clientList.append(row);
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
  }
  async function load() {
    if (busy) return;const current = ++generation;
    try { const result = await api();if (current !== generation) return;data = result;mountClient();list(); }
    catch (error) { message(error.message); }
  }
  async function change(input, done) {
    if (busy) return;busy = true;generation++;const view = document.querySelector(`[data-view="${location.hash.slice(1)}"]`);view?.setAttribute("aria-busy", "true");
    try { data = await api(input);if (input.operation === "client") bindingDirty = false;mountClient();list();done?.(data);if (!done) {
      panels();let key = input.operation === "save_api" ? "api_config_saved" : input.operation === "provider" ? input.enabled ? "api_provider_enabled" : "api_provider_disabled"
        : !input.enabled ? "api_client_disabled" : !input.source ? "api_client_enabled" : "api_saved";
      const setup = data.clients.find(c => c.id === input.id)?.setup;
      if (input.operation === "client" && input.source && ["preserved", "partially_preserved"].includes(setup)) key = "api_client_preserved";
      if (input.operation === "client" && input.source && setup === "configuration_unavailable") key = "api_client_config_failed";
      if (input.operation === "client" && input.source && setup === "not_installed") key = "api_client_not_installed";
      if (input.operation === "client") words(el("connection-client-note"), key);else message(key);
    }window.dispatchEvent(new CustomEvent("ccdx:connections"));void dashboardRefresh.refresh("auth", { force: true });void dashboardRefresh.refresh("status", { force: true }); }
    catch (error) { if (input.operation === "client") words(el("connection-client-note"), error.message);else message(error.message); }
    finally { busy = false;view?.removeAttribute("aria-busy"); }
  }
  const resolved = model => ({ ...(model.metadata?.deployment === source(editing)?.deployment_revision ? model.metadata.values : {}), ...(model.context_window === undefined ? {} : { context_window: model.context_window }),
    ...(model.reasoning_efforts === undefined ? {} : { reasoning_efforts: model.reasoning_efforts }), ...(model.capabilities || {}) });
  const count = value => !value ? format("cap_unknown") : value >= 1000000 ? `${Number((value / 1000000).toFixed(2))}M` : value >= 1000 ? `${Number((value / 1000).toFixed(1))}K` : String(value);
  const reasoningText = values => values.reasoning === false ? format("cap_unsupported") : values.reasoning_efforts?.length ? values.reasoning_efforts.join(" / ") : values.reasoning === true ? format("cap_supported") : format("cap_unknown");
  const searchText = values => values.web_search === undefined ? format("cap_unknown") : values.web_search.length ? values.web_search.map(protocol => protocol === "messages" ? "Messages" : protocol === "responses" ? "Responses" : "Chat").join(" / ") : format("cap_unsupported");
  function modelDetail(model) {
    const detail = el("connection-model-detail");detail.hidden = false;detail.replaceChildren();
    const heading = node("div", undefined, "panel-heading");heading.append(node("h3", model.id), button("close", () => { detail.hidden = true; }));detail.append(heading);
    const note = node("p", undefined, "hint");words(note, "cap_metadata_scope");detail.append(note);
    const fields = node("div", undefined, "connection-fields"), values = resolved(model);
    const numeric = ["context_window", "max_input_tokens", "max_output_tokens", "reasoning_budget_min", "reasoning_budget_max"];
    const flags = ["reasoning", "reasoning_required", "reasoning_adaptive", "tools", "parallel_tools", "streaming", "structured_output"];
    const arrays = ["reasoning_efforts", "input_modalities", "web_search"];
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
      if (input.tagName === "INPUT") input.placeholder = values[key] === undefined ? format("cap_unknown") : Array.isArray(values[key]) ? values[key].join(", ") : String(values[key]);
      const evidence = node("span", undefined, "hint");words(evidence, manual !== undefined ? "cap_manual" : model.metadata?.deployment === source(editing)?.deployment_revision && model.metadata?.values[key] !== undefined ? "cap_catalog" : "cap_unknown");label.append(input, evidence);fields.append(label);
    }
    detail.append(fields);
    const save = button("cap_apply_details", () => {
      const override = {};
      for (const input of fields.querySelectorAll("[data-capability]")) {
        const key = input.dataset.capability, text = input.value.trim();if (!text) continue;
        override[key] = numeric.includes(key) ? Number(text) : flags.includes(key) ? text === "true" : arrays.includes(key) ? text === "[]" ? [] : text.split(/[,，]\s*/).filter(Boolean) : text;
      }
      model.capabilities = override;delete model.context_window;delete model.reasoning_efforts;modelRows();detail.hidden = true;message("cap_details_draft");
    });detail.append(save);detail.scrollIntoView({ block: "nearest", behavior: "auto" });
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
    if (sync) { const status = node("p", undefined, "hint");words(status, "cap_sync_" + sync.state);result.append(status);
      for (const limitation of sync.limitations || []) { const line = node("p", undefined, "hint");words(line, "cap_limit_" + limitation.code);if (limitation.model) line.prepend(limitation.model + ": ");result.append(line); }
    }
  }
  function modelRows() {
    const body = el("connection-models");body.replaceChildren();
    for (const model of models) {
      const tr = node("tr"), name = node("td"), apis = node("td"), actions = node("td"), group = node("div", undefined, "connection-checks");
      tr.dataset.model = model.id;
      const selection = check("selected-model", model.id, selectedModels.has(model.id), model.id);
      selection.firstChild.addEventListener("change", e => { if (e.target.checked) selectedModels.add(model.id);else selectedModels.delete(model.id); });name.append(selection);
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
      apis.append(group);actions.append(button("cap_details", () => modelDetail(model)), button("api_remove_model", () => { models = models.filter(item => item !== model);selectedModels.delete(model.id);modelRows(); }));tr.append(name, apis, context, reasoning, search, actions);body.append(tr);
    }
  }
  function setEndpoints(base, endpoints) { for (const [api, path] of [["messages", "messages"], ["responses", "responses"], ["chat", "chat/completions"]]) apiForm.elements[api + "_url"].value = endpoints?.[api] || base.replace(/\/+$/, "") + "/" + path; }
  function editApi(provider) {
    editing = provider?.id || null;panels("api");apiForm.reset();words(el("connection-editor-title"), provider ? "api_manage" : "api_add");
    apiForm.elements.name.value = provider?.name || "";apiForm.elements.base.value = provider?.base_url || "";
    apiForm.elements.key.required = !provider;globalThis.ccdxLanguage.set(apiForm.elements.key, provider ? "api_key_keep" : "api_key_enter", {}, "placeholder");
    apiForm.elements.auth_header.value = provider?.auth_header || "x-api-key";
    apiForm.elements.key_env.value = provider?.key_env || "";keyMode();
    for (const input of apiForm.querySelectorAll('[name="protocol"]')) input.checked = provider ? provider.protocols.includes(input.value) : input.value !== "chat";
    setEndpoints(provider?.base_url || "", provider?.endpoints);
    const allowed = el("connection-allowed-clients");allowed.replaceChildren(...data.clients.filter(c => c.enabled).map(c => check("allowed", c.id, c.allowed.includes(editing), c.name)));
    el("connection-model-detail").hidden = true;
    models = structuredClone(provider?.models || []);selectedModels = new Set(models.map(model => model.id));modelRows();el("connection-manual-model").open = false;el("connection-discover").disabled = !editing;el("connection-model-id").value = "";
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
    const chosenModels = models.filter(model => selectedModels.has(model.id));
    const invalid = chosenModels.find(model => !model.protocols.length);
    if (invalid) {
      message("api_model_protocol_required", { model: invalid.id });
      [...el("connection-models").children].find(row => row.dataset.model === invalid.id)?.querySelector('input[name="model-api"]:not(:disabled)')?.focus();return;
    }
    const endpoints = Object.fromEntries([...apiForm.querySelectorAll('[name="protocol"]:checked')].map(input => [input.value, apiForm.elements[input.value + "_url"].value.trim()]));
    const key = apiForm.elements.key.value;apiForm.elements.key.value = "";
    void change({ operation: "save_api", ...(editing ? { id: editing } : {}), key,
      config: { name: apiForm.elements.name.value.trim(), base_url: apiForm.elements.base.value.trim().replace(/\/+$/, ""), endpoints, auth_header: apiForm.elements.auth_header.value, models: chosenModels,
        ...(apiForm.elements.key_env.value.trim() ? { key_env: apiForm.elements.key_env.value.trim() } : {}) },
      allowed: [...apiForm.querySelectorAll('[name="allowed"]:checked')].map(input => input.value).concat(data.clients.filter(c => !c.enabled && c.allowed.includes(editing)).map(c => c.id)) });
  });
  el("connection-model-add").addEventListener("click", () => {
    const id = el("connection-model-id").value.trim();if (!id || models.some(model => model.id === id) || models.length >= 500) return;
    models.push({ id, protocols: [] });selectedModels.add(id);el("connection-model-id").value = "";modelRows();
  });
  el("connection-discover").addEventListener("click", () => void change({ operation: "discover", id: editing }, result => {
    const known = new Map(models.map(model => [model.id, model]));for (const model of result.discovered || []) { const previous = known.get(model.id);known.set(model.id, previous ? { ...previous, ...(model.metadata ? { metadata: model.metadata } : {}) } : model); }
    models = [...known.values()].slice(0, 500);modelRows();message("api_models_read");
  }));
  const bindingKey = (source, model) => source + "\0" + model;
  const routeId = item => item.route_id || item.public_id;
  function mountClient(force = false) {
    if (!data) return;
    const route = location.hash.slice(1), id = route === "claude" ? claudeClient : "codex";
    const mount = el(route === "claude" ? "claude-model-management" : "codex-model-management");
    if (!["codex", "claude"].includes(route)) return;
    mount.append(el("connection-clients"), el("connection-client-editor"));
    const c = client(id);el("connection-client-editor").hidden = !c.enabled;
    if (editingClient !== id || force || !bindingDirty) {
      editingClient = id;bindingDirty = false;
      const selected = Array.isArray(c.deployments) ? c.deployments : (c.model_plan?.models || []).map(model => ({ source: model.source, model: model.id }));
      bindingSelection = new Set(selected.map(item => bindingKey(item.source, item.model)));
      bindingDefault = c.default_model || c.model_plan?.models.find(model => model.public_id === c.model_plan?.default_model)?.route_id || null;
      el("connection-auto-sync").checked = c.auto_sync !== false;bindingRows();
      el("connection-sync-result").hidden = true;el("connection-client-note").textContent = "";
    }
    words(el("connection-client-title"), "cap_visible_model");list();
  }
  function bindingRows() {
    el("connection-client-cancel").disabled = !bindingDirty;
    const body = el("connection-bindings"), c = client(editingClient);body.replaceChildren();
    const available = c.model_plan?.available || [], availableKeys = new Set(available.map(item => bindingKey(item.source, item.id)));
    const missing = [...bindingSelection].filter(key => !availableKeys.has(key)).map(key => { const [source, id] = key.split("\0");return { source, id, unavailable: true }; });
    for (const item of [...available, ...missing]) {
      const key = bindingKey(item.source, item.id), row = node("tr"), name = node("td"), capability = item.capability?.values || {};
      const selection = check("binding-model", key, bindingSelection.has(key), item.id);
      selection.firstChild.addEventListener("change", event => {
        bindingDirty = true;if (event.target.checked) { bindingSelection.add(key);bindingDefault ||= routeId(item); }
        else { bindingSelection.delete(key);if (bindingDefault === routeId(item) || !available.some(entry => routeId(entry) === bindingDefault)) bindingDefault = available.find(entry => bindingSelection.has(bindingKey(entry.source, entry.id)))?.route_id || null; }
        bindingRows();
      });name.append(selection);
      const action = button(bindingDefault === routeId(item) && bindingSelection.has(key) ? "cap_default" : "cap_set_default", () => { bindingDirty = true;bindingSelection.add(key);bindingDefault = routeId(item);bindingRows(); });
      action.setAttribute("aria-pressed", String(bindingDefault === routeId(item) && bindingSelection.has(key)));
      const cell = node("td");if (item.unavailable) words(cell, "cap_model_unavailable");else cell.append(action);
      row.append(name, node("td", source(item.source)?.name || item.source), node("td", count(capability.context_window)), node("td", reasoningText(capability)), cell);body.append(row);
    }
    if (!body.children.length) { const row = node("tr"), cell = node("td");cell.colSpan = 5;words(cell, "cap_no_models");const link = node("a");link.href = "#models";words(link, "model_services");cell.append(" ", link);row.append(cell);body.append(row); }
  }
  function editClient(c) { location.hash = c.id === "codex" ? "codex" : "claude";if (c.id !== "codex") claudeClient = c.id;mountClient(true); }
  for (const segment of document.querySelectorAll("[data-claude-client]")) segment.addEventListener("click", () => {
    claudeClient = segment.dataset.claudeClient;bindingDirty = false;
    for (const button of document.querySelectorAll("[data-claude-client]")) button.setAttribute("aria-pressed", String(button === segment));mountClient(true);
  });
  el("connection-auto-sync").addEventListener("change", () => { bindingDirty = true;el("connection-client-cancel").disabled = false; });
  el("connection-client-cancel").addEventListener("click", () => mountClient(true));
  function bindingInput(operation) {
    const c = client(editingClient);return { operation, id: c.id, enabled: true, allowed: c.allowed,
      deployments: [...bindingSelection].map(key => { const [source, model] = key.split("\0");return { source, model }; }),
      default_model: bindingDefault, auto_sync: el("connection-auto-sync").checked };
  }
  clientForm.addEventListener("submit", event => { event.preventDefault();void change(bindingInput("client")); });
  el("connection-sync-preview").addEventListener("click", () => void change(bindingInput("preview_client"), result => syncPreview(result.preview)));
  function disableSource(provider) {
    const affected = data.clients.filter(c => c.enabled && c.source === provider.id);
    if (!affected.length) { void change({ operation: "provider", id: provider.id, enabled: false });return; }
    disabling = provider.id;panels("disable");const area = el("connection-replacements");area.replaceChildren();
    for (const c of affected) { const label = node("label", c.name), select = choice(data.providers.filter(p => p.id !== provider.id && p.enabled && c.allowed.includes(p.id) && selectableSource(p, c.id)));select.name = c.id;label.append(select);area.append(label); }
  }
  el("connection-disable-form").addEventListener("submit", e => { e.preventDefault();void change({ operation: "provider", id: disabling, enabled: false,
    replacements: Object.fromEntries([...el("connection-replacements").querySelectorAll("select")].map(select => [select.name, select.value || null])) }); });
  el("connection-add").addEventListener("click", () => { if (data) editApi(); });
  for (const id of ["connection-cancel", "connection-disable-cancel"]) el(id).addEventListener("click", () => panels());
  window.addEventListener("hashchange", () => { apiForm.elements.key.value = "";mountClient();if (["#models", "#claude", "#codex"].includes(location.hash)) void load(); });
  window.addEventListener("ccdx:choose-source", event => { if (typeof event.detail?.id === "string" && providerEntries.some(p => p.id === event.detail.id)) chooseProvider(event.detail.id); });
  new MutationObserver(() => { if (data) list(); }).observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
  globalThis.ccdxConnections = { load, editClient: id => { if (data && client(id)) { editClient(client(id)); } } };
  for (const button of document.querySelectorAll("[data-client-access]")) button.addEventListener("click", () => globalThis.ccdxConnections.editClient(button.dataset.clientAccess));
  void load();
})();
