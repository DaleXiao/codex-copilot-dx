(() => {
  const shapes = { ok: ["path", { d: "m8 12 2.5 2.5L16 9" }], running: ["path", { d: "m10 8 6 4-6 4Z" }],
    warning: ["path", { d: "M12 7.5v5m0 3.5h.01" }], unavailable: ["path", { d: "M8 12h8" }] };
  function icon(kind = "unknown") {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    for (const [key, value] of Object.entries({ viewBox: "0 0 24 24", "aria-hidden": "true", focusable: "false", class: "state-icon" })) svg.setAttribute(key, value);
    const circle = document.createElementNS(svg.namespaceURI, "circle");
    circle.setAttribute("cx", "12");circle.setAttribute("cy", "12");circle.setAttribute("r", "9");svg.append(circle);
    if (shapes[kind]) { const [tag, attributes] = shapes[kind], shape = document.createElementNS(svg.namespaceURI, tag);
      for (const [key, value] of Object.entries(attributes)) shape.setAttribute(key, value);svg.append(shape); }
    return svg;
  }
  function set(target, key, kind = "unknown", values = {}) {
    const label = document.createElement("span"), wrapper = document.createElement("span");
    wrapper.className = `state-label state-${kind}`;
    globalThis.ccdxLanguage.set(label, key, values);wrapper.append(icon(kind), label);
    target.removeAttribute("data-i18n");target.replaceChildren(wrapper);
  }
  const kind = value => ["running", "active"].includes(value) ? "running"
    : ["ready", "authorized", "configured", "saved", "passed", "ok", "completed"].includes(value) ? "ok"
      : ["unavailable", "disabled", "unsupported", "not_installed", "unconfigured"].includes(value) ? "unavailable"
        : ["warn", "err", "invalid", "failed", "configuration_unavailable"].includes(value) ? "warning" : "unknown";
  globalThis.ccdxIcons = { icon, set, kind };
})();
