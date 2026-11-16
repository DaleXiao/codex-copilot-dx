import { claudeNativeModelHint } from "./claude-app-contract.mjs";
import { claudeEffortPrefix } from "./model-capabilities.mjs";

export function claudeEffortControl(capability, support = {}) {
  const values = capability?.values || {}, levels = values.reasoning === false || !Array.isArray(values.reasoning_efforts) ? [] : values.reasoning_efforts;
  if (!levels.length) return Array.isArray(values.reasoning_efforts) || values.reasoning === false ? "unsupported" : "unknown";
  const native = support.app && (support.app_contract?.status === "verified"
    ? Boolean(claudeNativeModelHint(values, support.app_contract))
    : !support.app_contract && claudeEffortPrefix(values).length === levels.length);
  return native ? "native" : "gateway";
}

export function effortUnavailable() {
  return Object.assign(new Error("The saved reasoning level is unavailable. Choose a declared level or follow the app."),
    { code: "ccdx_client_effort_unavailable", statusCode: 400 });
}

export function messagesWithEffortDefault(body, effort, capability) {
  if (!effort) return body;
  const config = body.output_config;
  if (config !== undefined && (!config || typeof config !== "object" || Array.isArray(config))) {
    throw Object.assign(new Error("output_config must be an object"), { code: "ccdx_messages_invalid", statusCode: 400 });
  }
  if (config && Object.hasOwn(config, "effort")) return body;
  const values = capability?.values || {};
  if (values.reasoning === false || !Array.isArray(values.reasoning_efforts) || !values.reasoning_efforts.includes(effort)) throw effortUnavailable();
  return { ...body, output_config: { ...config, effort } };
}
