import net from "node:net";

const OFFICIAL_API = "https://chatgpt.com/backend-api";

function proxy(value, source) {
  if (!value) return null;
  let url;
  try { url = new URL(value); } catch { throw new Error(`Invalid proxy address in ${source}`); }
  if (!["http:", "https:", "socks5:", "socks5h:"].includes(url.protocol)
    || !url.hostname || !["", "/"].includes(url.pathname) || url.search || url.hash) {
    throw new Error(`Unsupported proxy address in ${source}; expected HTTP, HTTPS or SOCKS5`);
  }
  return { url, source };
}

function variable(env, lower, upper) {
  const key = String(env[lower] || "").trim() ? lower : upper;
  return { value: String(env[key] || "").trim(), source: key };
}

export function resolveNetworkRoute({ env = process.env, systemProxy = "", checkApi = true } = {}) {
  const api = String(env.CODEX_API_BASE_URL || "").trim().replace(/\/+$/, "");
  if (checkApi && api && api !== OFFICIAL_API) {
    throw new Error("Native prediction setup skipped: CODEX_API_BASE_URL selects a custom API route; it was preserved");
  }
  const settings = Object.fromEntries([...systemProxy.matchAll(/^\s*([A-Za-z]+)\s*:\s*(.+?)\s*$/gm)].map((m) => [m[1], m[2]]));
  for (const key of ["ProxyAutoConfigEnable", "ProxyAutoDiscoveryEnable"]) {
    if (settings[key] === "1") throw new Error(`Native prediction setup skipped: system ${key === "ProxyAutoConfigEnable" ? "PAC" : "WPAD"} (${key}) needs dynamic routing; its rules were preserved`);
  }
  const system = (prefix, scheme) => {
    if (settings[`${prefix}Enable`] !== "1") return null;
    const host = settings[`${prefix}Proxy`], port = settings[`${prefix}Port`];
    if (!host || !/^\d+$/.test(port || "") || Number(port) < 1 || Number(port) > 65535) {
      throw new Error(`Invalid system ${prefix} proxy settings`);
    }
    return proxy(`${scheme}://${net.isIP(host) === 6 ? `[${host}]` : host}:${port}`, `system ${prefix}`);
  };
  const httpEnv = variable(env, "http_proxy", "HTTP_PROXY"), httpsEnv = variable(env, "https_proxy", "HTTPS_PROXY");
  const allEnv = variable(env, "all_proxy", "ALL_PROXY");
  const all = proxy(allEnv.value, allEnv.source);
  const systemSocks = system("SOCKS", "socks5");
  const systemHttp = system("HTTP", "http"), systemHttps = system("HTTPS", "http");
  const http = proxy(httpEnv.value, httpEnv.source) || all || systemHttp || systemSocks;
  const https = proxy(httpsEnv.value, httpsEnv.source) || all || systemHttps || systemSocks;
  const noProxy = variable(env, "no_proxy", "NO_PROXY").value;
  const exceptions = /ExceptionsList\s*:\s*<array>\s*\{([^}]+)\}/.exec(systemProxy)?.[1] || "";
  const bypass = [...new Set([...noProxy.split(","), ...[...exceptions.matchAll(/\d+\s*:\s*([^\n]+)/g)].map((m) => m[1])]
    .map((s) => s.trim().toLowerCase()).filter(Boolean))];
  if (bypass.some((rule) => rule.includes("/"))) throw new Error("Unsupported proxy bypass CIDR rule in NO_PROXY or system exceptions; existing routes were preserved");
  return { http, https, bypass, excludeSimple: settings.ExcludeSimpleHostnames === "1" };
}

export function bypassNetworkProxy(hostname, port, plan) {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (["localhost", "127.0.0.1", "::1"].includes(host) || (plan.excludeSimple && !host.includes("."))) return true;
  return plan.bypass.some((raw) => {
    if (raw === "*") return true;
    const match = /^(.*):(\d+)$/.exec(raw);
    const rule = match ? match[1] : raw;
    if (match && Number(match[2]) !== Number(port)) return false;
    const suffix = rule.replace(/^\*?\./, "");
    if (rule.includes("*")) {
      const expression = rule.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
      return new RegExp(`^${expression}$`).test(host);
    }
    return host === suffix || host.endsWith(`.${suffix}`);
  });
}

export function networkProxyFor(url, plan) {
  if (bypassNetworkProxy(url.hostname, url.port || (url.protocol === "https:" ? 443 : 80), plan)) return null;
  return url.protocol === "https:" ? plan.https : plan.http;
}

export function networkRouteSnapshot(plan) {
  const route = plan.https;
  return { source: route?.source || "direct", type: route?.url.protocol.replace(":", "") || "direct",
    bypass_rules: plan.bypass.length, proxy_credentials: Boolean(route?.url.username || route?.url.password) };
}

function pacProxy(route) {
  if (!route) return "DIRECT";
  const type = route.url.protocol.startsWith("socks5") ? "SOCKS5" : route.url.protocol === "https:" ? "HTTPS" : "PROXY";
  const port = route.url.port || (type === "HTTPS" ? 443 : type === "SOCKS5" ? 1080 : 80);
  return `${type} ${route.url.hostname}:${port}`;
}

export function networkPredictionPac(port, plan) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid prediction proxy port");
  // Embed only routing rules, never proxy passwords or API credentials.
  return `var ccdxRoute=${JSON.stringify({ http: pacProxy(plan.http), https: pacProxy(plan.https), bypass: plan.bypass, excludeSimple: plan.excludeSimple })};
function FindProxyForURL(url,host) {
  var secure=url.indexOf('https:')===0, p=secure?443:80;
  var authority=url.split('/')[2]||'', explicit=/:([0-9]+)$/.exec(authority);if(explicit)p=Number(explicit[1]);
  var skip=host==='localhost'||host==='127.0.0.1'||host==='::1'||(ccdxRoute.excludeSimple&&host.indexOf('.')<0);
  for(var i=0;i<ccdxRoute.bypass.length&&!skip;i++){var raw=ccdxRoute.bypass[i],m=/^(.*):([0-9]+)$/.exec(raw),r=m?m[1]:raw;if(m&&Number(m[2])!==p)continue;
    var suffix=r.indexOf('*.')===0?r.slice(2):r[0]==='.'?r.slice(1):r;skip=r==='*'||(r.indexOf('*')>=0?shExpMatch(host,r):host===suffix||dnsDomainIs(host,'.'+suffix));}
  var original=skip?'DIRECT':secure?ccdxRoute.https:ccdxRoute.http;
  if(secure&&(host==='chatgpt.com'||host==='ab.chatgpt.com'))return 'PROXY 127.0.0.1:${port}; '+original;
  return original;
}\n`;
}
