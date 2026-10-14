(() => {
  function create({ element, phrase, localize, text, finite, number, mib, tableRow, emptyTable, document, navigator }) {
    let contextRequests = [];
    let contextCompactions = {};
    let failureSignature;
    let contextSignature;
    
    function renderAuth(data, { failed = false } = {}) {
      const account = data.login ? `@${data.login}` : data.id ? `ID ${data.id}` : phrase("account unknown");
      const label = data.reason === "credential_read_failed" ? "UNAVAILABLE"
        : !data.configured ? "NOT CONFIGURED" : !data.valid ? "INVALID" : "SAVED";
      text("auth-account", failed ? "GitHub / {account} / UPDATE FAILED" : label === "SAVED" ? "GitHub / {account} / SAVED" : `GitHub / ${label}`, { account });
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
      const signature = JSON.stringify([recent, recentRequests]);
      if (signature === failureSignature) return;
      failureSignature = signature;
      const list = element("failures");
      const expanded = new Set([...list.querySelectorAll("details[open]")].map((item) => item.dataset.key));
      list.replaceChildren();
      const requests = Array.isArray(recentRequests) ? recentRequests.slice(-20) : [];
      const byRequest = new Map(requests.filter((request) => request.request_id).map((request) => [request.request_id, request]));
      const failures = Array.isArray(recent) ? recent.slice(-10).map((failure) => ({ ...failure, timeline: byRequest.get(failure.request_id) })) : [];
      const recorded = new Set(failures.map((failure) => failure.request_id).filter(Boolean));
      for (const request of requests) {
        if (!request.failed || recorded.has(request.request_id)) continue;
        failures.push({ at: request.at, model: request.model, request_id: request.request_id,
          event_type: `request.${request.outcome}`, code: request.origin, timeline: request,
          message: "Request ended without successful completion.", local_message: true, retried: request.upstream_attempts > 1 });
      }
      failures.sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0));
      failures.splice(0, Math.max(0, failures.length - 10));
      failures.reverse();
      text("failure-count", "{count} retained / requests + events", { count: failures.length });
      if (!failures.length) {
        const item = document.createElement("li");
        item.className = "empty";
        localize(item, "No recent request failures recorded.");
        list.append(item);
        return;
      }
      for (const failure of failures) {
        const item = document.createElement("li");
        const details = document.createElement("details");
        details.dataset.key = `${failure.at}/${failure.request_id || failure.response_id}/${failure.code}`;
        details.open = expanded.has(details.dataset.key);
        const title = document.createElement("summary");
        localize(title, "{detail} / {retry}", {
          detail: phrase("{time} / {model} / {code}", {
            time: failure.at ? String(failure.at) : phrase("unknown time"),
            model: failure.model ? String(failure.model).slice(0, 80) : phrase("unknown_model"),
            code: failure.code ? String(failure.code).slice(0, 80) : phrase("unknown_error"),
          }),
          retry: phrase(failure.retried ? "retry attempted" : "no retry"),
        });
        const timeline = failure.timeline;
        const timings = timeline?.timings_ms || {};
        const timingText = ["admission", "body", "history", "images", "serialization", "upstream_start", "upstream_headers", "first_output", "last_activity", "terminal", "finished"]
          .filter((key) => finite(timings[key])).map((key) => `${key}=${Number(timings[key]).toFixed(1)}`).join(" / ");
        const fields = { time: failure.at, model: failure.model, event: failure.event_type, code: failure.code,
          message: failure.message, response_id: failure.response_id, upstream_request_id: failure.upstream_request_id,
          retry: failure.retried ? (timeline ? "attempted" : "attempted (outcome not recorded here)") : "not attempted",
          retry_policy: failure.retry_policy, retry_skipped: failure.retry_skipped,
          recovery: failure.recovery ? JSON.stringify(failure.recovery) : undefined,
          request_id: failure.request_id, outcome: timeline?.outcome, origin: failure.origin || timeline?.origin,
          phase: timeline?.phase, http_status: failure.http_status ?? timeline?.http_status, route: failure.route,
          upstream_attempts: timeline?.upstream_attempts,
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
        localize(copy, "Copy diagnostic");
        copy.addEventListener("click", async () => {
          try {
            await navigator.clipboard.writeText(lines.join("\n"));
            localize(copy, "Copied");
          } catch { localize(copy, "Copy unavailable"); }
        });
        details.append(title, diagnostic, copy);
        item.append(details);
        list.append(item);
      }
    }
    
    function render(data) {
      text("version", `v${data.version || "?"}`);
      text("uptime", "pid {pid} / uptime {duration}", { pid: number(data.pid), duration: duration(data.uptime_ms) });
    
      const copilot = data.copilot || {};
      text("copilot", copilot.account_bound ? "BOUND" : "UNCONFIRMED");
      text("token", copilot.token_cached ? "service token / TTL {duration}" : "service token not cached", { duration: duration(copilot.token_expires_in_ms) });
    
      const models = data.models || {};
      text("models", number(models.models));
      text("model-source", "source {source} / live: ccdx models", { source: phrase(String(models.source || "unknown").slice(0, 80)) });
    
      const requests = data.requests || {};
      text("requests", number(requests.total));
      text("request-errors", "4xx {client} / 5xx {server} / active {active}", { client: number(requests.status_4xx), server: number(requests.status_5xx), active: number(requests.active) });
      text("body-limits", "raw {raw} / decoded {decoded}", { raw: mib(data.limits?.max_body_bytes), decoded: mib(data.limits?.max_decoded_body_bytes) });
    
      const outcomes = data.stream_performance?.by_route?.responses?.terminal_outcomes?.totals || {};
      for (const key of ["completed", "incomplete", "failed", "cancelled"]) text(key, number(outcomes[key]));
      const timing = data.stream_performance?.by_route?.responses || {};
      for (const [id, metric, scale, unit] of [["ttft", timing.ttft_ms, 1, "ms"], ["tpot", timing.tpot_us, timing.tpot_us?.unit === "us" ? 1000 : 1, "ms/token"]]) {
        const value = metric?.samples > 0 && finite(metric.avg) ? `${(Number(metric.avg) / scale).toFixed(1)} ${unit}` : "—";
        text(id, "{value} / {samples} samples", { value, samples: number(metric?.samples) });
      }
    
      const history = data.response_history || {};
      const limit = Number(history.maxBytes || data.limits?.response_history_max_bytes || 0);
      const used = Number(history.bytes || 0);
      text("history", `${mib(used)} / ${mib(limit)}`);
      text("history-detail", "entries {entries} / trees {trees} / misses {misses} (evicted {evicted})", { entries: number(history.entries), trees: number(history.tree_count), misses: number(history.lookup_misses), evicted: number(history.evicted_lookup_misses) });
      element("history-meter").value = limit > 0 ? Math.min(100, Math.max(0, used / limit * 100)) : 0;
    
      const image = data.image_generation;
      text("image", image ? "{count} succeeded" : "NOT INITIALIZED", { count: number(image?.succeeded) });
      text("image-detail", image
        ? "active {active} / failed {failed} / delivery failures {delivery}"
        : "Setup state unknown / ccdx image-status", { active: number(image?.active), failed: number(image?.failed), delivery: number(image?.delivery_failures) });
    
      renderFailures([...(data.response_failures?.recent || []), ...(data.http_errors?.recent || [])]
        .sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0)), data.stream_performance?.recent_requests);
      renderContext(data.stream_performance);
      if (element("prediction-preference")) {
        const prediction = data.client_integrations?.prediction;
        text("prediction-preference", prediction ? prediction.configured ? "Enabled" : "Disabled" : "Unknown");
        text("prediction-bridge", ({ running: "Running", recovering: "Recovering", stopped: "Stopped", unavailable: "Unavailable" })[prediction?.bridge] || "Unknown");
        text("prediction-route", prediction?.client_route === "observed" ? "Observed" : "Unknown");
        text("prediction-candidate", "Unknown");
        const note = element("prediction-note");
        if (note) note.textContent = prediction?.reason || "";
      }
      text("updated", "Snapshot {time}", { time: new Date().toLocaleTimeString() });
    }
    
    function renderContext(performance) {
      if (performance !== undefined) {
        contextRequests = Array.isArray(performance?.recent_requests) ? performance.recent_requests.slice(-20).reverse() : [];
        contextCompactions = performance?.by_route?.responses_compact?.terminal_outcomes?.totals || {};
      }
      const body = element("context-body");
      if (!body) return;
      text("context-note", "20 latest finished requests / compactions: {completed} completed, {incomplete} incomplete, {failed} failed", {
        completed: number(contextCompactions.completed), incomplete: number(contextCompactions.incomplete), failed: number(contextCompactions.failed),
      });
      if (element("request-context")?.open === false) return;
      const signature = JSON.stringify(contextRequests);
      if (signature === contextSignature) return;
      contextSignature = signature;
      body.replaceChildren();
      for (const request of contextRequests) {
        const context = request.context || {};
        const outcome = ["completed", "incomplete", "failed", "cancelled"].includes(request.outcome)
          ? request.outcome[0].toUpperCase() + request.outcome.slice(1) : "Unknown";
        const ratio = finite(context.input_tokens) && finite(context.context_window_tokens) && Number(context.context_window_tokens) > 0
          ? `${(100 * Number(context.input_tokens) / Number(context.context_window_tokens)).toFixed(1)}%` : "—";
        body.append(tableRow([String(request.model || "unknown").slice(0, 80),
          finite(context.payload_bytes) ? (Number(context.payload_bytes) / 1048576).toFixed(2) : "—",
          number(context.images), number(context.input_tokens), number(context.context_window_tokens), ratio,
          outcome], { labels: [6] }));
      }
      if (!contextRequests.length) emptyTable("context-body", 7, "No observed request metadata.");
    }
    return { render, renderAuth, renderFailures, renderContext };
  }
  globalThis.ccdxDashboardStatus = { create };
})();
