(() => {
  const known = new WeakSet(), active = new Map(), reduced = matchMedia("(prefers-reduced-motion: reduce)");
  function settle(detail, operation) {
    if (active.get(detail) !== operation) return;
    active.delete(detail);operation.animations.forEach(animation => animation.cancel());
    if (!operation.open) detail.open = false;delete detail.dataset.disclosureClosing;
  }
  function decorate(root) {
    const details = [...(root.matches?.("details") ? [root] : []), ...(root.querySelectorAll?.("details") || [])];
    for (const detail of details) {
      if (known.has(detail)) continue;
      const summary = detail.querySelector(":scope > summary");if (!summary) continue;
      known.add(detail);
      summary.addEventListener("click", event => {
        if (event.defaultPrevented || event.target.closest("button,a,input,select,textarea") || typeof summary.animate !== "function" || reduced.matches || document.hidden) return;
        event.preventDefault();
        const previous = active.get(detail), open = !(previous?.open ?? detail.open);
        if (previous) { active.delete(detail);previous.animations.forEach(animation => animation.cancel()); }
        const operation = { open, animations: [] };active.set(detail, operation);
        if (open) { delete detail.dataset.disclosureClosing;detail.open = true; }
        else detail.dataset.disclosureClosing = "true";
        for (const child of detail.children) if (child !== summary && !child.hidden && child.getClientRects().length) {
          operation.animations.push(child.animate(open ? [{ opacity: 0, transform: "translateY(-3px)" }, { opacity: 1, transform: "translateY(0)" }]
            : [{ opacity: 1, transform: "translateY(0)" }, { opacity: 0, transform: "translateY(-2px)" }],
          { duration: open ? 160 : 110, easing: "cubic-bezier(.25,1,.5,1)" }));
        }
        Promise.all(operation.animations.map(animation => animation.finished.catch(() => {}))).then(() => settle(detail, operation));
      });
    }
  }
  decorate(document);
  new MutationObserver(records => { for (const record of records) for (const node of record.addedNodes) if (node.nodeType === 1) decorate(node); }).observe(document.body, { childList: true, subtree: true });
  const finish = () => { for (const [detail, operation] of active) settle(detail, operation); };
  reduced.addEventListener?.("change", finish);
  document.addEventListener("visibilitychange", () => { if (document.hidden) finish(); });
  addEventListener("pagehide", finish);
})();
