import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import * as transport from "../src/http-transport.mjs";
import * as admission from "../src/request-admission.mjs";
import * as errors from "../src/http-errors.mjs";
import * as security from "../src/security.mjs";
import * as observability from "../src/observability.mjs";
import * as authCli from "../src/cli-auth.mjs";
import * as authData from "../src/auth-status.mjs";
import * as modelCli from "../src/cli-models.mjs";
import * as modelData from "../src/live-models.mjs";
import * as usageCli from "../src/usage.mjs";
import * as usageData from "../src/usage-store.mjs";
import { terminalCell as cliCell } from "../src/cli-table.mjs";
import { terminalCell } from "../src/terminal-text.mjs";

test("legacy exports share the exact extracted functions and usage state", () => {
  assert.equal(transport.httpError, errors.httpError);
  assert.equal(transport.createRequestAdmission, admission.createRequestAdmission);
  assert.equal(observability.isLoopbackAddress, security.isLoopbackAddress);
  assert.equal(observability.isLoopbackHostHeader, security.isLoopbackHostHeader);
  assert.equal(cliCell, terminalCell);
  for (const name of ["authStatus", "authStatusOnline"]) assert.equal(authCli[name], authData[name], name);
  for (const name of ["fetchLiveCopilotModels", "selectableCopilotModels"]) assert.equal(modelCli[name], modelData[name], name);
  for (const [name, value] of Object.entries(usageData)) assert.equal(usageCli[name], value, name);
});

test("shared data and foundation modules do not depend on presentation or composition roots", () => {
  const rules = {
    "auth-status.mjs": ["cli-auth.mjs", "cli-table.mjs", "adapter.mjs", "dashboard-api.mjs"],
    "live-models.mjs": ["cli-models.mjs", "cli-table.mjs", "adapter.mjs", "dashboard-api.mjs"],
    "usage-store.mjs": ["usage.mjs", "cli-table.mjs", "adapter.mjs", "dashboard-api.mjs"],
    "security.mjs": ["observability.mjs", "user-settings.mjs", "copilot.mjs"],
    "response-history.mjs": ["http-transport.mjs"],
    "request-admission.mjs": ["http-transport.mjs", "user-settings.mjs", "observability.mjs"],
    "dashboard-api.mjs": ["cli-auth.mjs", "cli-models.mjs", "usage.mjs"],
  };
  for (const [file, forbidden] of Object.entries(rules)) {
    const source = fs.readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
    for (const dependency of forbidden) {
      assert.ok(!source.includes(`"./${dependency}"`), `${file} must not depend on ${dependency}`);
    }
  }
});

test("static source imports remain acyclic after extraction", () => {
  const directory = new URL("../src/", import.meta.url);
  const graph = new Map();
  for (const file of fs.readdirSync(directory).filter((name) => name.endsWith(".mjs"))) {
    const source = fs.readFileSync(new URL(file, directory), "utf8");
    const imports = [...source.matchAll(/^\s*(?:import\s+(?:[^;]*?\s+from\s*)?|export\s+(?:\{[^}]*\}|\*)\s+from\s*)["']\.\/([^"']+)["']/gm)];
    graph.set(file, imports.map((match) => match[1]));
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
