import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CODEX_APP_BINARY_PATHS,
  buildCodexModelResponse,
  CODEX_GPT6_MODEL,
  createCodexModelCatalog,
  isEligibleCopilotGpt6,
} from "../src/codex-model-catalog.mjs";

const bundledGpt6 = {
  slug: CODEX_GPT6_MODEL,
  display_name: "GPT-6-Astra",
  visibility: "hide",
  additional_speed_tiers: ["fast"],
  service_tiers: [{ id: "priority", name: "Fast" }],
  default_service_tier: null,
  supported_reasoning_levels: [
    { effort: "low", description: "Light reasoning" },
    { effort: "ultra", description: "Delegated reasoning" },
  ],
  unknown_capability: { future: true },
};

const bundledCatalog = {
  models: [
    { slug: "gpt-5.6-sol", visibility: "list", metadata: { keep: true } },
    bundledGpt6,
  ],
};
const bundledGpt6WithoutDefaultTier = { ...bundledGpt6 };
delete bundledGpt6WithoutDefaultTier.default_service_tier;

function copilotGpt6(overrides = {}) {
  return {
    id: CODEX_GPT6_MODEL,
    vendor: "OpenAI",
    policy: { state: "enabled" },
    model_picker_enabled: true,
    supported_endpoints: ["/responses"],
    ...overrides,
  };
}

function copilotModel(id, efforts = ["low", "medium", "high", "xhigh", "max"]) {
  return copilotGpt6({
    id,
    capabilities: { supports: { reasoning_effort: efforts } },
  });
}

test("Codex catalog loader uses safe argv and caches by binary stat", async () => {
  let binaryMtime = 10;
  let versionExecutions = 0;
  let catalogExecutions = 0;
  const calls = [];
  const loader = createCodexModelCatalog({
    binaryPath: "/Applications/ChatGPT.app/Contents/Resources/codex",
    statFn: async () => ({
      dev: 1,
      ino: 2,
      size: 3,
      mtimeMs: binaryMtime,
      ctimeMs: 5,
      isFile: () => true,
    }),
    execFileFn: (file, args, options, callback) => {
      calls.push({ file, args, options });
      if (args[0] === "--version") {
        versionExecutions += 1;
        callback(null, "codex-cli 0.153.1-alpha.5\n", "");
      } else {
        catalogExecutions += 1;
        callback(null, JSON.stringify(bundledCatalog), "");
      }
    },
    timeoutMs: 1_234,
    maxBuffer: 98_765,
  });

  assert.deepEqual(await loader.load({ clientVersion: "0.153.1" }), bundledCatalog);
  assert.deepEqual(await loader.load({ clientVersion: "0.153.1" }), bundledCatalog);
  assert.equal(versionExecutions, 1);
  assert.equal(catalogExecutions, 1);
  assert.deepEqual(calls[0], {
    file: "/Applications/ChatGPT.app/Contents/Resources/codex",
    args: ["--version"],
    options: {
      encoding: "utf8",
      maxBuffer: 98_765,
      timeout: 1_234,
      windowsHide: true,
    },
  });
  assert.deepEqual(calls[1].args, ["debug", "models", "--bundled"]);

  assert.equal(await loader.load({ clientVersion: "arbitrary-query" }), null);
  assert.equal(versionExecutions, 1);
  assert.equal(catalogExecutions, 1);
  binaryMtime += 1;
  assert.deepEqual(await loader.load({ clientVersion: "0.153.1" }), bundledCatalog);
  assert.equal(versionExecutions, 2);
  assert.equal(catalogExecutions, 2);
});

test("an alpha Codex binary matches the whole semver sent by the App", async () => {
  let executions = 0;
  const loader = createCodexModelCatalog({
    binaryPath: "/trusted/codex",
    statFn: async () => ({ size: 1, mtimeMs: 1, isFile: () => true }),
    execFileFn: (_file, args, _options, done) => {
      executions += 1;
      if (args[0] === "--version") done(null, "codex-cli 0.154.0-alpha.5\n", "");
      else done(null, JSON.stringify(bundledCatalog), "");
    },
  });

  assert.deepEqual(await loader.load({ clientVersion: "0.154.0" }), bundledCatalog);
  assert.equal(executions, 2);
  assert.equal(await loader.load({ clientVersion: "0.154" }), null);
  assert.equal(await loader.load({ clientVersion: "0.154.0-alpha.01" }), null);
  assert.equal(executions, 2);
});

