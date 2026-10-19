import test from "node:test";
import assert from "node:assert/strict";
import { normalizeBrokerAccounts, chooseM365Account, windowsAccountHint, publicM365Accounts } from "../src/providers/m365-accounts.mjs";

const native = (id = "a", tenant = "company", login = `${id}@example.test`) => ({ accountId: `native-${id}-${tenant}`, homeAccountId: id, realm: tenant, username: login, environment: "login.microsoftonline.com", localAccountId: id });

test("company accounts deduplicate stable identities but retain separate tenants and reject conflicting records", () => {
  const values = normalizeBrokerAccounts([native(), native(), native("a", "guest"), native("personal", "9188040d-6c67-4c5b-b112-36a304b66dad"), {}]);
  assert.equal(values.length, 2);assert.notEqual(values[0].tenant, values[1].tenant);
  assert.throws(() => normalizeBrokerAccounts([native(), { ...native(), localAccountId: "another" }]), { code: "m365_account_conflict" });
  assert.throws(() => normalizeBrokerAccounts(Array(129).fill(native())), { code: "m365_accounts_invalid" });
});

test("saved binding outranks Windows sign-in; a missing binding never silently changes companies", () => {
  const accounts = normalizeBrokerAccounts([native("a"), native("b")]);
  assert.equal(chooseM365Account(accounts, { binding: { id: "a", tenant: "company", selection_source: "manual" }, windowsLogin: "b@example.test" }).id, "a");
  assert.equal(chooseM365Account(accounts, { binding: { id: "a", tenant: "company" } }).selection_source, "legacy");
  assert.throws(() => chooseM365Account(accounts, { binding: { id: "missing", tenant: "company" } }), { code: "m365_account_unavailable" });
});

test("unique exact OS principal wins; local Windows plus one Office account works; shared UPNs require a choice", () => {
  const accounts = normalizeBrokerAccounts([native("a"), native("b")]);
  assert.equal(chooseM365Account(accounts, { windowsLogin: "B@example.test" }).selection_source, "windows");
  assert.equal(chooseM365Account(accounts.slice(0, 1)).selection_source, "single");
  assert.throws(() => chooseM365Account(accounts), { code: "m365_account_ambiguous" });
  assert.throws(() => chooseM365Account(normalizeBrokerAccounts([native("a", "one", "same@example.test"), native("b", "two", "same@example.test")]), { windowsLogin: "same@example.test" }), { code: "m365_account_ambiguous" });
  assert.throws(() => chooseM365Account([]), { code: "m365_account_unavailable" });
});

test("Windows identity is read from the system executable with fixed arguments, never the device registration or environment username", async () => {
  let called = 0;
  const result = await windowsAccountHint({ platform: "win32", env: { SystemRoot: "C:\\Windows", USERNAME: "wrong" }, execFileImpl: async (file, args, options) => {
    called++;assert.equal(file, "C:\\Windows\\System32\\whoami.exe");assert.deepEqual(args, ["/upn"]);assert.equal(options.windowsHide, true);return { stdout: "person@example.test\r\n" };
  } });
  assert.equal(result, "person@example.test");assert.equal(called, 1);
  assert.equal(await windowsAccountHint({ platform: "win32", execFileImpl: async () => { throw Error("local account"); } }), null);
  assert.equal(await windowsAccountHint({ platform: "win32", execFileImpl: async () => ({ stdout: "one@example.test\ntwo@example.test" }) }), null);
  assert.equal(await windowsAccountHint({ platform: "darwin", execFileImpl: () => assert.fail() }), null);
});

test("public choices contain no native identifiers or tokens, and a recommendation never changes the binding", () => {
  const accounts = normalizeBrokerAccounts([native("a"), native("b")]);
  const result = publicM365Accounts(accounts, { windowsLogin: "b@example.test", binding: accounts[0] });
  assert.equal(result[0].selected, true);assert.equal(result[1].current_windows, true);
  assert.match(result[0].id, /^[a-f0-9]{64}$/);assert.doesNotMatch(JSON.stringify(result), /native-|homeAccountId|accessToken/);
});
