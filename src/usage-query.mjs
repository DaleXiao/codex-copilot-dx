import { isProviderId } from "./provider-metadata.mjs";
import { usageProvider } from "./usage-store.mjs";

const DAY_MS = 86400000;
const dateValue = value => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value))
  && new Date(value).toISOString().slice(0, 10) === value;

export function createUsageQuery({ provider = "", model = "", days = "all", from = "", to = "", timeZone = "UTC", now = Date.now() } = {}) {
  if (typeof provider !== "string" || provider && !isProviderId(provider)) throw new Error("Select a valid usage source");
  if (typeof model !== "string" || model.length > 200 || /[\u0000-\u001f\u007f]/.test(model)) throw new Error("Select a valid usage model");
  if (String(days) !== "all" && (!/^\d+$/.test(String(days)) || Number(days) < 1 || Number(days) > 365)) throw new Error("Usage days must be all or an integer from 1 to 365");
  if (typeof timeZone !== "string" || timeZone.length > 100) throw new Error("Select a valid usage time zone");
  const zone = new Intl.DateTimeFormat("sv-SE", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  const today = zone.format(new Date(now));
  if (typeof from !== "string" || typeof to !== "string" || (from && !dateValue(from)) || (to && !dateValue(to))) throw new Error("Usage dates must use YYYY-MM-DD");
  if ((from || to) && String(days) !== "all") throw new Error("Choose usage days or explicit dates");
  if (String(days) !== "all") {
    to = today;from = new Date(Date.parse(today) - (Number(days) - 1) * DAY_MS).toISOString().slice(0, 10);
  }
  if (from && !to) to = today;
  if (from && to && from > to) throw new Error("Usage start date must not follow its end date");
  const filters = { provider, model, days: String(days), from, to, time_zone: zone.resolvedOptions().timeZone };
  return {
    filters,
    key: JSON.stringify(filters),
    matches(record) {
      if (provider && usageProvider(record) !== provider) return false;
      if (model && model !== record.model && model !== `${usageProvider(record)} / ${record.model || "unknown"}`) return false;
      if (!from && !to) return true;
      const stamp = typeof record.ts === "string" ? Date.parse(record.ts) : NaN;
      if (!Number.isFinite(stamp) || stamp > now) return false;
      const date = zone.format(new Date(stamp));
      return (!from || date >= from) && (!to || date <= to);
    },
  };
}
