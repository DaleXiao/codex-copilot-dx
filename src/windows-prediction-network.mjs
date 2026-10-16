import { Script } from "node:vm";
import { predictionProxyExpression } from "./prediction-pac.mjs";
import { startWindowsHttpNetwork } from "./windows-http-network.mjs";

function failure(code) {
  return Object.assign(new Error(`Windows prediction network failed (${code}); existing company routes were preserved`), { code });
}

export function companyPredictionPac(script, port) {
  if (typeof script !== "string" || Buffer.byteLength(script) > 1024 * 1024 || !Number.isInteger(port) || port < 1 || port > 65535) throw failure("proxy_pac_invalid");
  // Compile only for syntax validation; never execute a downloaded PAC in Node.
  const combined = `var ccdxCompanyRoute=(function(){\n${script}\n;return FindProxyForURL;})();\nfunction FindProxyForURL(url,host){var original=ccdxCompanyRoute(url,host);if(url.indexOf('https:')===0&&(host==='chatgpt.com'||host==='ab.chatgpt.com'))return ${predictionProxyExpression(port)}+'; '+original;return original;}\n`;
  try { new Script(combined); } catch { throw failure("proxy_pac_invalid"); }
  return combined;
}

export async function startWindowsPredictionNetwork(options = {}) {
  const network = await startWindowsHttpNetwork({ ...options, target: "prediction", validatePac: script => companyPredictionPac(script, 1) });
  return { ...network, pac: port => companyPredictionPac(network.script, port) };
}
