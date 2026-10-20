import { execFileSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { readBoundedFileSync } from "./bounded-file.mjs";
import { resolveNetworkRoute, networkRouteSnapshot } from "./network-route.mjs";
import { windowsProxySettings, windowsProxyText } from "./native-prediction-windows.mjs";

const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function trustSnapshot(env, readFile) {
  let extraCa = "not_set", content = null;
  if (env.NODE_EXTRA_CA_CERTS) {
    try {
      const pem = readFile(env.NODE_EXTRA_CA_CERTS, { maxBytes: 1024 * 1024, encoding: "utf8" });
      content = digest(pem);
      const certificates = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) || [];
      if (!certificates.length) throw new Error("invalid");
      for (const certificate of certificates) new X509Certificate(certificate);
      extraCa = "configured";
    } catch { extraCa = "unreadable_or_invalid"; }
  }
  // Keys and paths participate only in a private comparison, never diagnostics.
  return { key: digest([env.NODE_EXTRA_CA_CERTS, env.NODE_OPTIONS, env.NODE_USE_SYSTEM_CA,
    env.SSL_CERT_FILE, env.SSL_CERT_DIR, content]),
  summary: { extra_ca: extraCa, tls_verification: "required", changes_require_service_restart: true } };
}

// Called only for enabled prediction startup or an explicit fix. No system
// policy, trust store, environment, PATH or account is written by discovery.
export function inspectPredictionEnvironment({ env = process.env, platform = process.platform,
  exec = execFileSync, readFile = readBoundedFileSync, now = () => new Date().toISOString() } = {}) {
  const trust = trustSnapshot(env, readFile);
  let network;
  try {
    if (platform === "win32") {
      const settings = windowsProxySettings({ exec, env });
      if (!settings.autoDetect && !settings.pac) network = { networkRoute: resolveNetworkRoute({ env, systemProxy: windowsProxyText(settings) }) };
      else {
        const explicit = resolveNetworkRoute({ env });
        if (explicit.http || explicit.https || explicit.bypass.length) {
          throw Object.assign(new Error("Windows automatic proxy and explicit proxy environment rules require separate routing; existing routes were preserved"), { code: "proxy_route_conflict" });
        }
        network = { settings };
      }
    } else {
      const systemProxy = platform === "darwin" ? exec("/usr/sbin/scutil", ["--proxy"], { encoding: "utf8", timeout: 2000, maxBuffer: 64 * 1024 }) : "";
      network = { networkRoute: resolveNetworkRoute({ env, systemProxy }) };
    }
  } catch (error) {
    error.predictionEnvironment = { status: "unavailable", checked_at: now(), tls: trust.summary };
    throw error;
  }
  const plan = network.networkRoute;
  const summary = { status: "adapted", checked_at: now(),
    network: plan ? { ...networkRouteSnapshot(plan), cidr_rules: plan.bypass.filter(rule => rule.includes("/")).length,
      dns: "system_or_proxy", http_source: plan.http?.source || "direct" }
      : { source: "system", type: "auto", bypass_rules: null, cidr_rules: null, dns: "native_policy" },
    tls: trust.summary };
  return { network, networkKey: digest(network), trustKey: trust.key, summary };
}
