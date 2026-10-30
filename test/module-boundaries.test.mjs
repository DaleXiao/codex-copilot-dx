import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as transport from "../src/http-transport.mjs";
import * as upstreamBody from "../src/upstream-body.mjs";
import * as admission from "../src/request-admission.mjs";
import * as errors from "../src/http-errors.mjs";
import * as security from "../src/security.mjs";
import * as observability from "../src/observability.mjs";
import * as authCli from "../src/cli-auth.mjs";
import * as authData from "../src/auth-status.mjs";
import * as usageCli from "../src/usage.mjs";
import * as usageData from "../src/usage-store.mjs";
import { terminalCell as cliCell } from "../src/cli-table.mjs";
import { terminalCell } from "../src/terminal-text.mjs";
import * as auth from "../src/auth.mjs";
import * as credentials from "../src/auth-credentials.mjs";
import * as device from "../src/auth-device-flow.mjs";

test("shared modules retain transport, authentication and usage boundaries", () => {
  assert.equal(transport.httpError, errors.httpError);
  assert.equal(transport.createRequestAdmission, admission.createRequestAdmission);
  for (const [name, value] of Object.entries(upstreamBody)) assert.equal(transport[name], value, name);
  assert.equal(observability.isLoopbackAddress, security.isLoopbackAddress);
  assert.equal(observability.isLoopbackHostHeader, security.isLoopbackHostHeader);
  assert.equal(cliCell, terminalCell);
  for (const name of ["authStatus", "authStatusOnline"]) assert.equal(authCli[name], authData[name], name);
  for (const [name, value] of Object.entries(usageData)) assert.equal(usageCli[name], value, name);
  for (const [name, value] of Object.entries(credentials)) {
    if (name !== "readSavedGithubToken") assert.equal(auth[name], value, name);
  }
  for (const name of ["interpretPoll", "requestGithubDeviceCode", "pollGithubDeviceFlow"]) assert.equal(auth[name], device[name], name);
});

