const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  createHermesInstallSourceService
} = require("../src/main/hermes-install-source-service.js");

test("install source defaults to PyPI requirement with a China-first mirror index", () => {
  const service = createHermesInstallSourceService({
    env: {},
    officialPackage: "hermes-agent",
    officialExtras: "web"
  });

  const source = service.resolveInstallSource();

  assert.equal(source.kind, "pypi");
  assert.equal(source.package, "hermes-agent");
  assert.equal(source.extras, "web");
  assert.equal(source.requirement, "hermes-agent[web]");
  assert.equal(source.baseRequirement, "hermes-agent");
  assert.equal(source.indexUrl, "https://pypi.tuna.tsinghua.edu.cn/simple");
  assert.equal(source.fallbackIndexUrl, "https://pypi.org/simple");
  assert.deepEqual(source.indexUrls, [
    "https://pypi.tuna.tsinghua.edu.cn/simple",
    "https://pypi.org/simple"
  ]);
});

test("a pinned version is appended to the requirement", () => {
  const service = createHermesInstallSourceService({
    env: { MIA_ENGINE_VERSION: "0.16.0" },
    officialExtras: "web"
  });

  const source = service.resolveInstallSource();
  assert.equal(source.requirement, "hermes-agent[web]==0.16.0");
  assert.equal(source.baseRequirement, "hermes-agent==0.16.0");
});

test("custom index overrides the mirror and dedups against the fallback", () => {
  const service = createHermesInstallSourceService({
    env: {
      MIA_ENGINE_INDEX_URL: "https://pypi.org/simple",
      MIA_ENGINE_FALLBACK_INDEX_URL: "https://pypi.org/simple"
    }
  });

  const source = service.resolveInstallSource();
  assert.equal(source.indexUrl, "https://pypi.org/simple");
  assert.deepEqual(source.indexUrls, ["https://pypi.org/simple"]);
});

test("empty extras yields a bare package requirement", () => {
  const service = createHermesInstallSourceService({ env: {}, officialExtras: "" });
  const source = service.resolveInstallSource();
  assert.equal(source.requirement, "hermes-agent");
  assert.equal(source.baseRequirement, "hermes-agent");
});
