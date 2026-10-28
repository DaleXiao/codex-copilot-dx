import { isProviderId } from "./provider-metadata.mjs";

export const CLI_CLIENTS = Object.freeze({ codex: "codex", "claude-app": "claude_app", "claude-code": "claude_code" });
const read = { "--format": "format" }, confirm = { "--yes": "flag", "--preview": "flag" };
const command = (path, description, options = {}, legacy) => ({ path: path.split(" "), description, options, legacy });
// Canonical routes, their arguments and nearby help share one definition. Legacy
// roots keep the old parser and output contracts rather than being reinterpreted.
export const MANAGED_COMMANDS = [
  command("source list", "List registered model sources", read),
  command("source add", "Save an API and read its model catalog", { "--file": "value", "--key-stdin": "flag", ...confirm }),
  command("source <source> status", "Show saved sign-in and catalog evidence", read),
  command("source <source> models", "Show the source catalog; refresh explicitly", { ...read, "--refresh": "flag" }),
  command("source <source> check", "Check source access without inference", read),
  command("source <source> edit", "Edit API configuration and model selection", { "--file": "value", "--key-stdin": "flag", ...confirm }),
  command("source <source> access", "Show or edit client authorization", { ...read, "--edit": "flag", "--apps": "value", ...confirm }),
  command("source <source> enable", "Enable a source without selecting client models", confirm),
  command("source <source> disable", "Review affected clients before disabling", { ...confirm, "--replacements": "value" }),
  command("source <source> remove", "Remove a disabled, unbound API source", confirm),
  ...["login", "reauth", "logout"].map(action => command(`source github ${action}`, "Manage GitHub sign-in only", action === "logout" ? { "--yes": "flag" } : { "--login": "value" }, flags => ["auth", action, ...Object.entries(flags).flatMap(([key, value]) => value === true ? [`--${key}`] : [`--${key}`, value])])),
  ...["accounts", "account"].map(action => command(`source m365 ${action}`, "Read or select a shared company account", action === "account" ? { "--id": "value" } : {}, flags => ["m365", action, ...(flags.id ? ["--id", flags.id] : [])])),
  command("app list", "List client configuration and observed activity", read),
  command("app <app> status", "Show configuration, not process liveness", { ...read, "--details": "flag" }),
  command("app <app> models", "Show or edit the client's selected model plan", { ...read, "--edit": "flag", "--file": "value", ...confirm }),
  command("app <app> sync", "Preview or write CCDX-owned client configuration", confirm),
  command("app <app> enable", "Enable client access with its saved selection", confirm),
  command("app <app> disable", "Disable access without quitting the app", confirm),
  command("app codex prediction status", "Show Codex prediction setup and observation", read),
  ...["setup", "remove", "pause", "resume", "repair"].map(action => command(`app codex prediction ${action}`, "Manage the optional Codex prediction integration", {}, () => ["prediction", { setup: "on", remove: "off", repair: "fix" }[action] || action])),
  command("app codex image status", "Show Codex image setup; do not generate", read),
  ...["setup", "remove", "pause", "resume"].map(action => command(`app codex image ${action}`, "Manage the Codex image integration", {}, () => action === "setup" ? ["enable-image"] : action === "remove" ? ["disable-image"] : ["image", action])),
  command("app codex review status", "Show the Codex Auto-review selection", read),
  command("app codex review select", "Choose the Codex Auto-review model", {}, () => ["auto-review-model"]),
  command("config show", "Show service and terminal preferences", { ...read, "--effective": "flag" }),
  command("config set <key> <value>", "Save a validated service preference", confirm),
  command("config terminal", "Choose terminal color", {}),
  command("config animation", "Choose terminal animation", {}, () => ["animation"]),
  command("config limits", "Show or set decoded-body limits", { "--decoded": "value" }, flags => ["limits", ...(flags.decoded ? ["--decoded", flags.decoded] : [])]),
  command("config reset", "Back up and restore service preferences to defaults", confirm),
  command("config restore", "Restore the current service preference backup", confirm),
  command("doctor cache", "Inspect or clear bounded runtime buffers", { "--limit": "value", "--clean": "flag", "--history": "flag", "--yes": "flag" }, flags => ["cache", ...Object.entries(flags).flatMap(([key, value]) => value === true ? [`--${key}`] : [`--${key}`, value])]),
  command("requests", "Show bounded recent model requests", { ...read, "--active": "flag", "--failed": "flag", "--app": "value", "--source": "value", "--limit": "integer" }),
  command("requests show <request>", "Show a retained request and its original diagnostic fields", read),
  command("status", "Show service state; expand diagnostics explicitly", { ...read, "--details": "flag" }),
  command("usage", "Show all recorded usage or this service run", { ...read, "--scope": "scope", "--provider": "value" }),
  command("update check", "Check a stable release without installing", read),
];

