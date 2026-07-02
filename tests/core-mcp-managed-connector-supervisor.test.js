const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createManagedConnectorSupervisor } = require("../src/core/mcp/managed-connector-supervisor.js");
const { normalizeCoreMcpRecord } = require("../src/core/mcp/records.js");

function managedRecord(overrides = {}) {
  return normalizeCoreMcpRecord({
    id: "mcp_demo_managed",
    name: "Demo Managed MCP",
    nativeName: "demo-managed",
    managementMode: "managed",
    enabled: true,
    transport: { type: "http", url: "http://127.0.0.1:18100/mcp" },
    managedRuntime: {
      connectorId: "demo-managed",
      endpoint: "http://127.0.0.1:18100/mcp",
      expectedToolCount: 2
    },
    ...overrides
  });
}

test("status reports unsupported for unregistered managed connectors", async () => {
  const supervisor = createManagedConnectorSupervisor();

  const status = await supervisor.status(managedRecord());

  assert.equal(status.state, "unsupported");
  assert.equal(status.installed, false);
  assert.equal(status.running, false);
  assert.equal(status.message, "Managed connector is not supported.");
});

test("runAction rejects unsupported managed connectors", async () => {
  const supervisor = createManagedConnectorSupervisor();

  await assert.rejects(
    () => supervisor.runAction(managedRecord(), "start", {}),
    /Managed connector is not supported/
  );
});

test("ensureRunning marks unsupported enabled managed records as errors", async () => {
  const supervisor = createManagedConnectorSupervisor({
    now: () => 1710000000000,
    idFactory: (name) => `mcp_${String(name).replace(/[^a-z0-9_-]+/gi, "-").toLowerCase()}`
  });
  const record = managedRecord();

  const result = await supervisor.ensureRunning([record]);

  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].managedRuntime.state, "error");
  assert.equal(result.records[0].managedRuntime.lastAction, "start");
  assert.equal(result.records[0].connectionWizard.state, "managed_error");
  assert.equal(result.records[0].connectionWizard.nextAction, "start");
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].id, record.id);
  assert.equal(result.errors[0].name, record.name);
  assert.match(result.errors[0].message, /Managed connector is not supported/);
});

test("ensureRunning leaves disabled managed records untouched", async () => {
  const supervisor = createManagedConnectorSupervisor();
  const record = managedRecord({ enabled: false });

  const result = await supervisor.ensureRunning([record]);

  assert.deepEqual(result.records, [record]);
  assert.deepEqual(result.errors, []);
});

test("stop returns a canonical stopped patch when no child is tracked", async () => {
  const supervisor = createManagedConnectorSupervisor();

  const stopped = await supervisor.stop("mcp_missing");

  assert.equal(stopped.ok, true);
  assert.equal(stopped.state, "stopped");
  assert.equal(stopped.recordPatch.managedRuntime.state, "stopped");
  assert.equal(stopped.recordPatch.managedRuntime.lastAction, "stop");
});
