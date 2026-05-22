const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");

test("mobile pairing credentials are not persisted in localStorage", () => {
  const source = fs.readFileSync(path.join(root, "src/mobile/app.js"), "utf8");

  assert.doesNotMatch(source, /localStorage\.setItem\(storageKeys\.(token|secret)\b/);
  assert.doesNotMatch(source, /localStorage\.getItem\(storageKeys\.(token|secret)\b/);
  assert.match(source, /writeStorageValue\(sessionStorage, credentialStorageKeys\.token/);
  assert.match(source, /writeStorageValue\(sessionStorage, credentialStorageKeys\.secret/);
  assert.match(source, /clearLegacyPersistedCredentials/);
});