function pathMatch(pattern, values, partial = false) {
  if ((!partial && pattern.length !== values.length) || partial && pattern.length < values.length) return null;
  const found = {};
  for (let index = 0; index < values.length; index++) {
    const token = pattern[index], value = values[index];
    if (token.startsWith("<")) {
      const key = token.slice(1, -1);
      if (key === "source" && !isProviderId(value) || key === "app" && !Object.hasOwn(CLI_CLIENTS, value)) return null;
      found[key] = value;
    } else if (token !== value) return null;
  }
  return found;
}
function optionsFor(args, definition) {
  const values = {};
  for (let index = 0; index < args.length; index++) {
    const option = args[index], type = definition.options[option], key = option.replace(/^--/, "").replaceAll("-", "_");
    if (!type || Object.hasOwn(values, key)) throw new Error(`Unexpected or repeated option: ${option}`);
    if (type === "flag") { values[key] = true;continue; }
    const value = args[++index];
    if (!value || value.startsWith("--")) throw new Error(`Enter a value for ${option}`);
    if (type === "format" && !["table", "plain", "json"].includes(value)) throw new Error("Format must be table, plain or json");
    if (type === "scope" && !["run", "all"].includes(value)) throw new Error("Scope must be run or all");
    if (type === "integer" && (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 100)) throw new Error("Limit must be an integer from 1 to 100");
    values[key] = type === "integer" ? Number(value) : value;
  }
  if (values.app && !Object.hasOwn(CLI_CLIENTS, values.app)) throw new Error("Choose codex, claude-app or claude-code");
  if (values.provider && !isProviderId(values.provider)) throw new Error("Enter a valid usage source ID");
  if (values.source && !isProviderId(values.source)) throw new Error("Enter a listed source ID");
  if (values.active && values.failed) throw new Error("Choose --active or --failed");
  if (values.apps !== undefined && !values.edit) throw new Error("--apps requires --edit");
  if (values.file && definition.path[0] === "app" && !values.edit) throw new Error("--file requires --edit");
  if ((values.active || values.failed || values.edit || values.preview) && values.format === "json" && values.edit) throw new Error("Interactive edits do not use JSON output");
  return values;
}
export function parseManagedCommand(args) {
  const root = args[0];
  const applicable = ["app", "config", "requests"].includes(root)
    || root === "source" && (args.length > 2 && !args[2].startsWith("-") || ["list", "add"].includes(args[1]))
    || root === "doctor" && args[1] === "cache"
    || root === "update" && args[1] === "check"
    || root === "status" && args.some(value => value.startsWith("--"))
    || root === "usage" && (args.includes("--scope") || args[args.indexOf("--format") + 1] === "json");
  if (!applicable) return null;
  const optionAt = args.findIndex(value => value.startsWith("--")), words = optionAt < 0 ? args : args.slice(0, optionAt);
  const candidates = MANAGED_COMMANDS.filter(item => pathMatch(item.path, words));
  const definition = candidates.sort((a, b) => a.path.filter(token => token.startsWith("<")).length - b.path.filter(token => token.startsWith("<")).length)[0];
  if (!definition) throw new Error(`Unknown command path: ${words.join(" ")}. Use ccdx ${root} --help`);
  const values = optionsFor(optionAt < 0 ? [] : args.slice(optionAt), definition), ids = pathMatch(definition.path, words);
  if (definition.legacy) return { legacy: definition.legacy(values) };
  return { command: "manage", group: root, path: words, ids, flags: values };
}

