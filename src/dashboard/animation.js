(() => {
  function create({ element, phrase, localize, text, reducedMotion, getRefresh, document }) {
    const animationRows = new Map();
    const animationLabels = new Map();
    let animationTimelines = [];
    let savedAnimation = "";
    let selectedAnimation = "";
    let previewDisabledByEnvironment = false;
    let previewVisible = false;
    let previewTimer = null;
    let previewStarted = 0;
    let animationSaving = false;
    let animationFramesLoaded = false;

    function renderAnsiFrame(target, frame) {
      const fragments = String(frame).split(/\u001b\[([0-9;]+)m/);
      const content = document.createDocumentFragment();
      let color = "";
      for (let index = 0; index < fragments.length; index += 2) {
        if (fragments[index]) {
          const span = document.createElement("span");
          span.className = color;
          span.textContent = fragments[index];
          content.append(span);
        }
        const code = fragments[index + 1];
        color = code === "97" ? "ansi-white"
          : /^38;5;(159|123|87|51|45|39|33)$/.test(code || "") ? `ansi-${code.slice(5)}` : "";
      }
      target.replaceChildren(content);
    }

    function renderAnimationFrames(elapsed) {
      for (const timeline of animationTimelines) {
        const position = timeline.id === selectedAnimation ? elapsed % timeline.duration : 0;
        const frameIndex = timeline.frames.findIndex(({ until }) => position < until);
        if (frameIndex === timeline.lastFrame) continue;
        timeline.lastFrame = frameIndex;
        renderAnsiFrame(timeline.target, frameIndex < 0 ? `[${" ".repeat(20)}]` : timeline.frames[frameIndex].ansi);
      }
    }

    function stopAnimationPreview() {
      if (previewTimer !== null) clearTimeout(previewTimer);
      previewTimer = null;
    }

    function tickAnimationPreview() {
      previewTimer = null;
      if (!animationTimelines.length || !element("animation-settings").open || element("animation-settings").closest("[hidden]") || !previewVisible || document.visibilityState !== "visible" || reducedMotion.matches || previewDisabledByEnvironment) return;
      renderAnimationFrames(performance.now() - previewStarted);
      previewTimer = setTimeout(tickAnimationPreview, 32);
    }

    function syncAnimationPreview() {
      stopAnimationPreview();
      if (!animationTimelines.length || !element("animation-settings").open || element("animation-settings").closest("[hidden]") || !previewVisible || document.visibilityState !== "visible" || reducedMotion.matches || previewDisabledByEnvironment) {
        for (const timeline of animationTimelines) timeline.lastFrame = -2;
        renderAnimationFrames(0);
        return;
      }
      previewStarted = performance.now();
      tickAnimationPreview();
    }

    new IntersectionObserver(([entry]) => {
      previewVisible = entry.isIntersecting;
      syncAnimationPreview();
    }).observe(element("animation-options"));
    document.addEventListener("visibilitychange", syncAnimationPreview);
    reducedMotion.addEventListener("change", syncAnimationPreview);

    function buildAnimationOptions(data) {
      const container = element("animation-options");
      container.replaceChildren();
      animationRows.clear();
      animationTimelines = [];
      savedAnimation = data.theme;
      selectedAnimation = data.theme;
      previewDisabledByEnvironment = data.disabled_by_environment === true;
      for (const [index, theme] of data.themes.entries()) {
        animationLabels.set(theme.id, theme.label);
        const option = document.createElement("button");
        option.type = "button";
        option.className = "theme-option";
        option.dataset.theme = theme.id;
        option.setAttribute("aria-pressed", String(theme.id === data.theme));
        option.addEventListener("click", () => {
          selectedAnimation = theme.id;
          for (const [id, row] of animationRows) row.setAttribute("aria-pressed", String(id === theme.id));
          element("save-animation").disabled = selectedAnimation === savedAnimation;
          updateAnimationState();
          syncAnimationPreview();
          globalThis.ccdxSettingsPreferences?.selectAnimation(theme.id);
        });
        const name = document.createElement("span");
        name.className = "theme-name";
        const label = document.createElement("span");
        localize(label, "index_theme", { index: String(index + 1).padStart(2, "0"), theme: phrase(theme.label) });
        name.append(label);
        if (theme.default) {
          const marker = document.createElement("small");
          localize(marker, "default");
          name.append(marker);
        }
        const preview = document.createElement("span");
        preview.className = "theme-preview";
        preview.setAttribute("aria-hidden", "true");
        option.append(name, preview);
        container.append(option);
        animationRows.set(theme.id, option);
        let until = 0;
        const frames = theme.frames.map((frame) => {
          until += frame.delay_ms;
          return { ansi: frame.ansi, until };
        });
        animationTimelines.push({ id: theme.id, target: preview, frames, duration: until + theme.loop_pause_ms, lastFrame: -2 });
      }
      element("save-animation").disabled = true;
      syncAnimationPreview();
    }

    function animationNote(data) {
      return data.disabled_by_environment
        ? "disabled_by_ccdx_terminal_animation_saved_choice_applies_after_o"
        : "saved_choice_applies_to_the_running_terminal";
    }

    function loadAnimation(options) {
      if (!animationSaving) return getRefresh().refresh("animation", options);
    }

    function applyAnimation(data, { changed } = {}) {
      if (changed === false) { updateAnimationState(); return; }
      if (!animationFramesLoaded && data.themes.some(theme => theme.frames)) {
        buildAnimationOptions(data);
        animationFramesLoaded = true;
      } else {
        const dirty = selectedAnimation && selectedAnimation !== savedAnimation;
        savedAnimation = data.theme;
        if (!dirty) selectedAnimation = data.theme;
        previewDisabledByEnvironment = data.disabled_by_environment === true;
        for (const [id, row] of animationRows) row.setAttribute("aria-pressed", String(id === selectedAnimation));
        element("save-animation").disabled = selectedAnimation === savedAnimation;
        syncAnimationPreview();
      }
      updateAnimationState();
      text("animation-note", animationNote(data));
      globalThis.ccdxSettingsPreferences?.render();
    }

    function updateAnimationState() {
      text("animation-state", "current_theme_unsaved", { theme: phrase(animationLabels.get(savedAnimation) || savedAnimation), unsaved: selectedAnimation !== savedAnimation ? phrase("unsaved") : "" });
    }

    async function saveAnimation() {
      const button = element("save-animation");
      if (!selectedAnimation || selectedAnimation === savedAnimation) return;
      animationSaving = true;
      getRefresh().invalidate("animation");
      button.disabled = true;
      text("animation-note", "saving");
      try {
        const response = await fetch("/_ccdx/ui/animation", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-CCDX-Dashboard": "1" },
          body: JSON.stringify({ theme: selectedAnimation }),
          signal: AbortSignal.timeout(8000),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
        savedAnimation = data.theme;
        updateAnimationState();
        text("animation-note", animationNote(data));
      } catch (error) {
        text("animation-note", "not_saved_error", { error: String(error.message || error).slice(0, 150) });
      } finally {
        animationSaving = false;
        button.disabled = selectedAnimation === savedAnimation;
        loadAnimation({ force: true });
      }
    }

    return { apply: applyAnimation, load: loadAnimation, save: saveAnimation, sync: syncAnimationPreview, stop: stopAnimationPreview,
      select(theme) {
        if (!animationRows.has(theme) || selectedAnimation === theme) return;
        selectedAnimation = theme;
        for (const [id, row] of animationRows) row.setAttribute("aria-pressed", String(id === theme));
        updateAnimationState();syncAnimationPreview();
      },
      get saving() { return animationSaving; }, get framesLoaded() { return animationFramesLoaded; } };
  }
  globalThis.ccdxDashboardAnimation = { create };
})();
