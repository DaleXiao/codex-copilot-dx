#!/usr/bin/env node

import { status } from "../src/status.mjs";
import { localPackageVersion } from "../src/version.mjs";
import { cliCommandName, cliHelp, parseAdapterAddressOptions, parseAdapterProbeOptions, parseCliArgs } from "../src/cli-options.mjs";

const LOCAL_VERSION = localPackageVersion();
const CLI_NAME = cliCommandName();
const CLI_BANNER = `${CLI_NAME} v${LOCAL_VERSION} by Dale Xiao`;

let CLI;
try {
  CLI = parseCliArgs(process.argv.slice(2));
} catch (e) {
  console.error(e.message);
  console.error(`Help: ${CLI_NAME} --help`);
  process.exit(2);
}

if (CLI.command === "help") {
  console.log(cliHelp(CLI_NAME, CLI.helpTopic));
  process.exit(0);
}
if (CLI.command === "version") {
  console.log(CLI_BANNER);
  process.exit(0);
}
if (CLI.command === "antigravity-stop-hook") {
  const { signalAntigravityStop } = await import("../src/antigravity-stop-hook.mjs");
  await signalAntigravityStop(process.stdin).catch(() => {});
  await new Promise(resolve => process.stdout.write('{"decision":"stop"}\n', resolve));
  process.exit(0);
}
if (CLI.command === "manage") {
  try {
    const { runManagementCommand } = await import("../src/cli-management.mjs");
    const address = parseAdapterAddressOptions(process.env);
    const result = await runManagementCommand(CLI, { host: address.adapterHost, port: address.adapterPort, version: LOCAL_VERSION });
    if (result) {
      const error = await new Promise(resolve => {
        process.stdout.once("error", resolve);
        process.stdout.write(`${result}\n`, resolve);
      });
      if (error) {
        if (error.code !== "EPIPE") console.error(status("err", `Could not write command output: ${error.message}`));
        process.exit(1);
      }
    }
    process.exit(0);
  } catch (error) {
    if (CLI.flags?.format === "json") console.log(JSON.stringify({ error: { code: error.code || "ccdx_command_failed", message: error.message } }));
    else console.error(status("err", `${error.code ? `${error.code}: ` : ""}${error.message}`));
    process.exit(1);
  }
}
if (CLI.command === "update-managed") {
  try {
    if (!CLI.yes) throw new Error("Confirm with --yes to install and switch the idle service. You can also use Settings in the WebUI.");
    const { dashboardToolRequest } = await import("../src/cli-tools.mjs");
    const address = parseAdapterAddressOptions(process.env);
    console.log(JSON.stringify((await dashboardToolRequest({ host: address.adapterHost, port: address.adapterPort, path: "settings", body: { action: "update", confirmed: true }, detailedErrors: true })).last_operation));
    process.exit(0);
  } catch (error) { console.error(status("err", error.message));process.exit(1); }
}
if (CLI.command === "web") {
  try {
    const { runWebCommand } = await import("../src/cli-web.mjs");
    const address = parseAdapterAddressOptions(process.env);
    const server = await runWebCommand({ host: address.adapterHost, port: address.adapterPort });
    if (server) await server.ccdxWebClosed;
    process.exit(0);
  } catch (error) { console.error(status("err", error.message));process.exit(1); }
}
if (CLI.command === "m365") {
  try {
    const { runM365Command } = await import("../src/cli-m365.mjs");
    const address = parseAdapterAddressOptions(process.env);
    await runM365Command({ ...CLI, host: address.adapterHost, port: address.adapterPort });
    process.exit(0);
  } catch (error) { console.error(status("err", error.message));process.exit(1); }
}
if (CLI.command === "animation") {
  try {
    const { runAnimationCommand } = await import("../src/cli-animation.mjs");
    await runAnimationCommand({ commandName: CLI_NAME });
    process.exit(0);
  } catch (e) {
    console.error(status("err", e.message));
    process.exit(1);
  }
}
if (CLI.command === "image") {
  try {
    const address = parseAdapterAddressOptions(process.env);
    const { runImageCommand } = await import("../src/cli-image.mjs");
    const lines = [], structured = CLI.outputFormat === "json";
    const result = await runImageCommand({
      action: CLI.action,
      model: CLI.imageModel,
      commandName: CLI_NAME,
      adapterPort: address.adapterPort,
      adapterHost: address.adapterHost,
      ...(structured ? { output: { write: text => lines.push(String(text)) } } : {}),
    });
    if (structured) console.log(JSON.stringify({ client: "codex", feature: "image", ...result, details: lines.join("").trim() }));
    process.exit(0);
  } catch (e) {
    if (CLI.outputFormat === "json") console.log(JSON.stringify({ error: { code: e.code || "ccdx_image_status_failed", message: e.message } }));
    else console.error(status("err", e.message));
    process.exit(1);
  }
}
if (CLI.command === "prediction") {
  try {
    if (!["status", "fix"].includes(CLI.action)) {
      const { checkRunningAdapter } = await import("../src/running-adapter.mjs");
      const { dashboardToolRequest } = await import("../src/cli-tools.mjs");
      const address = parseAdapterAddressOptions(process.env);
      const running = await checkRunningAdapter({ host: address.adapterHost, port: address.adapterPort });
      const operation = { on: "setup", off: "remove", fix: "repair" }[CLI.action] || CLI.action;
      if (running.ok) {
        const data = await dashboardToolRequest({ host: address.adapterHost, port: address.adapterPort, path: "settings", body: { action: "prediction", operation }, detailedErrors: true, timeoutMs: 210000 });
        const result = data.last_operation?.result || data.features?.prediction;
        console.log(JSON.stringify(result));process.exit(result?.status === "failed" ? 1 : 0);
      }
      if (["enable", "disable", "setup", "remove", "pause", "resume", "open"].includes(operation)) {
        const { controlPrediction } = await import("../src/prediction-control.mjs");
        console.log(JSON.stringify(await controlPrediction(operation)));process.exit(0);
      }
    }
    const { readAdapterStatus } = await import("../src/cli-status.mjs");
    const { runPredictionCommand } = await import("../src/native-prediction.mjs");
    const lines = [], structured = CLI.outputFormat === "json";
    const result = await runPredictionCommand({ action: CLI.action, ...(structured ? { output: text => lines.push(String(text)) } : {}), repairRuntime: async () => {
      const { requestPredictionFix } = await import("../src/native-prediction-fix.mjs");
      const probe = parseAdapterProbeOptions(process.env);
      return requestPredictionFix({ host: probe.adapterHost, port: probe.adapterPort });
    }, runtimeSnapshot: () => {
      const probe = parseAdapterProbeOptions(process.env);
      return readAdapterStatus({ host: probe.adapterHost, port: probe.adapterPort, timeoutMs: probe.existingAdapterTimeoutMs }).then(({ data }) => data);
    } });
    if (structured) console.log(JSON.stringify({ client: "codex", feature: "prediction", configured: result.enabled === true, details: lines.join("\n") }));
    process.exit(CLI.action === "fix" ? result.exitCode : 0);
  } catch (error) {
    if (CLI.outputFormat === "json") console.log(JSON.stringify({ error: { code: error.code || "ccdx_prediction_status_failed", message: error.message } }));
    else console.error(status("err", error.message));
    process.exit(1);
  }
}
if (CLI.command === "cache") {
  try {
    const probe = parseAdapterProbeOptions(process.env);
    const { runCacheCommand } = await import("../src/cli-cache.mjs");
    await runCacheCommand({
      action: CLI.action,
      limitMib: CLI.limitMib,
      resetLimit: CLI.resetLimit,
      history: CLI.history,
      yes: CLI.yes,
      host: probe.adapterHost,
      port: probe.adapterPort,
      timeoutMs: probe.existingAdapterTimeoutMs,
    });
    process.exit(0);
  } catch (e) {
    console.error(status("err", e.message));
    process.exit(1);
  }
}
if (CLI.command === "limits") {
  try {
    const probe = parseAdapterProbeOptions(process.env);
    const { runLimitsCommand } = await import("../src/cli-limits.mjs");
    await runLimitsCommand({
      action: CLI.action,
      limitMib: CLI.limitMib,
      resetLimit: CLI.resetLimit,
      host: probe.adapterHost,
      port: probe.adapterPort,
      timeoutMs: probe.existingAdapterTimeoutMs,
    });
    process.exit(0);
  } catch (e) {
    console.error(status("err", e.message));
    process.exit(1);
  }
}
if (CLI.command === "auth") {
  try {
    const { runAuthCommand } = await import("../src/cli-auth.mjs");
    const result = await runAuthCommand({
      action: CLI.action,
      profile: CLI.profile,
      online: CLI.online,
      reauth: CLI.reauth,
      expectedLogin: CLI.expectedLogin,
      yes: CLI.yes,
      onChanged: async () => {
        const { dashboardToolRequest } = await import("../src/cli-tools.mjs");
        const address = parseAdapterAddressOptions(process.env);
        try { await dashboardToolRequest({ host: address.adapterHost, port: address.adapterPort, body: { action: "reload" } }); }
        catch { console.log("Restart the CCDX service to apply the sign-in change."); }
      },
      commandName: CLI_NAME,
      format: CLI.outputFormat || "auto",
      output: process.stdout,
    });
    if (result.output) console.log(result.output);
    process.exit(0);
  } catch (e) {
    console.error(status("err", e.message));
    process.exit(1);
  }
}
if (CLI.command === "auto-review-model") {
  try {
    const { runProviderAutoReviewCommand } = await import("../src/cli-m365.mjs");
    const address = parseAdapterAddressOptions(process.env);
    await runProviderAutoReviewCommand({ commandName: CLI_NAME, host: address.adapterHost, port: address.adapterPort });
    process.exit(0);
  } catch (e) {
    console.error(status("err", e.message));
    process.exit(1);
  }
}
if (CLI.command === "update") {
  try {
    const { runPackageUpdateCommand } = await import("../src/package-update.mjs");
    await runPackageUpdateCommand({ commandName: CLI_NAME, source: CLI.updateSource, allowRemote: CLI.allowRemote });
    process.exit(0);
  } catch (e) {
    console.error(status("err", e.message));
    process.exit(1);
  }
}
if (CLI.command === "doctor" && CLI.tool) {
  try {
    const { createLocalTools } = await import("../src/local-tools.mjs");
    const address = parseAdapterAddressOptions(process.env);
    const tools = createLocalTools({ host: address.adapterHost, port: address.adapterPort });
    if (CLI.tool === "network") console.log((await tools.network()).summary);
    else { await tools.check();console.log(JSON.stringify(tools.report(), null, 2)); }
    process.exit(0);
  } catch (error) { console.error(status("err", error.message));process.exit(1); }
}
if (CLI.command === "doctor" && CLI.configOnly) {
  const { runDoctor } = await import("../src/doctor.mjs");
  let probe;
  try {
    probe = parseAdapterAddressOptions(process.env);
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
  const checks = await runDoctor({
    commandName: CLI_NAME,
    configOnly: true,
    host: probe.adapterHost,
    port: probe.adapterPort,
  });
  process.exit(checks.some((check) => check.kind === "err") ? 1 : 0);
}

const { runForegroundService } = await import("../src/foreground-service.mjs");
await runForegroundService({ CLI, LOCAL_VERSION, CLI_NAME });
