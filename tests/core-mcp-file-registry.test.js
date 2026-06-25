const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { createCoreMcpFileRegistry } = require("../src/core/mcp/file-registry.js");

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-core-mcp-registry-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const registryPath = path.join(dir, "mia-mcp-servers.json");
  const registry = createCoreMcpFileRegistry({
    runtimePaths: () => ({ mcpServers: registryPath }),
    fs,
    now: () => 1710000000000,
    idFactory: (name) => `mcp_${name}`
  });
  return { registry, registryPath };
}

test("upsert persists normalized records and list hides soft-deleted by default", async (t) => {
  const { registry, registryPath } = setup(t);
  const saved = await registry.upsert({
    name: "playwright",
    transport: { type: "stdio", command: "npx", args: ["-y", "@playwright/mcp@latest"] }
  });

  await registry.softDelete(saved.id);

  assert.deepEqual((await registry.list()).map((record) => record.name), []);
  assert.deepEqual((await registry.list({ includeDeleted: true })).map((record) => record.name), ["playwright"]);
  assert.equal(JSON.parse(fs.readFileSync(registryPath, "utf8"))[0].deletedAt, 1710000000000);
});

test("get resolves by id or name including deleted records", async (t) => {
  const { registry } = setup(t);
  const saved = await registry.upsert({
    name: "xhs",
    transport: { type: "http", url: "http://127.0.0.1:18060/mcp" }
  });
  await registry.softDelete(saved.id);

  assert.equal((await registry.get(saved.id)).name, "xhs");
  assert.equal((await registry.get("xhs")).id, saved.id);
});

test("registry preserves null lastTestCode and deletedAt across disk round-trip", async (t) => {
  const { registry } = setup(t);

  await registry.writeAll([{
    id: "mcp_nulls",
    name: "nulls",
    transport: { type: "stdio", command: "npx" },
    lastTestCode: null,
    deletedAt: null
  }]);

  const [record] = await registry.readAll();
  assert.equal(record.lastTestCode, null);
  assert.equal(record.deletedAt, null);
});

test("upsert restores a soft-deleted record and re-enables it by default", async (t) => {
  const { registry } = setup(t);
  const saved = await registry.upsert({
    name: "restore-me",
    enabled: false,
    transport: { type: "stdio", command: "npx" }
  });

  await registry.softDelete(saved.id);
  const restored = await registry.upsert({
    name: "restore-me",
    transport: { type: "stdio", command: "node", args: ["server.js"] }
  });

  assert.equal(restored.id, saved.id);
  assert.equal(restored.deletedAt, null);
  assert.equal(restored.enabled, true);
  assert.equal(restored.transport.command, "node");
  assert.deepEqual((await registry.list()).map((record) => record.name), ["restore-me"]);
});

test("upsert rejects reserved builtin names for user records", async (t) => {
  const { registry } = setup(t);

  await assert.rejects(
    registry.upsert({
      name: "mia-app",
      transport: { type: "stdio", command: "node" }
    }),
    /invalid/i
  );
  await assert.rejects(
    registry.upsert({
      name: "mia-scheduler",
      transport: { type: "stdio", command: "node" }
    }),
    /invalid/i
  );
});
