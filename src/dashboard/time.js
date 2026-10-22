(() => {
  const formats = new Map();
  function format(value, { date = false } = {}) {
    if (value === null || value === undefined || value === "") return "—";
    const instant = new Date(value);
    if (!Number.isFinite(instant.getTime())) return "—";
    const locale = document.documentElement.lang?.startsWith("zh") ? "zh-CN" : "en-US";
    const key = `${locale}/${date}`;
    if (!formats.has(key)) formats.set(key, new Intl.DateTimeFormat(locale, {
      ...(date ? { year: "numeric", month: "2-digit", day: "2-digit" } : {}),
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    }));
    return formats.get(key).format(instant);
  }
  globalThis.ccdxTime = { format };
})();