test("Codex catalog loader selects the first installed trusted app binary", async () => {
  const checked = [];
  let executedPath;
  const loader = createCodexModelCatalog({
    statFn: async (binaryPath) => {
      checked.push(binaryPath);
      if (binaryPath === CODEX_APP_BINARY_PATHS[0]) {
        const error = new Error("missing");
        error.code = "ENOENT";
        throw error;
      }
      return { size: 1, mtimeMs: 2, isFile: () => true };
    },
    execFileFn: (binaryPath, _args, _options, done) => {
      executedPath = binaryPath;
      done(null, JSON.stringify(bundledCatalog), "");
    },
  });

  assert.deepEqual(await loader.load(), bundledCatalog);
  assert.deepEqual(checked, CODEX_APP_BINARY_PATHS);
  assert.equal(executedPath, CODEX_APP_BINARY_PATHS[1]);
});

test("Codex catalog loader selects the installed binary matching clientVersion", async () => {
  const versionByPath = new Map([
    [CODEX_APP_BINARY_PATHS[0], "0.152.0"],
    [CODEX_APP_BINARY_PATHS[1], "0.153.1"],
  ]);
  const calls = [];
  const loader = createCodexModelCatalog({
    statFn: async (binaryPath) => {
      if (!versionByPath.has(binaryPath)) throw new Error("missing");
      return { size: binaryPath.length, mtimeMs: 1, isFile: () => true };
    },
    execFileFn: (binaryPath, args, _options, done) => {
      calls.push({ binaryPath, args });
      if (args[0] === "--version") {
        done(null, `codex-cli ${versionByPath.get(binaryPath)}\n`, "");
      } else {
        done(null, JSON.stringify(bundledCatalog), "");
      }
    },
  });

  assert.deepEqual(await loader.load({ clientVersion: "0.153.1" }), bundledCatalog);
  assert.deepEqual(calls, [
    { binaryPath: CODEX_APP_BINARY_PATHS[0], args: ["--version"] },
    { binaryPath: CODEX_APP_BINARY_PATHS[1], args: ["--version"] },
    { binaryPath: CODEX_APP_BINARY_PATHS[1], args: ["debug", "models", "--bundled"] },
  ]);
  assert.equal(await loader.load({ clientVersion: "0.154.0" }), null);
  assert.equal(calls.length, 3);
});

