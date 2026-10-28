(() => {
  function create({ time, element, phrase, localize, text, finite, number, mib, tableRow, emptyTable, document, navigator }) {
    const visible = node => !node?.closest?.('[data-view]')?.hidden;
    const writeText = text;
    text = (id, ...args) => { if (visible(element(id))) writeText(id, ...args); };
    let contextRequests = [];
    let contextCompactions = {};
    let failureSignature;
    let issueGroups = { issues: [], capability: [], connection: [] }, issueRequests = [];
    element("failure-kind")?.addEventListener?.("change", () => renderFailures(issueGroups[element("failure-kind").value] || [], element("failure-kind").value === "issues" ? issueRequests : []));
    let contextSignature;
    const sourceNames = new Map([["github", "GitHub Copilot"], ["m365", "Microsoft 365"]]);
    
    const sourceLabel = id => globalThis.ccdxConnectionNames?.[id] || sourceNames.get(id) || id;
    function renderProviders(data) {
      const providers = data.providers || [];
      const states = { saved: "saved_locally", authorized: "authorized", disabled: "disabled", unavailable: "unavailable_ca184",
        unknown: "unknown", paused: "access_paused", unconfigured: "not_configured", ready: "ready", checking: "checking", unsupported: "unsupported",
        configured: "configured", default_unavailable: "cap_default_unavailable", preserved: "existing_settings_kept", partially_preserved: "existing_settings_kept",
        restored: "settings_restored", not_installed: "not_installed", configuration_unavailable: "setup_unavailable", not_configured: "unknown", standby: "standby" };
      const auth = element("provider-auth"), clients = element("provider-clients"), requests = element("provider-requests"), claudeClients = element("claude-clients");
      auth.replaceChildren();clients.replaceChildren();requests.replaceChildren();claudeClients?.replaceChildren();
      const applications = new Map();
      for (const provider of providers) {
        sourceNames.set(provider.id, provider.name);
        const identity = provider.auth || {};
        const authRow = tableRow([provider.name, identity.account || "—", states[identity.state] || "unknown",
          states[provider.state] || "unknown", time(identity.checked_at, { date: true }), duration(identity.expires_in_ms)], { labels: [2, 3] });
        authRow.setAttribute("data-provider", provider.id);
        if (provider.reason) {
          const network = provider.network_diagnostic, catalog = provider.catalog_diagnostic;
          localize(authRow.children[3], "state_reason", { state: phrase(states[provider.state] || "unknown"),
            reason: catalog ? phrase(`catalog_cause_${catalog.cause_code}`) : network ? phrase(`network_cause_${network.cause_code}`) : provider.reason });
          if (network) localize(authRow.children[3], "network_detail", { source: phrase(`network_source_${network.source}`),
            stage: phrase(`network_stage_${network.stage}`), code: network.cause_code, category: provider.reason }, "title");
        }
        if (globalThis.ccdxIcons) {
          globalThis.ccdxIcons.set(authRow.children[2], states[identity.state] || "unknown", globalThis.ccdxIcons.kind(identity.state));
          globalThis.ccdxIcons.set(authRow.children[3], provider.reason ? "state_reason" : states[provider.state] || "unknown", globalThis.ccdxIcons.kind(provider.state),
            provider.reason ? { state: phrase(states[provider.state] || "unknown"), reason: provider.catalog_diagnostic ? phrase(`catalog_cause_${provider.catalog_diagnostic.cause_code}`) : provider.network_diagnostic ? phrase(`network_cause_${provider.network_diagnostic.cause_code}`) : provider.reason } : {});
        }
        auth.append(authRow);
        for (const client of provider.clients || []) {
          const id = client.id || client.name;
          if (!applications.has(id)) applications.set(id, []);
          applications.get(id).push({ provider, client });
        }
        if (provider.requests) {
          const item = document.createElement("p");
          localize(item, "provider_done_done_incomplete_incomplete_failed_failed", { provider: `${provider.name} · ${provider.request_scope || "Claude Messages"}`,
            done: number(provider.requests.completed), incomplete: number(provider.requests.incomplete), failed: number(provider.requests.failed) });
          requests.append(item);
        }
      }
      for (const entries of applications.values()) {
        const selected = entries.find(entry => entry.client.selected === true) || (entries.length === 1 ? entries[0] : null);
        const client = selected?.client || { name: entries[0].client.name, state: entries.every(entry => entry.client.state === "paused") ? "paused" : "unknown" };
        const row = tableRow([client.name, selected?.provider.name || "—", states[client.state] || "unknown",
          client.gateway || "—", time(client.last_request_at)], { labels: [2, 3] });
        if (client.reason) localize(row.children[2], "state_reason", { state: phrase(states[client.state] || "unknown"), reason: client.reason });
        if (globalThis.ccdxIcons) {
          globalThis.ccdxIcons.set(row.children[2], client.reason ? "state_reason" : states[client.state] || "unknown", globalThis.ccdxIcons.kind(client.state), client.reason ? { state: phrase(states[client.state] || "unknown"), reason: client.reason } : {});
          if (["running", "unavailable"].includes(client.gateway)) globalThis.ccdxIcons.set(row.children[3], client.gateway, globalThis.ccdxIcons.kind(client.gateway));
        }
        clients.append(row);
        if (String(client.id || "").startsWith("claude_")) {
          const detail = tableRow([client.name, states[client.state] || "unknown", client.gateway || "—", time(client.last_request_at)], { labels: [1, 2] });
          if (client.reason) localize(detail.children[1], "state_reason", { state: phrase(states[client.state] || "unknown"), reason: client.reason });
          if (globalThis.ccdxIcons) {
            globalThis.ccdxIcons.set(detail.children[1], client.reason ? "state_reason" : states[client.state] || "unknown", globalThis.ccdxIcons.kind(client.state), client.reason ? { state: phrase(states[client.state] || "unknown"), reason: client.reason } : {});
            if (["running", "unavailable"].includes(client.gateway)) globalThis.ccdxIcons.set(detail.children[2], client.gateway, globalThis.ccdxIcons.kind(client.gateway));
          }
          claudeClients?.append(detail);
        }
      }
      if (element("claude-client-state")) element("claude-client-state").hidden = Boolean(claudeClients?.children.length);
      text("source-summary", "count_providers", { count: providers.length });
      element("source-detail").replaceChildren(...providers.map(provider => {
        const item = document.createElement("span");item.textContent = provider.name;return item;
      }));
    }

    function duration(value) {
      if (!finite(value)) return "—";
      const seconds = Math.max(0, Math.round(Number(value) / 1000));
      const days = Math.floor(seconds / 86400);
      const hours = Math.floor((seconds % 86400) / 3600);
      const minutes = Math.floor((seconds % 3600) / 60);
      return days ? `${days}d ${hours}h` : hours ? `${hours}h ${minutes}m` : `${minutes}m`;
    }
    
    function renderFailures(recent, recentRequests = []) {
      if (!visible(element("failures"))) return;
      const signature = JSON.stringify([element("failure-kind")?.value, recent, recentRequests]);
      if (signature === failureSignature) return;
      failureSignature = signature;
      const list = element("failures");
      const expanded = new Set([...list.querySelectorAll("details[open]")].filter(item => item.dataset.disclosureClosing !== "true").map(item => item.dataset.key));
      list.replaceChildren();
      const requests = Array.isArray(recentRequests) ? recentRequests.slice(-20) : [];
      const byRequest = new Map(requests.filter((request) => request.request_id).map((request) => [request.request_id, request]));
      const kind = element("failure-kind")?.value || "issues", grouped = new Map();
      const entries = Array.isArray(recent) ? recent : [];
      for (const failure of entries) {
        const key = kind === "issues" ? failure.request_id || `${failure.at}/${failure.code}`
          : JSON.stringify([failure.provider, failure.model, failure.route, failure.code, kind === "capability" ? null : failure.origin, failure.reason]);
        const old = grouped.get(key);
        grouped.set(key, { ...failure, occurrences: (old?.occurrences || 0) + 1, timeline: byRequest.get(failure.request_id) });
      }
      const failures = [...grouped.values()].slice(-10);
      const recorded = new Set(failures.map((failure) => failure.request_id).filter(Boolean));
      for (const request of requests) {
        if (!request.failed || request.outcome === "cancelled" || request.rejection_reason || recorded.has(request.request_id)) continue;
        failures.push({ at: request.at, model: request.model, request_id: request.request_id,
          event_type: `request.${request.outcome}`, code: request.origin, timeline: request,
          message: request.stop_reason === "max_tokens" ? "Output limit reached." : "Request ended without successful completion.", local_message: true, retried: request.upstream_attempts > 1 });
      }
      failures.sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0));
      failures.splice(0, Math.max(0, failures.length - 10));
      failures.reverse();
      text("failure-count", "count_retained_requests_events", { count: failures.length });
      if (!failures.length) {
        const item = document.createElement("li");
        item.className = "empty";
        localize(item, "no_recent_request_failures_recorded");
        list.append(item);
        return;
      }
      for (const failure of failures) {
        const notModelRequest = ["not_found", "image_mcp", "models", "claude_models"].includes(failure.route);
        const item = document.createElement("li");
        const details = document.createElement("details");
        details.dataset.key = `${failure.at}/${failure.request_id || failure.response_id}/${failure.code}`;
        details.open = expanded.has(details.dataset.key);
        const title = document.createElement("summary");
        const cause = failure.route === "messages_count_tokens" && [404, 405, 501].includes(failure.http_status) ? "issue_count_unavailable"
          : ["rate_limit_error", "rate_limit_exceeded", "insufficient_quota", "http_429"].includes(failure.code) ? "issue_source_limit"
            : /^m365_catalog_http_/.test(failure.code || "") ? "issue_catalog_unavailable"
              : failure.reason === "ccdx_model_not_selected" ? "issue_model_not_selected"
                : failure.http_status === 401 || failure.http_status === 403 ? "issue_access_denied" : "issue_request_failed";
        const summary = {
          detail: phrase("issue_brief", {
            time: failure.at ? time(failure.at, { date: true }) : phrase("unknown_time"),
            model: notModelRequest ? phrase("not_applicable") : failure.model ? String(failure.model).slice(0, 80) : phrase("unknown_model"),
            cause: phrase(cause),
          }),
          retry: phrase(failure.upstream_attempts === 0 ? "no_upstream_call" : failure.retried ? "retry_attempted" : "no_retry"),
        };
        localize(title, "detail_retry", summary);
        if (failure.occurrences > 1) {
          summary.detail = phrase("repeated_issue", { detail: summary.detail, count: failure.occurrences });
          localize(title, "detail_retry", summary);
        }
        const timeline = failure.timeline;
        const provider = failure.provider || timeline?.provider;
        if (provider) {
          const source = sourceLabel(provider);
          const original = phrase("detail_retry", summary);
          localize(title, "source_failure_summary", { source, detail: original });
        }
        const timings = timeline?.timings_ms || {};
        const timingText = ["admission", "body", "history", "images", "serialization", "upstream_start", "upstream_headers", "first_output", "last_activity", "terminal", "finished"]
          .filter((key) => finite(timings[key])).map((key) => `${key}=${Number(timings[key]).toFixed(1)}`).join(" / ");
        const fields = { time: failure.at, model: notModelRequest ? phrase("not_applicable") : failure.model, event: failure.event_type, code: failure.code, reason: failure.reason, application: failure.application, occurrences: failure.occurrences > 1 ? failure.occurrences : undefined, capability_cached: failure.capability_cached, shared_upstream: failure.shared_upstream,
          message: failure.message, response_id: failure.response_id, upstream_request_id: failure.upstream_request_id,
          retry: failure.retried ? (timeline ? "attempted" : "attempted (outcome not recorded here)") : "not attempted",
          retry_policy: failure.retry_policy, retry_skipped: failure.retry_skipped,
          recovery: failure.recovery ? JSON.stringify(failure.recovery) : undefined,
          request_id: failure.request_id, outcome: timeline?.outcome, origin: failure.origin || timeline?.origin,
          phase: timeline?.phase, http_status: failure.http_status ?? timeline?.http_status, route: failure.route,
          upstream_attempts: failure.upstream_attempts ?? timeline?.upstream_attempts,
          error_type: failure.error_type, parameter: failure.parameter, error_body: failure.error_body,
          diagnostic_message: failure.diagnostic_message, method: failure.method, target: failure.target,
          request_options: failure.request_options ? JSON.stringify(failure.request_options) : undefined,
          transport: failure.transport ? JSON.stringify(failure.transport) : undefined,
          output_requested: timeline?.context?.max_output_tokens_requested, output_sent: timeline?.context?.max_output_tokens_sent,
          output_used: timeline?.context?.output_tokens, stop_reason: timeline?.stop_reason, requested_model: failure.requested_model, request_kind: failure.request_kind, provider: failure.provider || timeline?.provider,
          attempt_timings: failure.attempt_timings || timeline?.attempts ? JSON.stringify(failure.attempt_timings || timeline.attempts) : undefined,
          timings_ms: timingText };
        const diagnostic = document.createElement("dl");
        diagnostic.className = "failure-detail";
        const lines = [];
        for (const [key, value] of Object.entries(fields)) {
          if (value === undefined || value === null || value === "") continue;
          const label = document.createElement("dt");
          const content = document.createElement("dd");
          localize(label, key);
          const rawValue = String(value).slice(0, 500);
          if (key === "retry" || (key === "message" && failure.local_message)) localize(content, rawValue);
          else content.textContent = rawValue;
          diagnostic.append(label, content);
          lines.push(`${key}: ${rawValue}`);
        }
        const copy = document.createElement("button");
        copy.type = "button";
        localize(copy, "copy_diagnostic");
        copy.addEventListener("click", async () => {
          try {
            await navigator.clipboard.writeText(lines.join("\n"));
            localize(copy, "copied");
          } catch { localize(copy, "copy_unavailable"); }
        });
        const privacy = document.createElement("p");privacy.className = "hint";
        localize(privacy, "upstream_messages_may_contain_sensitive_text");
        details.append(title, diagnostic, privacy, copy);
        item.append(details);
        list.append(item);
      }
    }
    
    function render(data) {
      if (data.scope === "summary") {
        globalThis.ccdxDashboardActivity?.update(data.model_activity);
        text("version", `v${data.version || "?"}`);
        text("uptime", "pid_pid_uptime_duration", { pid: number(data.pid), duration: duration(data.uptime_ms) });
        renderRuntimeUsage(data);
        text("updated", "snapshot_time", { time: time(Date.now()) });
        return;
      }
      for (const source of data.providers?.connections?.providers || []) sourceNames.set(source.id, source.name);
      globalThis.ccdxConnections?.updateMemory?.(data.providers?.connections);
      globalThis.ccdxDashboardActivity?.update(data.model_activity);
      globalThis.ccdxDashboardFlow?.update(data);
      text("version", `v${data.version || "?"}`);
      text("uptime", "pid_pid_uptime_duration", { pid: number(data.pid), duration: duration(data.uptime_ms) });
    
      const models = data.models || {};
      text("models", number(models.models));
      text("model-source", "source_source_live_ccdx_models", { source: phrase(String(models.source || "unknown").slice(0, 80)) });
    
      const requests = data.requests || {};
      text("requests", number(requests.total));
      text("request-errors", "4xx_client_5xx_server_active_active", { client: number(requests.status_4xx), server: number(requests.status_5xx), active: number(requests.active) });
      const categories = data.http_errors?.by_category;
      text("http-error-breakdown", categories ? "http_categories" : "—",
        categories ? Object.fromEntries(["inference", "capability", "protocol", "route", "other"].map(key => [key, number(categories[key] || 0)])) : {});
      text("body-limits", "raw_raw_decoded_decoded", { raw: mib(data.limits?.max_body_bytes), decoded: mib(data.limits?.max_decoded_body_bytes) });
    
      const outcomes = data.stream_performance?.by_route?.responses?.terminal_outcomes?.totals || {};
      for (const key of ["completed", "incomplete", "failed", "cancelled"]) text(key, number(outcomes[key]));
      const timing = data.stream_performance?.by_route?.responses || {};
      function percentiles(id, metric) {
        const valid = metric?.samples > 0 && metric.percentiles_estimated === true && finite(metric.p50) && finite(metric.p95);
        text(id, valid ? "percentile_values" : "—", valid ? { p50: Number(metric.p50).toFixed(0), p95: Number(metric.p95).toFixed(0), samples: number(metric.samples) } : {});
      }
      percentiles("ttft-percentiles", timing.ttft_ms);
      for (const [id, metric, scale, unit] of [["ttft", timing.ttft_ms, 1, "ms"], ["tpot", timing.output_tokens_per_second, 1, "token/s"]]) {
        const value = metric?.samples > 0 && finite(metric.avg) ? `${(Number(metric.avg) / scale).toFixed(1)} ${unit}` : "—";
        text(id, "value_samples_samples", { value, samples: number(metric?.samples) });
      }
    
      const history = data.response_history || {};
      const limit = Number(history.maxBytes || data.limits?.response_history_max_bytes || 0);
      const used = Number(history.bytes || 0);
      text("history", `${mib(used)} / ${mib(limit)}`);
      text("history-detail", "entries_entries_trees_trees_misses_misses_evicted_evicted", { entries: number(history.entries), trees: number(history.tree_count), misses: number(history.lookup_misses), evicted: number(history.evicted_lookup_misses) });
      if (visible(element("history-meter"))) element("history-meter").value = limit > 0 ? Math.min(100, Math.max(0, used / limit * 100)) : 0;
    
      const image = data.image_generation;
      text("image", image ? "count_succeeded" : "not_initialized", { count: number(image?.succeeded) });
      text("image-detail", image
        ? "active_active_failed_failed_delivery_failures_delivery"
        : "setup_state_unknown_ccdx_image_status", { active: number(image?.active), failed: number(image?.failed), delivery: number(image?.delivery_failures) });

      const claude = data.providers?.claude || data.providers?.m365?.claude, claudeMetrics = claude?.requests?.performance;
      percentiles("claude-ttft-percentiles", claudeMetrics?.by_route?.messages?.ttft_ms);
      const sourceBody = element("source-requests-body");
      if (sourceBody && visible(sourceBody)) {
        sourceBody.replaceChildren();
        const routes = { ...data.stream_performance?.by_route, ...claudeMetrics?.by_route };
        for (const [protocol, route] of Object.entries(routes)) for (const [source, stats] of Object.entries(route.by_provider || {})) {
          const totals = stats.terminal_outcomes.totals;
          sourceBody.append(tableRow([sourceLabel(source), protocol, number(stats.active), ...["completed", "incomplete", "failed", "cancelled", "unknown"].map(outcome => number(totals[outcome]))]));
        }
        if (!sourceBody.children.length) emptyTable("source-requests-body", 8, "no_requests_observed");
      }
      const recentRequests = [...(data.stream_performance?.recent_requests || []), ...(claudeMetrics?.recent_requests || [])]
        .sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0));
      issueGroups = {
        issues: [...(data.response_failures?.recent || []), ...(data.http_errors?.actionable_recent || data.http_errors?.recent || [])],
        capability: data.http_errors?.capability_recent || [],
        connection: [...(data.http_errors?.protocol_recent || []), ...(data.http_errors?.route_recent || [])],
      };
      for (const rows of Object.values(issueGroups)) rows.sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0));
      issueRequests = recentRequests;
      const kind = element("failure-kind")?.value || "issues";
      renderFailures(issueGroups[kind] || [], kind === "issues" ? recentRequests : []);
      renderContext({ ...data.stream_performance, recent_requests: recentRequests });
      if (element("claude-route") && visible(element("claude-route"))) {
        element("claude-route").textContent = claude?.base_url || "—";
        const clientState = value => ({ configured: "configured", restored: "settings_restored", preserved: "existing_settings_kept", partially_preserved: "existing_settings_kept",
          not_installed: "not_installed", configuration_unavailable: "setup_unavailable" })[value] || "unknown";
        text("claude-client-state", "claude_code_code_claude_app_app", { code: phrase(clientState(claude?.clients?.code)), app: phrase(clientState(claude?.clients?.app)) });
        const totals = claudeMetrics?.by_route?.messages?.terminal_outcomes?.totals || claude?.requests || {};
        for (const key of ["completed", "incomplete", "failed", "cancelled"]) text(`claude-${key}`, totals[key] === undefined ? "—" : number(totals[key]));
        for (const [id, metric, unit] of [["claude-ttft", claudeMetrics?.by_route?.messages?.ttft_ms, "ms"], ["claude-speed", claudeMetrics?.by_route?.messages?.output_tokens_per_second, "token/s"]]) {
          text(id, metric?.samples > 0 ? `${Number(metric.avg).toFixed(1)} ${unit} / ${metric.samples}` : "—");
        }
      }
      renderRuntimeUsage(data);
      if (element("prediction-preference") && visible(element("prediction-preference"))) {
        const prediction = data.client_integrations?.prediction;
        text("prediction-preference", prediction ? prediction.configured ? "configured" : "not_configured" : "unknown");
        text("prediction-bridge", ({ running: "running_f4cca", recovering: "recovering", stopped: "stopped", unavailable: "unavailable_ca184" })[prediction?.bridge] || "unknown");
        text("prediction-route", prediction?.client_route === "observed" ? "observed" : "unknown");
        text("prediction-candidate", "unknown");
        const note = element("prediction-note");
        if (note) note.textContent = prediction?.reason || "";
      }
      text("updated", "snapshot_time", { time: time(Date.now()) });
    }
    function renderRuntimeUsage(data) {
      if (element("runtime-usage") && visible(element("runtime-usage"))) {
        const usage = data.runtime_usage;
        text("runtime-usage", usage ? "records_usage_records_input_input_cache_read_cached_output_outpu" : "—",
          usage ? { records: number(usage.records), input: number(usage.input_tokens), cached: number(usage.cached_input_tokens), output: number(usage.output_tokens), partial: usage.partial_records ? " ~" : "" } : {});
        const rate = usage?.cache_hit_rate;
        text("runtime-cache-hit", Number.isFinite(rate) && rate >= 0 && rate <= 1 ? `${usage.cache_hit_rate_partial ? "~" : ""}${(rate * 100).toFixed(1)}%` : "—");
      }
      if (element("process-state") && visible(element("process-state"))) {
        element("process-state").textContent = `PID ${data.pid || "—"} / ${globalThis.location?.origin || ""}`;
        text("process-memory", "rss_rss_heap_heap", { rss: mib(data.process?.rss_bytes), heap: mib(data.process?.heap_used_bytes) });
        text("process-queues", "codex_body_admission_active_active_queued_queued_queue_limit_lim", {
          active: number(data.admission?.activeRequests), queued: number(data.admission?.queued), limit: number(data.admission?.maxQueued) });
      }
    }
    
    function renderContext(performance) {
      if (performance !== undefined) {
        contextRequests = Array.isArray(performance?.recent_requests) ? performance.recent_requests.slice(-20).reverse() : [];
        contextCompactions = performance?.by_route?.responses_compact?.terminal_outcomes?.totals || {};
      }
      const body = element("context-body");
      if (!body || !visible(body)) return;
      text("context-note", "20_latest_finished_requests_compactions_completed_completed_inco", {
        completed: number(contextCompactions.completed), incomplete: number(contextCompactions.incomplete), failed: number(contextCompactions.failed),
      });
      if (element("request-context")?.open === false || element("request-context")?.closest?.("[hidden]")) return;
      const signature = JSON.stringify(contextRequests);
      if (signature === contextSignature) return;
      contextSignature = signature;
      const expanded = new Set([...(body.querySelectorAll?.("details[open]") || [])].filter(details => details.dataset.disclosureClosing !== "true").map(details => details.getAttribute("data-request-key")));
      body.replaceChildren();
      for (const request of contextRequests) {
        const context = request.context || {};
        const outcome = ["completed", "incomplete", "failed", "cancelled"].includes(request.outcome)
          ? request.outcome[0].toUpperCase() + request.outcome.slice(1) : "unknown";
        const ratio = finite(context.input_tokens) && finite(context.context_window_tokens) && Number(context.context_window_tokens) > 0
          ? `${(100 * Number(context.input_tokens) / Number(context.context_window_tokens)).toFixed(1)}%` : "—";
        const at = Date.parse(request.at);
        const row = tableRow([Number.isFinite(at) ? time(at) : "—",
          String(sourceLabel(request.provider) || "—").slice(0, 80),
          String(request.model || "unknown").slice(0, 80), outcome, number(context.input_tokens), ""], { labels: [3] });
        const wireFailure = Number.isInteger(request.http_status) && request.http_status >= 400;
        if (request.rejection_reason) {
          if (globalThis.ccdxIcons) globalThis.ccdxIcons.set(row.children[3], "request_access_blocked", "unavailable");else localize(row.children[3], "request_access_blocked");
        } else if (globalThis.ccdxIcons) globalThis.ccdxIcons.set(row.children[3], wireFailure ? "request_http_failure" : outcome.toLowerCase(),
          wireFailure ? "warning" : globalThis.ccdxIcons.kind(outcome.toLowerCase()), wireFailure ? { status: request.http_status } : {});
        else if (wireFailure) localize(row.children[3], "request_http_failure", { status: request.http_status });
        const details = document.createElement("details"), summary = document.createElement("summary"), fields = document.createElement("dl");
        const key = String(request.request_id || `${request.at || ""}/${request.provider || ""}/${request.model || ""}`).slice(0, 256);
        details.setAttribute?.("data-request-key", key);details.open = expanded.has(key);
        details.className = "request-details";fields.className = "failure-detail";
        localize(summary, "request_metadata");details.append(summary, fields);
        for (const [key, value] of [["request_id", request.request_id || "—"], ["http_status", number(request.http_status)], ["attempts", number(request.upstream_attempts)], ["model_outcome", globalThis.ccdxLanguage?.format(outcome.toLowerCase()) || outcome],
          ["time", Number.isFinite(at) ? time(at, { date: true }) : "—"],
          ["wire_mib", finite(context.payload_bytes) ? `${(Number(context.payload_bytes) / 1048576).toFixed(2)} MiB` : "—"],
          ["images", number(context.images)], ["model_window", number(context.context_window_tokens)], ["input_window", ratio],
          ["output_requested", number(context.max_output_tokens_requested)], ["output_sent", number(context.max_output_tokens_sent)], ["output_used", number(context.output_tokens)], ["stop_reason", request.stop_reason || "—"]]) {
          const term = document.createElement("dt"), detail = document.createElement("dd");localize(term, key);detail.textContent = value;fields.append(term, detail);
        }
        row.children[5].append(details);body.append(row);
      }
      if (!contextRequests.length) emptyTable("context-body", 6, "no_observed_request_metadata");
    }
    return { render, renderProviders, renderFailures, renderContext };
  }
  globalThis.ccdxDashboardStatus = { create };
})();
