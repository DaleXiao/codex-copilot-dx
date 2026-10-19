// Only fixed codes leave the network layer; raw proxy settings and errors do not.
const messages = Object.freeze({
  proxy_discovery_failed: "Could not read system proxy settings. Existing settings kept.",
  proxy_bypass_invalid: "Invalid proxy exception rule. Existing settings kept.",
  proxy_system_invalid: "Invalid system proxy address or port. Existing settings kept.",
  proxy_address_invalid: "Invalid proxy address. Existing settings kept.",
  proxy_address_unsupported: "Unsupported proxy address format. Existing settings kept.",
  proxy_dynamic_unsupported: "System PAC or WPAD is not supported. Existing settings kept.",
  proxy_settings_unsupported: "Could not interpret proxy settings. Existing settings kept.",
});

export function m365NetworkDiagnostic(value) {
  if (!value || !["system", "environment"].includes(value.source) || !Object.hasOwn(messages, value.cause_code)) return null;
  return { source: value.source, stage: value.cause_code === "proxy_discovery_failed" ? "proxy_discovery" : "proxy_config", cause_code: value.cause_code };
}

export function m365NetworkMessage(value) {
  const diagnostic = m365NetworkDiagnostic(value);
  return diagnostic ? messages[diagnostic.cause_code] : null;
}

export function m365ProxyFailure(error, source, category = "proxy_settings_unsupported") {
  const cause_code = Object.hasOwn(messages, error?.code) ? error.code : "proxy_settings_unsupported";
  const network_diagnostic = m365NetworkDiagnostic({ source, cause_code });
  return Object.assign(new Error(`Microsoft 365 network is unavailable (m365_${category})`, {
    cause: new Error(messages[cause_code]),
  }), { code: `m365_${category}`, statusCode: 503, network_diagnostic });
}