test("different concurrent clientVersion queries share one bundled catalog read", async () => {
  let versionCallback;
  let catalogCallback;
  let versionExecutions = 0;
  let catalogExecutions = 0;
  const loader = createCodexModelCatalog({
    binaryPath: "/trusted/codex",
    statFn: async () => ({ size: 1, mtimeMs: 1, isFile: () => true }),
    execFileFn: (_file, args, _options, done) => {
      if (args[0] === "--version") {
        versionExecutions += 1;
        versionCallback = done;
      } else {
        catalogExecutions += 1;
        catalogCallback = done;
      }
    },
  });
  const withoutVersion = loader.load();
  const withVersion = loader.load({ clientVersion: "0.153.1" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(versionExecutions, 1);
  assert.equal(catalogExecutions, 1);
  versionCallback(null, "codex-cli 0.153.1\n", "");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(catalogExecutions, 1);
  catalogCallback(null, JSON.stringify(bundledCatalog), "");
  assert.deepEqual(await Promise.all([withoutVersion, withVersion]), [bundledCatalog, bundledCatalog]);
});

test("catalog failures use a finite backoff and stat changes retry immediately", async () => {
  let time = 1_000;
  let binaryMtime = 1;
  let executions = 0;
  const loader = createCodexModelCatalog({
    binaryPath: "/trusted/codex",
    statFn: async () => ({ size: 1, mtimeMs: binaryMtime, isFile: () => true }),
    execFileFn: (_file, _args, _options, done) => {
      executions += 1;
      done(null, '{"models":[{}]}', "");
    },
    now: () => time,
  });

  assert.equal(await loader.load(), null);
  assert.equal(await loader.load(), null);
  assert.equal(executions, 1);
  binaryMtime += 1;
  assert.equal(await loader.load(), null);
  assert.equal(executions, 2);
  time += 5_001;
  assert.equal(await loader.load(), null);
  assert.equal(executions, 3);
});

test("version probe failures use a finite backoff and stat changes retry immediately", async () => {
  let time = 1_000;
  let binaryMtime = 1;
  let executions = 0;
  const loader = createCodexModelCatalog({
    binaryPath: "/trusted/codex",
    statFn: async () => ({ size: 1, mtimeMs: binaryMtime, isFile: () => true }),
    execFileFn: (_file, args, _options, done) => {
      executions += 1;
      assert.deepEqual(args, ["--version"]);
      done(new Error("probe failed"), "", "");
    },
    now: () => time,
  });

  assert.equal(await loader.load({ clientVersion: "0.153.1" }), null);
  assert.equal(await loader.load({ clientVersion: "0.153.1" }), null);
  assert.equal(executions, 1);
  binaryMtime += 1;
  assert.equal(await loader.load({ clientVersion: "0.153.1" }), null);
  assert.equal(executions, 2);
  time += 5_001;
  assert.equal(await loader.load({ clientVersion: "0.153.1" }), null);
  assert.equal(executions, 3);
});

test("Codex catalog loader rejects relative binary paths", async () => {
  const relative = createCodexModelCatalog({ binaryPath: "codex" });
  assert.equal(await relative.load(), null);
});

test("dual model response exposes eligible GPT-6 without changing other models or Copilot data", () => {
  const copilotModels = {
    object: "list",
    data: [copilotGpt6(), { id: "gpt-5.6-sol", supported_endpoints: ["/responses"] }],
    upstream_extension: { keep: true },
  };
  const originalCatalog = structuredClone(bundledCatalog);
  const originalCopilot = structuredClone(copilotModels);
  const response = buildCodexModelResponse({ copilotModels, codexCatalog: bundledCatalog });

  assert.deepEqual(copilotModels, originalCopilot);
  assert.deepEqual(bundledCatalog, originalCatalog);
  assert.deepEqual(response.data, copilotModels.data);
  assert.equal(response.object, "list");
  assert.deepEqual(response.upstream_extension, { keep: true });
  assert.deepEqual(response.models[0], bundledCatalog.models[0]);
  assert.deepEqual(response.models[1], {
    ...bundledGpt6WithoutDefaultTier,
    visibility: "list",
    additional_speed_tiers: [],
    service_tiers: [],
  });
  assert.equal(Object.hasOwn(response.models[1], "default_service_tier"), false);
  assert.deepEqual(response.models[1].supported_reasoning_levels, bundledGpt6.supported_reasoning_levels);
  assert.equal(response.models[1].supported_reasoning_levels.at(-1).effort, "ultra");
  assert.deepEqual(response.models[1].unknown_capability, { future: true });
});

test("dual model response advertises GPT-6 Fast only with an exact eligible fast model", () => {
  const response = buildCodexModelResponse({
    copilotModels: { data: [copilotGpt6({ additional_speed_tiers: ["fast"] })] },
    codexCatalog: bundledCatalog,
  });
  assert.equal(response.object, "list");
  assert.deepEqual(response.models[1], {
    ...bundledGpt6WithoutDefaultTier,
    visibility: "list",
    additional_speed_tiers: [],
    service_tiers: [],
  });
  assert.equal(Object.hasOwn(response.models[1], "default_service_tier"), false);

  const fastVariant = buildCodexModelResponse({
    copilotModels: { data: [
      copilotGpt6(),
      copilotGpt6({ id: `${CODEX_GPT6_MODEL}-fast` }),
    ] },
    codexCatalog: bundledCatalog,
  });
  assert.deepEqual(fastVariant.models[1].additional_speed_tiers, ["fast"]);
  assert.deepEqual(fastVariant.models[1].service_tiers, bundledGpt6.service_tiers);
  assert.equal(fastVariant.models[1].default_service_tier, null);
});

test("missing client entries use the installed GPT-6 schema only for exact eligible Copilot models", () => {
  const response = buildCodexModelResponse({
    copilotModels: { data: [copilotGpt6(), copilotModel("gpt-6-sol"), copilotModel("gpt-6-luna")] },
    codexCatalog: bundledCatalog,
  });
  assert.deepEqual(response.models.map(({ slug }) => slug), [
    "gpt-5.6-sol", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna",
  ]);
  const sol = response.models.find(({ slug }) => slug === "gpt-6-sol");
  const luna = response.models.find(({ slug }) => slug === "gpt-6-luna");
  assert.equal(sol.display_name, "GPT-6-Sol");
  assert.equal(sol.default_reasoning_level, "medium");
  assert.deepEqual(sol.supported_reasoning_levels.map(({ effort }) => effort), ["low"]);
  assert.equal(sol.unknown_capability.future, true);
  assert.equal(sol.model_messages, undefined, "fixture Astra has no messages and fallback must not invent them");
  assert.deepEqual(sol.additional_speed_tiers, []);
  assert.equal(luna.node_repl_auto_review_required, false);
  assert.deepEqual(luna.additional_speed_tiers, []);

  const ineligible = buildCodexModelResponse({
    copilotModels: { data: [
      copilotGpt6(),
      copilotModel("gpt-6-sol", []),
      copilotGpt6({ id: "gpt-6-luna", vendor: "Microsoft" }),
    ] },
    codexCatalog: bundledCatalog,
  });
  assert.equal(ineligible.models.some(({ slug }) => slug === "gpt-6-sol"), true);
  assert.equal(ineligible.models.some(({ slug }) => slug === "gpt-6-luna"), false);
});

test("client-provided GPT-6 Sol and Luna entries win over compatibility metadata", () => {
  const clientSol = { slug: "gpt-6-sol", visibility: "hide", priority: 77,
    supported_reasoning_levels: [{ effort: "high" }], future_client_field: { keep: true } };
  const clientLuna = { slug: "gpt-6-luna", visibility: "hide", priority: 78,
    supported_reasoning_levels: [{ effort: "max" }], future_client_field: { keep: true } };
  const response = buildCodexModelResponse({
    copilotModels: { data: [copilotGpt6(), copilotModel("gpt-6-sol"), copilotModel("gpt-6-luna")] },
    codexCatalog: { models: [...bundledCatalog.models, clientSol, clientLuna] },
  });
  for (const original of [clientSol, clientLuna]) {
    const model = response.models.find(({ slug }) => slug === original.slug);
    assert.equal(model.visibility, "list");
    assert.equal(model.priority, original.priority);
    assert.deepEqual(model.supported_reasoning_levels, original.supported_reasoning_levels);
    assert.deepEqual(model.future_client_field, { keep: true });
    assert.deepEqual(model.additional_speed_tiers, []);
    assert.deepEqual(model.service_tiers, []);
  }
});

test("GPT-6 remains hidden unless the Copilot entry is unambiguously eligible", () => {
  const ineligible = [
    copilotGpt6({ vendor: "Microsoft" }),
    copilotGpt6({ policy: { state: "disabled" } }),
    copilotGpt6({ model_picker_enabled: false }),
    copilotGpt6({ supported_endpoints: ["/chat/completions"] }),
  ];
  for (const model of ineligible) {
    const payload = { object: "list", data: [model] };
    assert.equal(isEligibleCopilotGpt6(payload), false);
    const models = buildCodexModelResponse({ copilotModels: payload, codexCatalog: {
      models: [bundledCatalog.models[0], { ...bundledGpt6, visibility: "list" }],
    } }).models;
    assert.deepEqual(models[0], bundledCatalog.models[0]);
    assert.equal(models[1].visibility, "hide");
  }

  const duplicate = { data: [copilotGpt6(), copilotGpt6()] };
  assert.equal(isEligibleCopilotGpt6(duplicate), false);
  assert.equal(
    buildCodexModelResponse({ copilotModels: duplicate, codexCatalog: bundledCatalog }).models[1].visibility,
    "hide",
  );
});

test("unrelated Copilot entries without ids do not suppress an eligible GPT-6 catalog", () => {
  const response = buildCodexModelResponse({
    copilotModels: { data: [null, {}, copilotGpt6()] },
    codexCatalog: bundledCatalog,
  });
  assert.equal(response.models[1].visibility, "list");
});

test("dual model response rejects malformed schemas", () => {
  assert.equal(buildCodexModelResponse({ copilotModels: { data: [] }, codexCatalog: bundledCatalog }), null);
  assert.equal(buildCodexModelResponse({
    copilotModels: { data: [copilotGpt6()] },
    codexCatalog: { models: [{ slug: "duplicate" }, { slug: "duplicate" }] },
  }), null);
  assert.equal(buildCodexModelResponse({
    copilotModels: { data: [copilotGpt6()] },
    codexCatalog: { models: [{}] },
  }), null);
});
