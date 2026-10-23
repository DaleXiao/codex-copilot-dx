(() => {
  const el = id => document.getElementById(id), root = el("connection-sources");if (!root) return;
  const words = (node, key, args) => globalThis.ccdxLanguage.set(node, key, args), format = key => globalThis.ccdxLanguage.format(key);
  let data = null, editing = null, editingClient = null, disabling = null, models = [], selectedModels = new Set(), busy = false, generation = 0;
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
    root.hidden = el("connection-clients").hidden = el("connection-disabled").hidden = which !== "list";
    el("connection-editor").hidden = which !== "api";el("connection-client-editor").hidden = which !== "client";el("connection-disable-editor").hidden = which !== "disable";
    apiForm.elements.key.value = "";
  }
  function choice(options, selected, pause = true) {
    const select = node("select");if (pause) { const item = node("option");item.value = "";words(item, "api_pause");select.append(item); }
    for (const value of options) { const item = node("option", value.name);item.value = value.id;select.append(item); }select.value = selected || "";return select;
  }
  function list() {
    const providerList = el("connection-source-list"), clientList = el("connection-client-list"), disabledList = el("connection-disabled-list");
    providerList.replaceChildren();clientList.replaceChildren();disabledList.replaceChildren();
    for (const provider of data.providers) {
      const row = node("div", undefined, "connection-row"), info = node("div"), actions = node("div", undefined, "connection-actions");info.append(node("h3", provider.name));
      if (!provider.builtin) info.append(node("p", provider.base_url, "hint"));
      if (provider.enabled) {
        const allowed = data.clients.filter(c => c.enabled && c.allowed.includes(provider.id)).map(c => c.name).join(" / ");
        const line = node("p", undefined, "hint");words(line, "api_allowed_summary", { clients: allowed || format("api_none") });info.append(line);
        actions.append(button(provider.builtin ? "api_account" : "api_manage", () => provider.builtin ? (location.hash = "models", window.dispatchEvent(new CustomEvent("ccdx:choose-source", { detail: { id: provider.id } }))) : editApi(provider)));
        const toggle = node("input");toggle.type = "checkbox";toggle.checked = true;toggle.setAttribute("role", "switch");toggle.setAttribute("aria-label", format("api_disable_source") + " " + provider.name);
        toggle.addEventListener("change", () => { toggle.checked = true;disableSource(provider); });actions.append(toggle);
      } else actions.append(button("api_restore", () => void change({ operation: "provider", id: provider.id, enabled: true })));
      row.append(info, actions);(provider.enabled ? providerList : disabledList).append(row);
    }
    for (const c of data.clients) {
      const row = node("div", undefined, "connection-row"), info = node("div"), actions = node("div", undefined, "connection-actions");info.append(node("h3", c.name));
      const note = node("p", undefined, "hint");words(note, c.enabled ? "api_current_summary" : "api_client_disabled", { source: source(c.source)?.name || format("api_pause") });info.append(note);
      if (c.enabled) {
        actions.append(button("api_manage", () => editClient(c)));
        const toggle = node("input");toggle.type = "checkbox";toggle.checked = true;toggle.setAttribute("role", "switch");toggle.setAttribute("aria-label", format("api_close_client") + " " + c.name);
        toggle.addEventListener("change", () => { toggle.checked = true;void change({ operation: "client", id: c.id, enabled: false, source: null, allowed: c.allowed }); });actions.append(toggle);
      } else actions.append(button("api_restore", () => void change({ operation: "client", id: c.id, enabled: true, source: null, allowed: c.allowed })));
      row.append(info, actions);(c.enabled ? clientList : disabledList).append(row);
    }
    if (!disabledList.children.length) { const empty = node("p", undefined, "hint");words(empty, "api_no_disabled");disabledList.append(empty); }
    for (const route of ["codex", "claude"]) {
      const visible = route === "codex" ? client("codex").enabled : data.clients.some(c => c.enabled && c.id.startsWith("claude_"));
      const link = document.querySelector(`[data-route="${route}"]`);if (link) link.hidden = !visible;
      if (!visible && location.hash === "#" + route) location.hash = "system";
    }
    const m365Toggle = el("m365-enabled")?.closest(".setting-row");if (m365Toggle) m365Toggle.hidden = true;
    for (const link of document.querySelectorAll("[data-source-link]")) { const id = link.dataset.sourceLink;if (["m365", "github"].includes(id)) link.hidden = !source(id)?.enabled; }
    globalThis.ccdxConnectionNames = Object.fromEntries(data.providers.map(p => [p.id, p.name]));
  }
  async function load() {
    if (busy) return;const current = ++generation;
    try { const result = await api();if (current !== generation) return;data = result;list(); }
    catch (error) { if (location.hash === "#system") message(error.message); }
  }
  async function change(input, done) {
    if (busy) return;busy = true;generation++;root.closest("[data-view]").setAttribute("aria-busy", "true");
    try { data = await api(input);list();done?.(data);if (!done) {
      panels();let key = input.operation === "save_api" ? "api_config_saved" : input.operation === "provider" ? input.enabled ? "api_provider_enabled" : "api_provider_disabled"
        : !input.enabled ? "api_client_disabled" : !input.source ? "api_client_enabled" : "api_saved";
      const setup = data.clients.find(c => c.id === input.id)?.setup;
      if (input.operation === "client" && input.source && ["preserved", "partially_preserved"].includes(setup)) key = "api_client_preserved";
      if (input.operation === "client" && input.source && setup === "configuration_unavailable") key = "api_client_config_failed";
      if (input.operation === "client" && input.source && setup === "not_installed") key = "api_client_not_installed";
      message(key);
    }window.dispatchEvent(new CustomEvent("ccdx:connections"));void dashboardRefresh.refresh("auth", { force: true });void dashboardRefresh.refresh("status", { force: true }); }
    catch (error) { message(error.message); }
    finally { busy = false;root.closest("[data-view]").removeAttribute("aria-busy"); }
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
      apis.append(group);actions.append(button("api_remove_model", () => { models = models.filter(item => item !== model);selectedModels.delete(model.id);modelRows(); }));tr.append(name, apis, actions);body.append(tr);
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
    const known = new Map(models.map(model => [model.id, model]));for (const model of result.discovered || []) if (!known.has(model.id)) known.set(model.id, model);
    models = [...known.values()].slice(0, 500);modelRows();message("api_models_read");
  }));
  function clientModels() {
    const c = client(editingClient), provider = source(el("connection-current").value), selector = el("connection-current-model");
    el("connection-current-model-row").hidden = c.id !== "codex" || provider?.builtin !== false;
    selector.replaceChildren(...(provider?.models || []).filter(model => model.protocols.includes("responses")).map(model => { const item = node("option", model.id);item.value = model.id;return item; }));
    if ([...selector.options].some(option => option.value === c.model)) selector.value = c.model;
  }
  function clientSources() {
    const allowed = new Set([...el("connection-client-allowed").querySelectorAll("input:checked")].map(input => input.value));
    const before = el("connection-current").value, replacement = choice(data.providers.filter(p => p.enabled && allowed.has(p.id) && selectableSource(p, editingClient)), before);
    el("connection-current").replaceChildren(...replacement.childNodes);if ([...el("connection-current").options].some(option => option.value === before)) el("connection-current").value = before;clientModels();
  }
  function editClient(c) {
    editingClient = c.id;panels("client");el("connection-client-title").textContent = c.name;
    const allowed = el("connection-client-allowed");allowed.replaceChildren(...data.providers.filter(p => p.enabled && compatible(p, c.id)).map(p => check("source", p.id, c.allowed.includes(p.id), p.name)));
    allowed.querySelectorAll("input").forEach(input => input.addEventListener("change", clientSources));
    const select = choice(data.providers.filter(p => p.enabled && c.allowed.includes(p.id) && selectableSource(p, c.id)), c.source);
    el("connection-current").replaceChildren(...select.childNodes);el("connection-current").value = c.source || "";clientModels();
  }
  el("connection-current").addEventListener("change", clientModels);
  clientForm.addEventListener("submit", e => { e.preventDefault();const c = client(editingClient), selected = el("connection-current").value;
    void change({ operation: "client", id: c.id, enabled: true, source: selected || null, allowed: [...el("connection-client-allowed").querySelectorAll("input:checked")].map(input => input.value).concat(c.allowed.filter(id => !source(id)?.enabled)),
      ...(selected.startsWith("api_") && c.id === "codex" ? { model: el("connection-current-model").value, auto_review_model: el("connection-current-model").value } : {}) });
  });
  function disableSource(provider) {
    const affected = data.clients.filter(c => c.enabled && c.source === provider.id);
    if (!affected.length) { void change({ operation: "provider", id: provider.id, enabled: false });return; }
    disabling = provider.id;panels("disable");const area = el("connection-replacements");area.replaceChildren();
    for (const c of affected) { const label = node("label", c.name), select = choice(data.providers.filter(p => p.id !== provider.id && p.enabled && c.allowed.includes(p.id) && selectableSource(p, c.id)));select.name = c.id;label.append(select);area.append(label); }
  }
  el("connection-disable-form").addEventListener("submit", e => { e.preventDefault();void change({ operation: "provider", id: disabling, enabled: false,
    replacements: Object.fromEntries([...el("connection-replacements").querySelectorAll("select")].map(select => [select.name, select.value || null])) }); });
  el("connection-add").addEventListener("click", () => { if (data) editApi(); });
  for (const id of ["connection-cancel", "connection-client-cancel", "connection-disable-cancel"]) el(id).addEventListener("click", () => panels());
  window.addEventListener("hashchange", () => { apiForm.elements.key.value = "";if (["#system", "#claude", "#codex"].includes(location.hash)) void load(); });
  window.addEventListener("ccdx:choose-source", event => { if (typeof event.detail?.id === "string" && providerEntries.some(p => p.id === event.detail.id)) chooseProvider(event.detail.id); });
  new MutationObserver(() => { if (data) list(); }).observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
  globalThis.ccdxConnections = { load, editClient: id => { if (data && client(id)) { location.hash = "system";editClient(client(id)); } } };
  for (const button of document.querySelectorAll("[data-client-access]")) button.addEventListener("click", () => globalThis.ccdxConnections.editClient(button.dataset.clientAccess));
  void load();
})();