test("shared data and foundation modules do not depend on presentation or composition roots", () => {
  const rules = {
    "auth-status.mjs": ["cli-auth.mjs", "cli-table.mjs", "adapter.mjs", "dashboard-api.mjs"],
    "auth-credentials.mjs": ["auth.mjs", "auth-device-flow.mjs", "adapter.mjs", "dashboard-api.mjs"],
    "auth-device-flow.mjs": ["auth.mjs", "auth-credentials.mjs", "adapter.mjs", "dashboard-api.mjs"],
    "live-models.mjs": ["cli-models.mjs", "cli-table.mjs", "adapter.mjs", "dashboard-api.mjs"],
    "upstream-body.mjs": ["http-transport.mjs", "request-admission.mjs", "copilot.mjs", "dashboard-api.mjs", "user-settings.mjs"],
    "usage-store.mjs": ["usage.mjs", "cli-table.mjs", "adapter.mjs", "dashboard-api.mjs"],
    "security.mjs": ["observability.mjs", "user-settings.mjs", "copilot.mjs"],
    "response-history.mjs": ["http-transport.mjs"],
    "request-admission.mjs": ["http-transport.mjs", "user-settings.mjs", "observability.mjs"],
    "dashboard-api.mjs": ["cli-auth.mjs", "cli-models.mjs", "usage.mjs"],
    "client-integration.mjs": ["responses-handler.mjs", "responses-proxy.mjs", "dashboard/ui.js"],
    "network-route.mjs": ["copilot.mjs", "native-prediction-profile.mjs", "dashboard-api.mjs"],
    "network-bypass.mjs": ["node:fs", "node:dns", "node:child_process", "native-prediction.mjs", "adapter.mjs"],
    "native-prediction-environment.mjs": ["adapter.mjs", "copilot.mjs", "image-provider.mjs", "dashboard-api.mjs", "config.mjs", "native-prediction.mjs"],
    "native-prediction-state.mjs": ["adapter.mjs", "dashboard-api.mjs", "cli-status.mjs"],
    "native-prediction-route.mjs": ["adapter.mjs", "dashboard-api.mjs", "copilot.mjs", "startup-ui.mjs"],
    "native-prediction-recovery.mjs": ["adapter.mjs", "dashboard-api.mjs", "copilot.mjs", "startup-ui.mjs"],
    "native-prediction-app.mjs": ["adapter.mjs", "native-prediction.mjs", "native-prediction-profile.mjs", "dashboard-api.mjs"],
    "native-prediction-fix.mjs": ["adapter.mjs", "copilot.mjs", "native-prediction-profile.mjs", "native-prediction.mjs"],
    "prediction-pac.mjs": ["node:fs", "node:dns", "node:child_process", "native-prediction.mjs", "adapter.mjs", "network-route.mjs"],
    "startup-ui.mjs": ["adapter.mjs", "native-prediction.mjs", "copilot.mjs", "dashboard-api.mjs"],
    "windows-prediction-network.mjs": ["responses-handler.mjs", "copilot.mjs", "dashboard-api.mjs", "config.mjs"],
    "windows-http-network.mjs": ["adapter.mjs", "provider-runtime.mjs", "native-prediction.mjs", "copilot.mjs"],
    "provider-descriptors.mjs": ["provider-runtime.mjs", "providers/m365.mjs", "dashboard-api.mjs", "node:fs", "node:child_process"],
    "api-catalog-refresh.mjs": ["connection-runtime.mjs", "codex-api-config.mjs", "claude-client-config.mjs", "dashboard-api.mjs", "node:fs"],
    "providers/m365-catalog-diagnostic.mjs": ["../provider-runtime.mjs", "m365.mjs", "../dashboard-api.mjs", "node:fs", "node:child_process"],
    "provider-registry.mjs": ["provider-runtime.mjs", "claude-client-config.mjs", "copilot.mjs", "dashboard-api.mjs"],
    "claude-client-lifecycle.mjs": ["providers/m365.mjs", "providers/m365-auth.mjs", "provider-runtime.mjs", "dashboard-api.mjs"],
    "providers/m365.mjs": ["github.mjs", "../native-prediction.mjs", "../config.mjs", "../image-provider-config.mjs", "../claude-client-config.mjs"],
    "providers/m365-auth.mjs": ["../copilot.mjs", "../auth.mjs", "../config.mjs"],
    "providers/api.mjs": ["../client-model-plan.mjs", "../clients/codex-models.mjs", "../codex-api-config.mjs", "../claude-client-config.mjs", "../native-prediction.mjs"],
    "providers/api-model-metadata.mjs": ["../clients/codex-models.mjs", "../clients/claude-models.mjs", "../connection-runtime.mjs", "node:fs", "node:child_process"],
    "clients/codex-models.mjs": ["../providers/api.mjs", "../api-secrets.mjs", "../clients/claude-models.mjs", "../connection-runtime.mjs"],
    "clients/claude-models.mjs": ["../providers/api.mjs", "../api-secrets.mjs", "../clients/codex-models.mjs", "../connection-runtime.mjs"],
    "codex-paths.mjs": ["config.mjs", "cli-image.mjs", "native-prediction.mjs"],
    "package-update.mjs": ["adapter.mjs", "responses-handler.mjs", "native-prediction.mjs", "image-provider.mjs", "dashboard-api.mjs", "config.mjs"],
    "auth-sources.mjs": ["auth.mjs", "adapter.mjs", "dashboard-api.mjs", "cli-auth.mjs"],
    "windows-command.mjs": ["adapter.mjs", "auth.mjs", "native-prediction.mjs", "doctor.mjs"],
    "doctor-compat.mjs": ["doctor.mjs", "doctor-repair.mjs", "adapter.mjs"],
    "doctor-repair.mjs": ["doctor.mjs", "adapter.mjs", "dashboard-api.mjs"],
    "management-routes.mjs": ["adapter.mjs", "copilot.mjs", "responses-handler.mjs", "native-prediction.mjs", "image-mcp.mjs", "dashboard-api.mjs"],
    "optional-routes.mjs": ["adapter.mjs", "copilot.mjs", "responses-handler.mjs", "native-prediction.mjs", "management-routes.mjs"],
  };
  for (const [file, forbidden] of Object.entries(rules)) {
    const source = fs.readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
    for (const dependency of forbidden) {
      assert.ok(!source.includes(`"${dependency.startsWith("node:") || dependency.startsWith("../") ? dependency : `./${dependency}`}"`), `${file} must not depend on ${dependency}`);
    }
  }
});

test("optional handlers remain lazy and HTTP dispatch no longer owns their implementations", () => {
  const adapter = fs.readFileSync(new URL("../src/adapter.mjs", import.meta.url), "utf8");
  const optional = fs.readFileSync(new URL("../src/optional-routes.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(adapter, /import\("\.\/(?:dashboard|dashboard-api|image-mcp)\.mjs"\)/);
  assert.doesNotMatch(optional, /^import .*(?:image-mcp|dashboard-api|dashboard\.mjs)/m);
  for (const name of ["dashboard", "dashboard-api", "image-mcp"]) assert.ok(optional.includes(`import("./${name}.mjs")`));
});

test("static source imports remain acyclic after extraction", () => {
  const directory = new URL("../src/", import.meta.url);
  const graph = new Map();
  for (const file of fs.readdirSync(directory, { recursive: true }).filter((name) => name.endsWith(".mjs"))) {
    const source = fs.readFileSync(new URL(file, directory), "utf8");
    const imports = [...source.matchAll(/^\s*(?:import\s+(?:[^;]*?\s+from\s*)?|export\s+(?:\{[^}]*\}|\*)\s+from\s*)["'](\.{1,2}\/[^"']+)["']/gm)];
    graph.set(file, imports.map((match) => path.normalize(path.join(path.dirname(file), match[1]))));
  }
  const visited = new Set();
  function visit(file, trail) {
    assert.ok(!trail.includes(file), `Static import cycle: ${[...trail, file].join(" -> ")}`);
    if (visited.has(file) || !graph.has(file)) return;
    for (const dependency of graph.get(file)) visit(dependency, [...trail, file]);
    visited.add(file);
  }
  for (const file of graph.keys()) visit(file, []);
});
