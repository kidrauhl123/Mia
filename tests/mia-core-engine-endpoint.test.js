const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  coreHermesBaseUrl,
  coreReadHermesApiKey,
  coreReadHermesPort
} = require("../src/core/mia-core.js");

function seedHermesHome(hermesHome, { port, key }) {
  fs.mkdirSync(hermesHome, { recursive: true });
  fs.writeFileSync(
    path.join(hermesHome, "config.yaml"),
    `platforms:\n  api_server:\n    enabled: true\n    host: 127.0.0.1\n    port: ${port}\n    key: ${key}\n`,
    "utf8"
  );
  fs.writeFileSync(path.join(hermesHome, "mia-api-server.key"), `${key}\n`, "utf8");
}

test("coreReadHermesPort / coreHermesBaseUrl / coreReadHermesApiKey read the on-disk source of truth", () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "mia-core-endpoint-unit-"));
  try {
    const hermesHome = path.join(tempHome, ".hermes");
    assert.equal(coreReadHermesPort(hermesHome), 18642);
    assert.equal(coreHermesBaseUrl(hermesHome), "http://127.0.0.1:18642");
    assert.equal(coreReadHermesApiKey(hermesHome), "");

    seedHermesHome(hermesHome, { port: 28642, key: "unit-key-xyz" });
    assert.equal(coreReadHermesPort(hermesHome), 28642);
    assert.equal(coreHermesBaseUrl(hermesHome), "http://127.0.0.1:28642");
    assert.equal(coreReadHermesApiKey(hermesHome), "unit-key-xyz");
  } finally {
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});
