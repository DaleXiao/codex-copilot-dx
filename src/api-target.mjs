// Pagination is the only query accepted by custom-source transports. Never
// follow an arbitrary next URL or allow catalog queries on inference endpoints.
export function apiTargetAllowed(raw, targets, method = "GET") {
  let url;try { url = new URL(raw); } catch { return false; }
  if (targets.includes(url.href)) return true;
  if (method !== "GET" || url.hash || !url.pathname.endsWith("/models") || [...url.searchParams.keys()].join() !== "after_id") return false;
  const cursor = url.searchParams.get("after_id");
  if (!/^[\w][\w./:@+-]{0,159}$/.test(cursor || "") || cursor.includes("..") || cursor.includes("//")) return false;
  url.search = "";return targets.includes(url.href);
}
