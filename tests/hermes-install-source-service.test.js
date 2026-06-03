const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  createHermesInstallSourceService,
  sha256Hex
} = require("../src/main/hermes-install-source-service.js");

test("official source records upstream identity and package spec", () => {
  const service = createHermesInstallSourceService({
    env: {},
    officialPackage: "hermes-agent",
    officialRepoUrl: "https://github.com/NousResearch/hermes-agent",
    officialRef: "main",
    officialExtras: "web"
  });

  const source = service.resolveInstallSource();

  assert.equal(source.kind, "official-github-archive");
  assert.equal(source.package, "hermes-agent");
  assert.equal(source.ref, "main");
  assert.equal(source.extras, "web");
  assert.equal(source.url, "https://github.com/NousResearch/hermes-agent/archive/main.tar.gz");
  assert.equal(source.requirement, "hermes-agent[web] @ https://github.com/NousResearch/hermes-agent/archive/main.tar.gz");
  assert.equal(source.checksum, "");
});

test("mirror source keeps upstream identity and checksum", () => {
  const service = createHermesInstallSourceService({
    env: {
      MIA_ENGINE_MIRROR_URL: "https://cdn.example.test/hermes-main.tar.gz",
      MIA_ENGINE_SHA256: "a".repeat(64)
    },
    officialPackage: "hermes-agent",
    officialRepoUrl: "https://github.com/NousResearch/hermes-agent",
    officialRef: "main",
    officialExtras: "web"
  });

  const source = service.resolveInstallSource();

  assert.equal(source.kind, "mia-mirror");
  assert.equal(source.url, "https://cdn.example.test/hermes-main.tar.gz");
  assert.equal(source.upstreamUrl, "https://github.com/NousResearch/hermes-agent/archive/main.tar.gz");
  assert.equal(source.checksum, "a".repeat(64));
  assert.equal(source.requirement, "hermes-agent[web] @ https://cdn.example.test/hermes-main.tar.gz");
});

test("verifyChecksum rejects mismatched archive bytes", () => {
  const service = createHermesInstallSourceService({
    env: { MIA_ENGINE_SHA256: "b".repeat(64) }
  });

  assert.throws(
    () => service.verifyChecksum(Buffer.from("archive"), "b".repeat(64)),
    /Hermes archive checksum mismatch/
  );
});

test("sha256Hex hashes bytes in lowercase hex", () => {
  assert.equal(
    sha256Hex(Buffer.from("hello")),
    "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
  );
});
