const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const {
  DEFAULT_DEV_PORT,
  DEFAULT_MULTI_PORT,
  appDataRoot,
  resolveDevLaunchConfig,
  resolveDevUserDataDir,
  validPort
} = require("../scripts/start-dev.js");

test("isolated dev profiles stay outside the installed Mia data directory", () => {
  const env = {};
  assert.equal(
    resolveDevUserDataDir({ platform: "darwin", home: "/Users/tester", env }),
    "/Users/tester/Library/Application Support/Mia-Dev"
  );
  assert.equal(
    resolveDevUserDataDir({ platform: "darwin", home: "/Users/tester", env, multi: true }),
    "/Users/tester/Library/Application Support/Mia-Dev-2"
  );
});

test("isolated dev profile respects an explicit data directory", () => {
  assert.equal(
    resolveDevUserDataDir({ env: { MIA_USER_DATA_DIR: "/tmp/mia-test-profile" }, home: "/Users/tester" }),
    path.resolve("/tmp/mia-test-profile")
  );
});

test("dev launch config enables multiple instances and preserves explicit port", async () => {
  const config = await resolveDevLaunchConfig({
    env: { MIA_CORE_PORT: "27963", MIA_ALLOW_MULTIPLE_INSTANCES: "1" },
    platform: "darwin",
    home: "/Users/tester"
  });

  assert.equal(config.corePort, 27963);
  assert.equal(config.env.MIA_CORE_PORT, "27963");
  assert.equal(config.env.MIA_ALLOW_MULTIPLE_INSTANCES, "1");
  assert.equal(config.userDataDir, "/Users/tester/Library/Application Support/Mia-Dev");
});

test("dev launcher has separate default ports for the first and second profile", () => {
  assert.ok(DEFAULT_MULTI_PORT > DEFAULT_DEV_PORT);
  assert.match(appDataRoot({ platform: "linux", home: "/home/tester", env: {} }), /\.config$/);
  assert.equal(validPort("27963"), 27963);
  assert.equal(validPort("not-a-port"), 0);
});
