// Pagination is the only query accepted by custom-source transports. Never
// follow an arbitrary next URL or allow catalog queries on inference endpoints.
export function apiTargetAllowed(raw, targets, method = "GET", geminiModelsUrl) {
  let url;try { url = new URL(raw); } catch { return false; }
  if (targets.includes(url.href)) return true;
  if (geminiModelsUrl && !url.hash && !url.username && !url.password) {
    const root = new URL(geminiModelsUrl);
    if (url.origin === root.origin) {
      if (method === "GET" && url.pathname === root.pathname && [...url.searchParams.keys()].join() === "pageToken")
        return /^[\w.%~+/=-]{1,2048}$/.test(url.searchParams.get("pageToken") || "");
      if (method === "POST" && url.pathname.startsWith(root.pathname + "/")) {
        const match = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,139}:(generateContent|streamGenerateContent|countTokens)$/.exec(url.pathname.slice(root.pathname.length + 1));
        if (match) return match[1] === "streamGenerateContent" ? url.search === "?alt=sse" : url.search === "";
      }
    }
  }
  if (method !== "GET" || url.hash || !url.pathname.endsWith("/models") || [...url.searchParams.keys()].join() !== "after_id") return false;
  const cursor = url.searchParams.get("after_id");
  if (!/^[\w][\w./:@+-]{0,159}$/.test(cursor || "") || cursor.includes("..") || cursor.includes("//")) return false;
  url.search = "";return targets.includes(url.href);
}
