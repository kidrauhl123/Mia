const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { createProviderConnections } = require("../src/main/provider-connections.js");

function createHarness(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aimashi-provider-connections-"));
  const providerConnections = path.join(dir, "providers.json");
  const service = createProviderConnections({
    runtimePaths: () => ({ providerConnections }),
    readJson: (filePath, fallback) => {
      try {
        return JSON.parse(fs.readFileSync(filePath, "utf8"));
      } catch {
        return fallback;
      }
    },
    now: () => "2026-05-25T00:00:00.000Z",
    modelSettings: () => ({}),
    codexAuthStatus: () => ({ codexLoggedIn: false }),
    ...overrides
  });
  return { dir, providerConnections, service };
}

test("store normalizes provider rows and ignores entries without provider ids", () => {
  const { providerConnections, service } = createHarness();
  fs.writeFileSync(providerConnections, JSON.stringify({
    providers: {
      anthropic: { providerLabel: " Claude ", apiKey: " key ", apiKeyEnv: " ANTHROPIC_API_KEY " },
      empty: { provider: " " }
    }
  }));

  const store = service.store();

  assert.deepEqual(Object.keys(store.providers), ["anthropic"]);
  assert.equal(store.providers.anthropic.providerLabel, "Claude");
  assert.equal(store.providers.anthropic.apiKey, "key");
  assert.equal(store.providers.anthropic.apiKeyEnv, "ANTHROPIC_API_KEY");
});

test("save and remove persist normalized provider connections", () => {
  const { providerConnections, service } = createHarness();

  service.save({
    provider: "openai",
    label: "OpenAI",
    apiKey: "sk-test",
    baseUrl: " https://api.example "
  });
  assert.equal(service.get("openai").providerLabel, "OpenAI");
  assert.equal(service.get("openai").baseUrl, "https://api.example");

  service.remove("openai");

  assert.equal(service.get("openai"), null);
  assert.deepEqual(JSON.parse(fs.readFileSync(providerConnections, "utf8")).providers, {});
});

test("summaries hide API keys and merge codex/model fallbacks", () => {
  const { service } = createHarness({
    modelSettings: () => ({
      provider: "fallback-provider",
      apiKey: "from-model-settings",
      apiKeyEnv: "FALLBACK_KEY",
      baseUrl: "https://fallback.example",
      apiMode: "responses"
    }),
    codexAuthStatus: () => ({ codexLoggedIn: true })
  });
  service.save({ provider: "lmstudio", providerLabel: "LM Studio", apiKey: "" });
  service.save({ provider: "anthropic", providerLabel: "Anthropic", apiKey: "secret" });

  const summaries = service.connectedSummaries();

  assert.deepEqual(
    summaries.map((entry) => [entry.provider, entry.providerLabel, entry.hasApiKey]),
    [
      ["anthropic", "Anthropic", true],
      ["fallback-provider", "fallback-provider", true],
      ["lmstudio", "LM Studio", true],
      ["openai-codex", "OpenAI Codex", true]
    ]
  );
  assert.ok(summaries.every((entry) => !Object.hasOwn(entry, "apiKey")));
  assert.equal(summaries.find((entry) => entry.provider === "fallback-provider").apiKeyEnv, "FALLBACK_KEY");
});
