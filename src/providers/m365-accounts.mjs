import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const fail = code => Object.assign(new Error(code), { code });
const clean = (value, limit) => typeof value === "string" && value.length > 0 && value.length <= limit && !/[\u0000-\u0020\u007f]/.test(value);
export const accountChoiceId = account => createHash("sha256").update(`${account.tenant}\0${account.id}`).digest("hex");

export function normalizeBrokerAccounts(values) {
  if (!Array.isArray(values) || values.length > 128) throw fail("m365_accounts_invalid");
  const accounts = new Map();
  for (const value of values) {
    if (!clean(value?.homeAccountId, 512) || !clean(value.realm, 128) || !clean(value.username, 320) || !clean(value.accountId, 512)) continue;
    // Personal Microsoft accounts cannot authorize this organization-only service.
    if (value.realm.toLowerCase() === "9188040d-6c67-4c5b-b112-36a304b66dad") continue;
    const account = { id: value.homeAccountId, tenant: value.realm, login: value.username };
    const key = accountChoiceId(account), prior = accounts.get(key);
    if (prior && (prior.login.toLowerCase() !== account.login.toLowerCase()
      || prior.native.environment !== value.environment || prior.native.localAccountId !== value.localAccountId)) throw fail("m365_account_conflict");
    if (!prior) accounts.set(key, { ...account, native: value });
  }
  return [...accounts.values()];
}

export async function windowsAccountHint({ platform = process.platform, env = process.env, signal, execFileImpl = promisify(execFile) } = {}) {
  if (platform !== "win32") return null;
  try {
    const { stdout } = await execFileImpl(path.win32.join(env.SystemRoot || env.WINDIR || "C:\\Windows", "System32", "whoami.exe"), ["/upn"],
      { env, signal, timeout: 2500, maxBuffer: 8192, windowsHide: true, encoding: "utf8" });
    const upn = stdout.trim();
    return clean(upn, 320) && /^[^@\s]+@[^@\s]+$/.test(upn) ? upn : null;
  } catch { return null; }
}

export function chooseM365Account(accounts, { binding, windowsLogin } = {}) {
  if (binding) {
    const matches = accounts.filter(value => value.id === binding.id && value.tenant === binding.tenant);
    if (matches.length !== 1) throw fail("m365_account_unavailable");
    return { ...matches[0], selection_source: ["manual", "windows", "single"].includes(binding.selection_source) ? binding.selection_source : "legacy" };
  }
  if (!accounts.length) throw fail("m365_account_unavailable");
  const current = windowsLogin && accounts.filter(value => value.login.toLowerCase() === windowsLogin.toLowerCase());
  if (current?.length === 1) return { ...current[0], selection_source: "windows" };
  if (accounts.length === 1) return { ...accounts[0], selection_source: "single" };
  throw fail("m365_account_ambiguous");
}

export function publicM365Accounts(accounts, { binding, windowsLogin } = {}) {
  const matches = windowsLogin ? accounts.filter(value => value.login.toLowerCase() === windowsLogin.toLowerCase()) : [];
  return accounts.map(account => ({ id: accountChoiceId(account), login: account.login, tenant: account.tenant,
    selected: Boolean(binding && binding.id === account.id && binding.tenant === account.tenant),
    current_windows: matches.length === 1 && matches[0] === account }));
}

export function m365AccountMessage(code) {
  return ({ m365_account_ambiguous: "Choose a company account in Model sources or run ccdx source m365 account.",
    m365_account_unavailable: "Company account unavailable. Connect it in Windows or macOS, then check again.",
    m365_account_conflict: "Account records conflict. Check your company sign-in, then check again.",
    m365_interaction_required: "Complete your company sign-in, then check again.",
    m365_llm_permission_unavailable: "This account does not have model access.",
    m365_account_busy: "Finish active Microsoft 365 requests before changing accounts.",
    m365_account_changed: "This conversation belongs to another company account. Start a new conversation.",
    m365_catalog_http_403: "Model access was denied. Check company permissions and network policy.",
    m365_catalog_http_401: "Company authorization was rejected. Check your sign-in and company policy." })[code] || "Microsoft 365 is unavailable. Check company sign-in, network and permissions.";
}
