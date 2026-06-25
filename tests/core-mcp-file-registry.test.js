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
