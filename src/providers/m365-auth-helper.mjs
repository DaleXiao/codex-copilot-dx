// The native broker runs only in this short-lived child. Its stdout is a private
// parent pipe; no token or broker diagnostics are written to the user's terminal.
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { normalizeBrokerAccounts, chooseM365Account, windowsAccountHint } from "./m365-accounts.mjs";

export const M365_CLIENT_ID = "aebc6443-996d-45c2-90f0-388ff96faa56";
export const M365_RESOURCE = "42c8f7bd-c7a8-4ba9-bc1c-91edfb716247";
const AUTHORITY = "https://login.microsoftonline.com/organizations";
const fail = code => Object.assign(new Error(code), { code });

export function brokerFailure(error) {
  const states = { 2: "interaction_required", 3: "network_unavailable", 4: "network_unavailable",
    5: "service_unavailable", 9: "broker_configuration", 11: "authority_untrusted", 13: "account_unavailable", 16: "account_unavailable" };
  const code = /^m365_[a-z_]+$/.test(error?.code || "") ? error.code : `m365_${states[error?.errorStatus] || "broker_error"}`;
  return { code, aadsts: [...new Set(String(error?.errorContext || "").match(/AADSTS\d+/g) || [])].slice(0, 3) };
}

export async function acquireSilentM365Token({ account = null, action = "token" } = {}, {
  platform = process.platform, loadBroker = () => createRequire(import.meta.url)("@azure/msal-node-runtime").msalNodeRuntime,
  execFileImpl = promisify(execFile), env = process.env,
} = {}) {
  if (!["darwin", "win32"].includes(platform)) throw fail("m365_platform_unsupported");
  if (platform === "darwin") {
    let output;
    try { output = await execFileImpl("/usr/bin/profiles", ["status", "-type", "enrollment"],
      { timeout: 4000, maxBuffer: 8192, env: { ...process.env, LANG: "C", LC_ALL: "C" } }); }
    catch { throw fail("m365_device_status_unavailable"); }
    if (!/^MDM enrollment:\s*Yes\b/m.test(output.stdout || "")) throw fail("m365_device_not_managed");
  }
  let broker;
  try { broker = loadBroker(); } catch { throw fail("m365_broker_missing"); }
  if (!broker || broker.StartupError) throw fail("m365_broker_unavailable");
  const invoke = (method, ...args) => new Promise((resolve, reject) => {
    try { broker[method](...args, result => { try { result.CheckError();resolve(result); } catch (error) { reject(error); } }); }
    catch (error) { reject(error); }
  });
  const discovered = await invoke("DiscoverAccountsAsync", M365_CLIENT_ID, randomUUID());
  const accounts = normalizeBrokerAccounts(discovered.accounts || []);
  const windowsLogin = (!account || action === "accounts") && accounts.length > 1
    ? await windowsAccountHint({ platform, env, execFileImpl }) : null;
  if (action === "accounts") return { accounts: accounts.map(({ native, ...value }) => value), windowsLogin };
  const selected = chooseM365Account(accounts, { binding: account, windowsLogin }), parameters = new broker.AuthParameters();
  parameters.CreateAuthParameters(M365_CLIENT_ID, AUTHORITY);
  parameters.SetRedirectUri(platform === "darwin" ? "msauth.com.msauth.unsignedapp://auth" : `ms-appx-web://Microsoft.AAD.BrokerPlugin/${M365_CLIENT_ID}`);
  parameters.SetRequestedScopes(`${M365_RESOURCE}/.default`);
  const result = await invoke("AcquireTokenSilentlyAsync", parameters, randomUUID(), selected.native);
  if (!result.accessToken || !String(result.grantedScopes || "").split(" ").includes(`${M365_RESOURCE}/LLM.Read`)) throw fail("m365_llm_permission_unavailable");
  if (result.account && (result.account.homeAccountId !== selected.id || result.account.realm !== selected.tenant)) throw fail("m365_account_changed");
  return { token: result.accessToken, expiresAt: Number(result.expiresOn) * 1000,
    account: { id: selected.id, tenant: selected.tenant, login: selected.login, selection_source: selected.selection_source } };
}

async function main() {
  const timer = setTimeout(() => { process.stdout.write(JSON.stringify({ error: { code: "m365_auth_timeout" } }));process.exit(1); }, 25000);
  try {
    if (process.stdin.isTTY || process.stdout.isTTY) throw fail("m365_private_pipe_required");
    let input = "";
    for await (const chunk of process.stdin) {
      input += chunk.toString("utf8");
      if (Buffer.byteLength(input) > 4096) throw fail("m365_auth_request_invalid");
    }
    const request = JSON.parse(input);
    if (!["token", "accounts"].includes(request.action)) throw fail("m365_auth_request_invalid");
    const result = await acquireSilentM365Token(request);
    process.stdout.write(JSON.stringify(result), () => process.exit(0));
  } catch (error) { process.stdout.write(JSON.stringify({ error: brokerFailure(error) }), () => process.exit(1)); }
  finally { clearTimeout(timer); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
