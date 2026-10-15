import net from "node:net";
import { compileBypassRules, matchesBypass, bypassPacSource } from "./network-bypass.mjs";
import { predictionProxyExpression } from "./prediction-pac.mjs";

const OFFICIAL_API = "https://chatgpt.com/backend-api";
const routeError = (code, message) => Object.assign(new Error(message), { code });

function proxy(value, source) {
  if (!value) return null;
  let url;
  try { url = new URL(value); } catch { throw routeError("proxy_address_invalid", `Invalid proxy address in ${source}`); }
  if (!["http:", "https:", "socks5:", "socks5h:"].includes(url.protocol)
    || !url.hostname || !["", "/"].includes(url.pathname) || url.search || url.hash) {
    throw routeError("proxy_address_unsupported", `Unsupported proxy address in ${source}; expected HTTP, HTTPS or SOCKS5`);
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
    throw routeError("prediction_route_conflict", "Native prediction setup skipped: CODEX_API_BASE_URL selects a custom API route; it was preserved");
  }
  const settings = Object.fromEntries([...systemProxy.matchAll(/^\s*([A-Za-z]+)\s*:\s*(.+?)\s*$/gm)].map((m) => [m[1], m[2]]));
  for (const key of ["ProxyAutoConfigEnable", "ProxyAutoDiscoveryEnable"]) {
    if (settings[key] === "1") throw routeError("proxy_dynamic_unsupported", `Native prediction setup skipped: system ${key === "ProxyAutoConfigEnable" ? "PAC" : "WPAD"} (${key}) needs dynamic routing; its rules were preserved`);
  }
  const system = (prefix, scheme) => {
    if (settings[`${prefix}Enable`] !== "1") return null;
    const host = settings[`${prefix}Proxy`], port = settings[`${prefix}Port`];
    if (!host || !/^\d+$/.test(port || "") || Number(port) < 1 || Number(port) > 65535) {
      throw routeError("proxy_system_invalid", `Invalid system ${prefix} proxy settings`);
    }
    return proxy(`${scheme}://${net.isIP(host) === 6 ? `[${host}]` : host}:${port}`, `system ${prefix}`);
  };
  const httpEnv = variable(env, "http_proxy", "HTTP_PROXY"), httpsEnv = variable(env, "https_proxy", "HTTPS_PROXY");
  const allEnv = variable(env, "all_proxy", "ALL_PROXY");
  const http = proxy(httpEnv.value, httpEnv.source) || proxy(allEnv.value, allEnv.source) || system("HTTP", "http") || system("SOCKS", "socks5");
  const https = proxy(httpsEnv.value, httpsEnv.source) || proxy(allEnv.value, allEnv.source) || system("HTTPS", "http") || system("SOCKS", "socks5");
  const noProxy = variable(env, "no_proxy", "NO_PROXY").value;
  const exceptions = /ExceptionsList\s*:\s*<array>\s*\{([^}]+)\}/.exec(systemProxy)?.[1] || "";
  const bypass = [...new Set([...noProxy.split(","), ...[...exceptions.matchAll(/\d+\s*:\s*([^\n]+)/g)].map((m) => m[1])]
    .map((s) => s.trim().toLowerCase()).filter(Boolean))];
  return { http, https, bypass, rules: compileBypassRules(bypass), excludeSimple: settings.ExcludeSimpleHostnames === "1" };
}

export function bypassNetworkProxy(hostname, port, plan) {
  return matchesBypass(hostname, port, plan.rules || compileBypassRules(plan.bypass), plan.excludeSimple);
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
  return `${bypassPacSource()}
var ccdxRoute=${JSON.stringify({ http: pacProxy(plan.http), https: pacProxy(plan.https), rules: plan.rules || compileBypassRules(plan.bypass), excludeSimple: plan.excludeSimple })};
function FindProxyForURL(url,host) {
  var secure=url.indexOf('https:')===0, p=secure?443:80;
  var authority=url.split('/')[2]||'', explicit=/:([0-9]+)$/.exec(authority);if(explicit)p=Number(explicit[1]);
  var skip=matchesBypass(host,p,ccdxRoute.rules,ccdxRoute.excludeSimple);
  var original=skip?'DIRECT':secure?ccdxRoute.https:ccdxRoute.http;
  if(secure&&(host==='chatgpt.com'||host==='ab.chatgpt.com'))return ${predictionProxyExpression(port)}+'; '+original;
  return original;
}\n`;
}