const extras = {
  source: "Status reads local/cached evidence. check/--refresh may contact the source; no inference.\nSource access grants do not select client models. Disable previews affected clients.\nGitHub login and company-account selection are source-specific.\nLegacy ccdx source github|m365 still switches Codex only.",
  app: "Configured is not App adoption or process liveness. Unknown stays unknown.\nmodels shows the selected plan; source <id> models shows the upstream catalog.\nsetup/remove changes integration setup; pause/resume retains credentials.\nsync --preview shows the model/configuration plan, not a byte-level file diff.\nNo client program is force-restarted.",
  config: "Only service and terminal preferences are in scope. Browser appearance stays in WebUI.\nReset keeps accounts, keys, model plans and chats and stores a pre-reset backup.\nSaved and effective values can differ; restart requirements remain explicit.",
  requests: "Only retained records are available. Unknown clients are not guessed from an API route.\n--failed filters failed model outcomes and structured HTTP/model errors.\nUsage records, HTTP calls and model outcomes are distinct counters.",
  status: "Default interactive status is brief; --details retains the complete diagnostic view.\nThe installed package version can differ from the running service.\nA listening gateway does not prove upstream model access.",
  usage: "Default legacy usage remains all recorded usage. --scope run reads the running service.\nUsage records are not billed request counts. Cache hit is a token-reuse estimate.",
  doctor: "Legacy cache flags and confirmation rules remain. --history may break chat continuation.",
  update: "check does not install. Existing update github/npm behavior and npm policy are retained.\nFinish tasks before changing the active installation; restart normally afterward.",
};
export function managedCommandHelp(parts) {
  if (parts[0] === "legacy") return "Compatibility entrypoints remain supported:\n  auth / reauth       GitHub sign-in; legacy account fields retained\n  models              Codex catalog; not silently replaced by selected models\n  source / m365 switch Codex-only switching\n  m365 on/off/remove   Existing access and profile-cleanup effects\n  prediction / image  Codex-only features\n  enable-image / disable-image / image-status\n  auto-review-model   Codex Auto-review\n  animation / cache / limits\nRetired commands retain their existing safe cleanup/refusal behavior.\nLegacy non-TTY and machine output paths remain available.";
  const supported = ["source", "app", "config", "requests", "status", "usage", "update"].includes(parts[0]) || parts.join(" ") === "doctor cache" || parts.join(" ") === "update check";
  if (!supported) return null;
  const entries = MANAGED_COMMANDS.filter(item => pathMatch(item.path, parts, true)
    && !(parts[0] === "source" && ["github", "m365"].includes(parts[1]) && ["edit", "remove"].includes(item.path.at(-1))));
  if (!entries.length) throw new Error(`Unknown help path: ${parts.join(" ")}`);
  return "Usage:\n" + entries.map(item => `  ccdx ${item.path.map((token, index) => parts[index] || token).join(" ")}${Object.entries(item.options).map(([name, type]) => ` [${name}${type === "flag" ? "" : type === "format" ? " table|plain|json" : " VALUE"}]`).join("")}\n    ${item.description}`).join("\n")
    + (parts[0] === "update" && parts.length === 1 ? "\n  ccdx update [npm|github] [--allow-remote]\n    Install with existing policy-preserving behavior" : "") + "\n\n" + extras[parts[0]];
}
export function rootCommandHelp() {
  return `Usage:\n  ccdx [start] [--show-request-id] [--no-browser] [--verbose]\n\nCommon:\n  status             Show service state; --details expands diagnostics\n  web                Open local management tools\n  requests           Show retained model requests and failures\n  usage              Show recorded token usage\n  doctor             Check local setup; deeper checks are explicit\n\nManage:\n  source             Accounts, APIs, catalogs and client authorization\n  app                Client model plans, sync and app-specific features\n  config             Service and terminal preferences\n\nUpdate:\n  update check       Check without installing\n  update github|npm  Install; restart the service normally afterward\n  version            Show installed package version\n\nHelp:\n  ccdx <command> --help\n  ccdx help app codex prediction\n  ccdx help legacy\n\nCompatibility:\n  auth, reauth, models, m365, prediction, image, enable-image,\n  disable-image, image-status, auto-review-model, animation, cache, limits\n\nStart keeps the existing configured-client setup and launch behavior.\nCLI output stays in English. Read-only commands do not start a service.`;
}
