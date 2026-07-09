const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const root = path.resolve(__dirname, "..");

function loadModelHelpers() {
  const source = fs.readFileSync(
    path.join(root, "src/renderer/settings/model-helpers.js"),
    "utf8",
  );
  const context = { window: {} };
  vm.runInNewContext(source, context, {
    filename: "src/renderer/settings/model-helpers.js",
  });
  return context.window.miaModelHelpers;
}

test("Codex default model fallback is not relabeled as a saved model choice", () => {
  const helpers = loadModelHelpers();
  helpers.initModelHelpers({
    state: {
      modelCatalog: [],
      runtime: {
        model: { provider: "openai-codex", model: "default" },
        connectedProviders: [],
      },
    },
    els: {},
    providerLabels: { "openai-codex": "OpenAI Codex" },
    providerPresets: {
      "openai-codex": { provider: "openai-codex", model: "default" },
    },
  });

  const codex = helpers.catalogEntries().find(
    (entry) => entry.provider === "openai-codex",
  );

  assert.equal(codex.label, "default");
  assert.equal(
    helpers.modelDisplayName({ provider: "openai-codex", model: "default" }),
    "default | OpenAI Codex",
  );
});
