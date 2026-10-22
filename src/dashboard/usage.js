(() => {
  function curvePath(points) {
    return points.map(([x, y], index) => {
      if (!index) return `M${x},${y}`;
      const [previousX, previousY] = points[index - 1], middle = (previousX + x) / 2;
      return `C${middle},${previousY} ${middle},${y} ${x},${y}`;
    }).join(" ");
  }

  function create({ time, element, phrase, localize, text, finite, number, mib, tableRow, emptyTable, document, navigator, motionAllowed = () => false }) {
    function usageValues(row) {
      const rate = Number.isFinite(row.cache_hit_rate) && row.cache_hit_rate >= 0 && row.cache_hit_rate <= 1
        ? `${row.cache_hit_rate_partial ? "~" : ""}${(row.cache_hit_rate * 100).toFixed(1)}%` : "—";
      return [row.model, number(row.requests), number(row.input_tokens), number(row.cache_read_tokens), number(row.output_tokens), number(row.total_tokens), rate];
    }
    
    let usageData = null;
    let analyticsSignature, calendarSignature;
    let selectedUsageDate = "";
    let dailySignature, dailySelection, chartVisible = false, motionPending = false;
    let motionTargets = [];
    const animations = new Set();

    function stopMotion() {
      for (const animation of animations) animation.cancel();
      animations.clear();motionPending = false;
    }

    function playMotion() {
      if (!motionPending || !chartVisible || !motionAllowed()) return;
      stopMotion();
      for (const { node, line, point } of motionTargets) {
        if (!node.animate) continue;
        const animation = node.animate(point ? [{ opacity: 0 }, { opacity: 1 }] : line
          ? [{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }]
          : [{ transform: "scaleY(0)" }, { transform: "scaleY(1)" }],
        { duration: point ? 200 : line ? 600 : 450, easing: "cubic-bezier(0.25, 1, 0.5, 1)" });
        animations.add(animation);
        animation.finished?.then(() => animations.delete(animation), () => animations.delete(animation));
      }
    }

    function revealChart() { motionPending = true;playMotion(); }
    function setChartVisible(value) { chartVisible = value;if (value) playMotion();else if (animations.size) stopMotion(); }

    function svgNode(tag, attributes) {
      const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
      for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
      return node;
    }

    function renderDaily(daily, model, maximum) {
      const line = element("analytics-view").value === "line";
      const signature = JSON.stringify([daily, model, line]);
      if (signature === dailySignature && selectedUsageDate === dailySelection) return;
      const changed = signature !== dailySignature;
      dailySignature = signature;dailySelection = selectedUsageDate;
      stopMotion();motionTargets = [];
      const chart = element("daily-bars");
      chart.className = line ? "daily-bars daily-lines" : "daily-bars";
      chart.replaceChildren();
      if (line) {
        const plot = svgNode("svg", { class: "daily-line-plot", viewBox: "0 0 1000 130", preserveAspectRatio: "none", "aria-hidden": "true", focusable: "false" });
        for (const key of ["input_tokens", "output_tokens"]) {
          let segment = [];
          const color = key === "input_tokens" ? "curve-input" : "curve-output";
          const flush = () => {
            if (segment.length > 1) {
              const path = svgNode("path", { d: curvePath(segment), class: `daily-curve ${color}`, pathLength: 1, "vector-effect": "non-scaling-stroke" });
              plot.append(path);motionTargets.push({ node: path, line: true });
            } else if (segment.length === 1) {
              const [x, y] = segment[0];
              const circle = svgNode("circle", { cx: x, cy: y, r: 2, class: color, fill: "none", "stroke-width": 2, "vector-effect": "non-scaling-stroke" });
              plot.append(circle);motionTargets.push({ node: circle, point: true });
            }
            segment = [];
          };
          daily.forEach((day, index) => {
            if (!day.available) { flush();return; }
            const point = analyticsPoint(day, model), x = (index + 0.5) / daily.length * 1000, y = 128 - point[key] / maximum * 124;
            segment.push([x, y]);
          });
          flush();
        }
        chart.append(plot);
      }
      for (const day of daily) {
        const point = analyticsPoint(day, model), button = dayButton(day, point);
        button.className = "daily-bar";
        if (!line) {
          const stack = document.createElement("span");stack.className = "bar-stack";
          for (const key of ["output_tokens", "input_tokens"]) {
            const segment = document.createElement("span");
            segment.className = key === "input_tokens" ? "bar-input" : "bar-output";
            segment.style.height = `${point[key] / maximum * 100}%`;
            stack.append(segment);
          }
          button.append(stack);motionTargets.push({ node: stack, line: false });
        }
        chart.append(button);
      }
      motionPending = changed;playMotion();
    }
    
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
      const commonSignature = JSON.stringify([analytics, model, element("analytics-range").value, element("analytics-metric").value, selectedUsageDate]);
      const signature = `${commonSignature}:${element("analytics-view").value}`;
      if (signature === analyticsSignature) return;
      analyticsSignature = signature;
      const days = analytics.days;
      const daily = days.slice(-Number(element("analytics-range").value));
      const maximum = Math.max(1, ...daily.map((day) => {
        const point = analyticsPoint(day, model);
        return point.input_tokens + point.output_tokens;
      }));
      renderDaily(daily, model, maximum);
      text("daily-from", daily[0].date);
      text("daily-to", analytics.to);
      if (commonSignature === calendarSignature) return;
      calendarSignature = commonSignature;
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
        text("analytics-updated", "updated_time", { time: time(Date.now()) });
      }
    }
    return { applyUsage, renderUsageState, renderAnalytics, renderUsageTable, selectUsageDay, usageValues, setChartVisible, revealChart, stopMotion, get data() { return usageData; }, get selectedDate() { return selectedUsageDate; } };
  }
  globalThis.ccdxDashboardUsage = { create, curvePath };
})();
