import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { inspectApplicationProcesses, processFamily, applicationConnections, controlApplicationProcess } from "./application-process.mjs";
import { inspectApplicationConfiguration } from "./application-configuration.mjs";
import { createApplicationEvidence } from "./application-evidence.mjs";
import { hasManagedAntigravityGateway, launchAntigravityGatewayApp, planGeminiAppLaunch, inspectGeminiApp } from "./gemini-app.mjs";
import { readUserSettings } from "./user-settings.mjs";
import { launchWindowsAntigravity } from "./windows-antigravity-app.mjs";

const execute = promisify(execFile), ids = ["codex", "claude_app", "antigravity"];
export function createApplicationControl({ providerRuntime, clientIntegration, imageHostState, env = process.env, home,
  platform = process.platform, port = 2026, host = "127.0.0.1", now = Date.now, exec = execute, wait = sleep,
  inspect = inspectApplicationProcesses, connections = applicationConnections, control = controlApplicationProcess,
  inspectGemini = inspectGeminiApp, launchWindowsGemini = launchWindowsAntigravity, managedGeminiGateway = hasManagedAntigravityGateway,
  launchGatewayApp = launchAntigravityGatewayApp,
  configuration = inspectApplicationConfiguration, openCodexApp, evidence = providerRuntime?.applicationEvidence || createApplicationEvidence({ now }) } = {}) {
  const options = { env, home, platform, exec };
  const states = Object.fromEntries(ids.map(id => [id, { status: "unknown", connection: "pending" }]));
  const configurations = new Map(), starting = new Map();
  let antigravityLaunch;
  let cached, at = 0, pending, pendingAt = 0, serial = Promise.resolve(), inspection = 0, operations = 0;
  const snapshot = () => structuredClone(states);
  const inventory = async fresh => {
    if (!fresh && cached && now() >= at && now() - at < 3000) return cached;
    if (!pending) { pendingAt = now();pending = inspect(options).then(value => { cached = value;at = now();return value; }).finally(() => { pending = null; }); }
    const remaining = Math.min(5000, 5000 - (now() - pendingAt));
    if (remaining <= 0) throw new Error("Application inspection is still pending");
    let timer;try { return await Promise.race([pending, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Application inspection timed out")), remaining); })]); }
    finally { clearTimeout(timer); }
  };
  async function check(id, fresh = false) {
    if (!ids.includes(id)) throw new Error("Unknown application");
    let data;try { data = await inventory(fresh); } catch { states[id] = { status: "unknown", connection: "pending", inspection: ++inspection };return states[id]; }
    const app = data.apps[id] || { status: "unknown" }, config = await configuration(id, { ...options, port, host });
    const old = configurations.get(id);
    if (!old || old.revision !== config.revision) configurations.set(id, { ...config,
      evidenceAt: old ? now() : 0,
      changed: old && (old.reloadRevision || old.revision) !== (config.reloadRevision || config.revision) ? now() : old?.changed || 0 });
    const launchDeadline = app.status === "stopped" ? starting.get(id) : undefined;
    const launchPending = launchDeadline !== undefined && launchDeadline > now();
    const launch = antigravityLaunch && id === "antigravity" && antigravityLaunch.app === app.app
      && (launchPending || app.status === "running" && (!antigravityLaunch.pid || antigravityLaunch.pid === app.pid)) ? antigravityLaunch : null;
    let connection = { state: "pending" };
    if (app.status === "running" && launch?.gateway) {
      const observed = launch.gateway.observation?.();
      if(observed) connection = { state: "observed", ...observed };
    } else if (app.status === "running") {
      const family = processFamily(data.processes, app.pid).map(row => row.pid);
      let sockets = [];try { sockets = await connections(family, port, options); } catch { /* Missing process access is unconfirmed, not disconnected. */ }
      connection = evidence.inspect(id, app, sockets, config.revision, configurations.get(id)?.evidenceAt || 0);
    } else evidence.clear(id);
    const changed = configurations.get(id)?.changed || 0;
    const needsReload = app.status === "running" && (config.state === "configured" || id === "antigravity" && config.state === "native") && changed > Date.parse(app.started) && connection.state !== "observed";
    const status = launchPending ? "starting" : app.status;
    states[id] = { status, inspection: ++inspection, connection: connection.state, scope: connection.scope || null, observed_at: connection.at || null,
      configuration: config.state, needs_reload: needsReload, ...(app.pid ? { pid: app.pid, started: app.started } : {}), ...(app.version ? { version: app.version } : {}) };
    if (launch) states[id].launch_mode = launch.mode;
    return states[id];
  }
  async function action(input, webLaunch) {
    const { id, operation, confirmed, fresh = false, expected_pid: expectedPid, expected_started: expectedStarted } = input;
    if (!ids.includes(id) || !["check", "open", "focus", "restart"].includes(operation)) throw new Error("Unknown application action");
    if (operation === "check") return { status: "checked", app: await check(id, fresh) };
    if (operation === "restart" && confirmed !== true) throw new Error("Confirm that reopening may interrupt this application's tasks");
    let state = await check(id, true), app = cached?.apps[id];
    const originalApp = app;
    if (operation === "restart" && expectedPid !== undefined && (expectedPid !== app?.pid || expectedStarted !== app?.started)) return { status: "app_changed", app: state };
    if (["unknown", "multiple", "unsupported", "not_installed"].includes(state.status)) return { status: state.status, app: state };
    if (state.status === "starting") return { status: "opening", app: state };
    if (platform === "win32" && id === "antigravity" && state.status === "running") {
      const verified = await inspectGemini({ ...options, app: app.app });
      if (verified.status === "unverified_build") return { status: verified.status, app: state };
      if (verified.status !== "running" || !verified.pids.includes(app.pid)) return { status: "app_changed", app: state };
    }
    if (state.status === "running" && operation !== "restart") {
      if (state.needs_reload && operation !== "focus") return { status: "needs_app_relaunch", app: state };
      const result = await control(app, "focus", options);
      return { status: result === "sent" ? "focused" : "focus_unavailable", app: state };
    }
    if (operation === "focus") return { status: "app_not_running", app: state };
    const embedded = id === "antigravity" && platform === "darwin" && app?.app?.endsWith("/Gemini.app");
    const currentMode = operation === "restart" && (state.launch_mode || (embedded ? "google" : null));
    const mode = webLaunch && (webLaunch.mode || currentMode || webLaunch.preference || (embedded ? "google" : null));
    if (webLaunch && !mode) return { status: "launch_choice_required", app: state };
    const gateway = mode === "gateway" ? webLaunch : null;
    if (gateway) {
      if (embedded && state.status === "running") return { status: "needs_app_relaunch", app: state };
      if (gatewayConflict() || await managedGeminiGateway(options)) return { status: "route_conflict", app: state };
      if (!gateway.available()) return { status: "gateway_models_required", app: state };
    }
    if (state.status === "running") {
      if (id === "antigravity" && !gateway && antigravityBridgeEnabled() && await managedGeminiGateway(options)) return { status: "route_conflict", app: state };
      const pid = app.pid, started = app.started;
      const result = await control(app, "quit", options);
      if (!["sent", "absent"].includes(result)) return { status: "quit_refused", app: state };
      const deadline = now() + 10000;
      do {
        await wait(250);await check(id, true);app = cached?.apps[id];
        if (app?.status === "stopped") break;
        if (app?.pid !== pid || app?.started !== started) return { status: "app_changed", app: states[id] };
      } while (now() < deadline);
      if (app?.status !== "stopped") return { status: "quit_timeout", app: states[id] };
    }
    if (id !== "antigravity") await providerRuntime?.prepareApplication?.(id);
    let opened = true, handled = false;
    if (id === "codex" && openCodexApp) {
      const result = await openCodexApp();
      if (result) {
        if (result.status === "already_connected") return { status: "focused", app: await check(id, true) };
        if (!["opened_new_chat_required", "opened_with_pending", "opened"].includes(result.status)) return { ...result, app: states[id] };
        handled = true;
      }
    }
    let launched;
    if (!handled && gateway) {
      const verified = await inspectGemini({ ...options, standalone: true });
      if (verified.status !== "stopped") return { status: verified.status === "running" ? "app_changed" : verified.status, app: states[id] };
      if (verified.wsl) return { status: "route_conflict", app: states[id] };
      launched = await startVerifiedGateway(verified, gateway.prepare);
    } else if (!handled && id === "antigravity") {
      const target = webLaunch ? originalApp : app;
      const plan = await antigravityPlan(target);
      if (plan.status !== "prepared") return { status: plan.status, app: states[id] };
      if (platform === "win32") await launchWindowsGemini(plan);
      else await exec(plan.command, plan.args, { encoding: "utf8", timeout: 5000, maxBuffer: 4096 });
      if (webLaunch) launched = { app: target.app, mode: "google" };
    } else if (!handled && platform === "darwin") {
      await exec("/usr/bin/open", ["-a", app.app], { encoding: "utf8", timeout: 5000, maxBuffer: 4096 });
    } else if (!handled && platform === "win32") {
      if (app.target.startsWith("shell:AppsFolder\\")) await exec("explorer.exe", [app.target], { encoding: "utf8", timeout: 5000, maxBuffer: 4096, windowsHide: true });
      else await exec(app.target, [], { encoding: "utf8", timeout: 5000, maxBuffer: 4096, windowsHide: true });
    } else if (!handled) opened = false;
    if (!opened) return { status: "open_failed", app: states[id] };
    if (id === "antigravity") antigravityLaunch = launched;
    evidence.clear(id);starting.set(id, now() + 10000);states[id] = { ...states[id], inspection: ++inspection, status: "starting", connection: "pending", needs_reload: false,
      ...(launched ? { launch_mode: launched.mode } : {}) };
    return { status: "opened", app: states[id], ...(launched ? { mode: launched.mode } : {}) };
  }
  async function startVerifiedGateway(verified,prepare) {
    const gateway=await prepare(verified);
    try { return {app:verified.app,mode:"gateway",gateway,pid:await launchGatewayApp(verified,gateway,options)}; }
    catch(error) { gateway.close();throw error; }
  }
  function antigravityBridgeEnabled() {
    const config = readUserSettings({ env, home, strict: true });
    return config.gemini_antigravity_enabled === true || typeof config.gemini_antigravity_native_source === "string";
  }
  async function antigravityPlan(app) {
    const enabled = antigravityBridgeEnabled();
    if (platform === "darwin" && !enabled) return { status: "prepared", command: "/usr/bin/open", args: ["-a", app.app] };
    if (enabled && await managedGeminiGateway(options)) return { status: "route_conflict" };
    const verified = await inspectGemini({ ...options, app: app.app });
    if (verified.status !== "stopped") return { status: verified.status === "running" ? "app_changed" : verified.status };
    return planGeminiAppLaunch(verified, { cloudCodeUrl: enabled ? `http://${host}:${port}/antigravity` : undefined, env, home, platform });
  }
  function serialize(operation) {
    operations++;
    const result = serial.then(operation).finally(() => { operations--; });
    serial = result.catch(() => {});
    return result;
  }
  const gatewayConflict = () => Object.entries(env).some(([name,value])=>value&&/^(AGY_LLM_GATEWAY_|CLOUD_CODE_URL$|ANTIGRAVITY_WSL_DISTRO$)/i.test(name));
  return { snapshot, evidence, check, busy: () => operations > 0,
    async previewAntigravity() {
      const state = await check("antigravity", true);
      if (state.status !== "stopped") return { status: state.status === "running" ? "needs_app_relaunch" : state.status };
      return antigravityPlan(cached.apps.antigravity);
    },
    openStandaloneAntigravity(prepareGateway) {
      return serialize(async () => {
        if(prepareGateway){
          if(gatewayConflict()||await managedGeminiGateway(options))return {status:"route_conflict"};
        }
        const verified=await inspectGemini({ ...options, standalone:true });
        if(verified.status!=="stopped")return {status:verified.status==="running"?"needs_app_relaunch":verified.status};
        if(!prepareGateway){
          const enabled=antigravityBridgeEnabled();
          const plan=planGeminiAppLaunch(verified,{cloudCodeUrl:enabled?"http://"+host+":"+port+"/antigravity":undefined,
            env,home,platform,managedGateway:enabled&&await managedGeminiGateway(options)});
          if(plan.status!=="prepared")return {status:plan.status};
          if(platform==="win32")await launchWindowsGemini(plan);
          else await exec(plan.command,plan.args,{encoding:"utf8",timeout:5000,maxBuffer:4096});
          antigravityLaunch={app:verified.app,mode:"google"};
          return {status:"opened",mode:"google"};
        }
        if(verified.wsl)return {status:"route_conflict"};
        antigravityLaunch=await startVerifiedGateway(verified,prepareGateway);
        return {status:"opened",mode:"gateway"};
      });
    },
    openAntigravityFromWeb(input, launch) {
      return serialize(() => action({ ...input, id: "antigravity" }, launch));
    },
    action(input) { return serialize(() => action(input)); } };
}
