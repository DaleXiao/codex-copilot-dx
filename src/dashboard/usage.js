(() => {
  function create({ element, phrase, localize, text, finite, number, mib, tableRow, emptyTable, document, navigator }) {
    function usageValues(row) {
      const rate = Number.isFinite(row.cache_hit_rate) && row.cache_hit_rate >= 0 && row.cache_hit_rate <= 1
        ? `${row.cache_hit_rate_partial ? "~" : ""}${(row.cache_hit_rate * 100).toFixed(1)}%` : "—";
      return [row.model, number(row.requests), number(row.input_tokens), number(row.cache_read_tokens), number(row.output_tokens), number(row.total_tokens), rate];
    }
    
    let usageData = null;
    let analyticsSignature;
    let selectedUsageDate = "";
    
    function renderUsageTable() {
      const day = selectedUsageDate && usageData.analytics?.days.find((entry) => entry.date === selectedUsageDate);
      const model = element("analytics-model").value;
      const total = day ? { ...analyticsPoint(day, model), model: "TOTAL" } : usageData.total;
      const rows = day ? day.models.filter((row) => !model || row.model === model).sort((a, b) => b.total_tokens - a.total_tokens || a.model.localeCompare(b.model)) : usageData.rows;
      const body = element("usage-body");
      body.replaceChildren();
      if (total.requests > 0) {
        body.append(tableRow(usageValues(total), { total: true }));
        for (const row of rows) body.append(tableRow(usageValues(row)));
      } else { emptyTable("usage-body", 7, "no_usage_records"); }
      element("clear-usage-day").hidden = !day;
      text("usage-state", day ? day.date : "local_log");
      text("usage-note", "records_records_shown_of_models_models_shown_day", {
        records: number(total.requests), shown: number(rows.length), models: number(day ? rows.length : usageData.model_count),
        day: day ? phrase("zone_model", { zone: usageData.analytics.time_zone, model: model || phrase("all_models") }) : "",
      });
    }
    
    function renderUsageState() {
      text("usage-state", selectedUsageDate && usageData.analytics?.days.some(day => day.date === selectedUsageDate) ? selectedUsageDate : "local_log");
    }
    
    function analyticsPoint(day, model) {
      return model ? day.models.find((row) => row.model === model) || { requests: 0, input_tokens: 0, output_tokens: 0 } : day;
    }
    
    function selectUsageDay(date) {
      selectedUsageDate = date;
      renderUsageTable();
      renderAnalytics();
    }
    
    function dayButton(day, point) {
      const button = document.createElement("button");
      button.type = "button";
      button.disabled = !day.available;
      button.setAttribute("aria-pressed", String(day.date === selectedUsageDate));
      const description = !day.available ? phrase("no_retained_history")
        : phrase("calls_recorded_calls_input_input_output_output_cached_cached_inc", {
          calls: number(point.requests), input: number(point.input_tokens), output: number(point.output_tokens), cached: number(point.cache_read_tokens), partial: point.tokens_partial ? phrase("partial_token_counts") : "",
        });
      for (const attribute of ["title", "aria-label"]) localize(button, "date_description", { date: day.date, description }, attribute);
      button.addEventListener("click", () => selectUsageDay(day.date));
      return button;
    }
    
    function renderAnalytics() {
      const analytics = usageData?.analytics;
      if (!analytics) return;
      const model = element("analytics-model").value;
      const signature = JSON.stringify([analytics, model, element("analytics-range").value, element("analytics-metric").value, selectedUsageDate]);
      if (signature === analyticsSignature) return;
      analyticsSignature = signature;
      const days = analytics.days;
      const daily = days.slice(-Number(element("analytics-range").value));
      const maximum = Math.max(1, ...daily.map((day) => {
        const point = analyticsPoint(day, model);
        return point.input_tokens + point.output_tokens;
      }));
      const bars = element("daily-bars");
      bars.replaceChildren();
      for (const day of daily) {
        const point = analyticsPoint(day, model);
        const button = dayButton(day, point);
        button.className = "daily-bar";
        for (const key of ["output_tokens", "input_tokens"]) {
          const segment = document.createElement("span");
          segment.className = key === "input_tokens" ? "bar-input" : "bar-output";
          segment.style.height = `${point[key] / maximum * 100}%`;
          button.append(segment);
        }
        bars.append(button);
      }
      text("daily-from", daily[0].date);
      text("daily-to", analytics.to);
      const metric = element("analytics-metric").value;
      const value = (day) => {
        const point = analyticsPoint(day, model);
        return metric === "tokens" ? point.input_tokens + point.output_tokens : point.requests;
      };
      const peak = Math.max(1, ...days.map(value));
      text("activity-scale", "metric_peak_peak", { metric: phrase(metric === "tokens" ? "input_output" : "recorded_calls"), peak: number(peak === 1 && days.every((day) => value(day) === 0) ? 0 : peak) });
      const calendar = element("activity-calendar");
      calendar.replaceChildren();
      const offset = (new Date(`${days[0].date}T00:00:00Z`).getUTCDay() + 6) % 7;
      const months = element("calendar-months");
      months.replaceChildren();
      const columns = Math.ceil((offset + days.length) / 7);
      let previousColumn = -4;
      days.forEach((day, index) => {
        if (index !== 0 && !day.date.endsWith("-01")) return;
        const column = Math.floor((offset + index) / 7);
        if (column - previousColumn < 4 || column + 4 > columns) return;
        previousColumn = column;
        const label = document.createElement("span");
        label.textContent = day.date.slice(0, 7);
        label.style.gridColumn = `${column + 1} / span 4`;
        months.append(label);
      });
      for (let index = 0; index < offset; index += 1) {
        const spacer = document.createElement("span");
        spacer.setAttribute("aria-hidden", "true");
        calendar.append(spacer);
      }
      for (const day of days) {
        const button = dayButton(day, analyticsPoint(day, model));
        button.className = "calendar-day";
        const count = value(day);
        button.dataset.level = String(count > 0 ? Math.min(4, Math.ceil(count / peak * 4)) : 0);
        calendar.append(button);
      }
      text("analytics-note", "zone_from_to_retained_history_starts_first_oldest_day_may_be_par", {
        zone: analytics.time_zone, from: daily[0].date, to: analytics.to, first: analytics.first_date || phrase("unknown"),
        excluded: analytics.undated_records ? phrase("count_records_with_invalid_future_timestamps_excluded", { count: number(analytics.undated_records) }) : "",
        limit: analytics.models_truncated ? phrase("model_filters_limited_to_100_all_model_totals_include_the_remain") : "",
      });
      text("analytics-selection", selectedUsageDate ? "selected_date_model_totals_in_the_usage_table_above_all_history_" : "select_a_day_for_model_totals_calls_are_usage_records_not_messag", { date: selectedUsageDate, model: model || phrase("all_models") });
    }
    
    function updateAnalyticsModels() {
      const select = element("analytics-model");
      const previous = select.value;
      select.replaceChildren();
      for (const model of [...new Set(["", ...usageData.analytics.models, ...(previous ? [previous] : [])])]) {
        const option = document.createElement("option");
        option.value = model;
        if (model) option.textContent = model;
        else localize(option, "all_models");
        select.append(option);
      }
      select.value = previous;
    }
    
    function applyUsage(data, { changed }) {
      const sameProvider = (data.provider || "all") === (usageData?.provider || "all");
      if (!sameProvider) selectedUsageDate = "";
      usageData = { ...data, ...(!data.analytics && sameProvider && usageData?.analytics ? { analytics: usageData.analytics } : {}) };
      if (changed) {
        if (data.analytics) updateAnalyticsModels();
        renderUsageTable();
        if (data.analytics) renderAnalytics();
      }
      if (data.analytics) {
        text("analytics-updated", "updated_time", { time: new Date().toLocaleTimeString() });
      }
    }
    return { applyUsage, renderUsageState, renderAnalytics, renderUsageTable, selectUsageDay, usageValues, get data() { return usageData; }, get selectedDate() { return selectedUsageDate; } };
  }
  globalThis.ccdxDashboardUsage = { create };
})();
