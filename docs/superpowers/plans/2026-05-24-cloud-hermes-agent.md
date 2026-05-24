# Cloud Hermes Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one default cloud-backed Hermes Fellow per user, with server-side runtime binding, per-user worker isolation roots, and replies flowing through existing rooms/messages/events.

**Architecture:** Keep Fellow identity in `fellows`; add runtime binding/run stores under `src/cloud-agent`. Registration/login/bootstrap ensure the default Fellow room exists. `POST /api/rooms/:id/messages` continues to write the user message first, then a dispatcher calls a per-user Hermes worker client and appends the Fellow reply to the same room.

**Tech Stack:** Node.js CommonJS, built-in `node:test`, SQLite via current cloud store, Hermes `/v1/runs` + SSE-compatible client abstraction.

---

### Task 1: Stores and Schema

**Files:**
- Modify: `src/cloud/sqlite-store.js`
- Create: `src/cloud-agent/runtime-bindings-store.js`
- Create: `src/cloud-agent/cloud-agent-runs-store.js`
- Test: `tests/cloud-agent-stores.test.js`

- [ ] **Step 1: Write failing store tests**

Create `tests/cloud-agent-stores.test.js` covering:

```js
test("schema has fellow runtime bindings and cloud agent runs", () => {
  const ctx = freshStore();
  const tables = ctx.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  assert.ok(tables.includes("fellow_runtime_bindings"));
  assert.ok(tables.includes("cloud_agent_runs"));
});

test("runtime binding upsert/get scopes by user and fellow", () => {
  const bindings = createRuntimeBindingsStore(ctx.db);
  bindings.upsertBinding({ userId: "u1", fellowId: "aimashi", runtimeKind: "cloud-hermes", enabled: true, config: { model: "hermes-agent" } });
  assert.equal(bindings.getBinding("u1", "aimashi", "cloud-hermes").enabled, true);
  assert.equal(bindings.getBinding("u2", "aimashi", "cloud-hermes"), null);
});

test("cloud agent run lifecycle records hermes run id and completion", () => {
  const runs = createCloudAgentRunsStore(ctx.db);
  const run = runs.createRun({ userId: "u1", fellowId: "aimashi", roomId: "fellow:u1:aimashi", triggerMessageId: "m1" });
  runs.markRunning(run.id, "hr_1");
  runs.markComplete(run.id);
  assert.equal(runs.getRun(run.id).status, "complete");
});
```

- [ ] **Step 2: Run test and verify RED**

Run: `node --test tests/cloud-agent-stores.test.js`

Expected: FAIL because `src/cloud-agent/runtime-bindings-store.js` does not exist or schema tables are missing.

- [ ] **Step 3: Implement schema and stores**

Add tables and migration version in `src/cloud/sqlite-store.js`. Implement:

```js
createRuntimeBindingsStore(db).upsertBinding({ userId, fellowId, runtimeKind, enabled, config })
createRuntimeBindingsStore(db).getBinding(userId, fellowId, runtimeKind)
createRuntimeBindingsStore(db).getEnabledBinding(userId, fellowId, runtimeKind)
createCloudAgentRunsStore(db).createRun(...)
createCloudAgentRunsStore(db).markRunning(id, hermesRunId)
createCloudAgentRunsStore(db).markComplete(id)
createCloudAgentRunsStore(db).markError(id, error)
createCloudAgentRunsStore(db).getRun(id)
```

- [ ] **Step 4: Verify GREEN**

Run: `node --test tests/cloud-agent-stores.test.js`

Expected: PASS.

### Task 2: Default Cloud Fellow Bootstrap

**Files:**
- Create: `src/cloud-agent/default-fellow.js`
- Modify: `scripts/serve-cloud.js`
- Test: `tests/cloud-agent-default-fellow.test.js`

- [ ] **Step 1: Write failing default Fellow tests**

Cover direct helper and HTTP registration:

```js
test("ensureDefaultCloudFellow creates fellow, binding, room, and members idempotently", () => {
  const out1 = ensureDefaultCloudFellow(ctx, user.id);
  const out2 = ensureDefaultCloudFellow(ctx, user.id);
  assert.equal(out1.room.id, `fellow:${user.id}:aimashi`);
  assert.equal(ctx.bindings.getEnabledBinding(user.id, "aimashi", "cloud-hermes").runtimeKind, "cloud-hermes");
  assert.equal(ctx.social.listRoomsForUser(user.id).filter((r) => r.id === out1.room.id).length, 1);
});

test("registration returns an account whose rooms include the default cloud fellow", async () => {
  const account = await jsonFetch(baseUrl, "/api/auth/register", { method: "POST", body: { username: "alice", password: "123456" } });
  const rooms = await jsonFetch(baseUrl, "/api/rooms", { headers: { authorization: `Bearer ${account.token}` } });
  assert.ok(rooms.rooms.some((r) => r.id === `fellow:${account.user.id}:aimashi` && r.type === "fellow"));
});
```

- [ ] **Step 2: Run test and verify RED**

Run: `node --test tests/cloud-agent-default-fellow.test.js`

Expected: FAIL because `ensureDefaultCloudFellow` does not exist.

- [ ] **Step 3: Implement default Fellow ensure**

`ensureDefaultCloudFellow({ fellowsStore, runtimeBindingsStore, socialStore }, userId)` must:

1. Upsert `fellows(owner=userId, id='aimashi')`.
2. Upsert enabled `cloud-hermes` binding.
3. Create/update `fellow:<userId>:aimashi` room with `type='fellow'`.
4. Add user and fellow room members.
5. Return `{ fellow, binding, room, members }`.

Wire it after register, login, `/api/me`, and before `/api/rooms` list.

- [ ] **Step 4: Verify GREEN**

Run: `node --test tests/cloud-agent-default-fellow.test.js`

Expected: PASS.

### Task 3: Hermes Worker Roots and Runs Client

**Files:**
- Create: `src/cloud-agent/hermes-worker-manager.js`
- Create: `src/cloud-agent/hermes-runs-client.js`
- Test: `tests/cloud-agent-hermes-client.test.js`

- [ ] **Step 1: Write failing worker/client tests**

Cover per-user path isolation and payload:

```js
test("worker manager derives separate roots and env per user", () => {
  const manager = createHermesWorkerManager({ rootDir: "/tmp/agents" });
  assert.equal(manager.pathsForUser("user_a").workspace, "/tmp/agents/user_a/workspace");
  assert.notEqual(manager.pathsForUser("user_a").home, manager.pathsForUser("user_b").home);
  assert.equal(manager.envForUser("user_a").HERMES_HOME, "/data/hermes-home");
});

test("Hermes runs client sends Fellow headers and returns final text", async () => {
  const client = createHermesRunsClient({ fetch: fakeFetch });
  const out = await client.runChat({ baseUrl: "http://worker", apiKey: "k", userId: "u1", fellow, roomId, input: "hi", conversationHistory: [] });
  assert.equal(out.content, "hello");
  assert.equal(fakeCalls[0].headers["X-Aimashi-Fellow"], "aimashi");
});
```

- [ ] **Step 2: Run test and verify RED**

Run: `node --test tests/cloud-agent-hermes-client.test.js`

Expected: FAIL because modules do not exist.

- [ ] **Step 3: Implement manager and client**

Worker manager provides `pathsForUser`, `envForUser`, and `ensureWorker(userId)`. For tests/dev, `ensureWorker` can return a configured static `baseUrl`; production Docker startup remains behind the same interface and requires `AIMASHI_CLOUD_HERMES_IMAGE`.

Runs client posts to `/v1/runs`, reads `/v1/runs/:id/events` SSE, and returns `{ runId, content, events }`.

- [ ] **Step 4: Verify GREEN**

Run: `node --test tests/cloud-agent-hermes-client.test.js`

Expected: PASS.

### Task 4: Dispatcher and Message Flow

**Files:**
- Create: `src/cloud-agent/dispatcher.js`
- Modify: `scripts/serve-cloud.js`
- Test: `tests/cloud-agent-dispatcher.test.js`
- Test: `tests/cloud-agent-server-flow.test.js`

- [ ] **Step 1: Write failing dispatcher tests**

Cover direct dispatcher:

```js
test("dispatcher only runs enabled cloud-hermes fellow rooms", async () => {
  await dispatcher.handleUserMessage({ userId, roomId, message });
  assert.equal(fakeHermes.calls.length, 1);
  const replies = messages.listMessagesSince(roomId, 0).filter((m) => m.sender_kind === "fellow");
  assert.equal(replies[0].body_md, "cloud reply");
});
```

Cover HTTP flow with injected fake cloud agent:

```js
test("POST /api/rooms/:id/messages appends cloud fellow reply", async () => {
  const sent = await jsonFetch(baseUrl, `/api/rooms/${roomId}/messages`, { method: "POST", headers: authHeaders, body: { bodyMd: "hi", clientOpId: "op1" } });
  await waitUntil(() => server.aimashi.cloudAgentDispatcher.idle());
  const listed = await jsonFetch(baseUrl, `/api/rooms/${roomId}/messages`, { headers: authHeaders });
  assert.deepEqual(listed.messages.map((m) => m.sender_kind), ["user", "fellow"]);
});
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
node --test tests/cloud-agent-dispatcher.test.js
node --test tests/cloud-agent-server-flow.test.js
```

Expected: FAIL because dispatcher is missing or server does not call it.

- [ ] **Step 3: Implement dispatcher and server hook**

On successful user message append:

1. Broadcast user message as today.
2. Call `context.cloudAgentDispatcher.handleUserMessage({ userId: auth.user.id, roomId, message })` without blocking the HTTP response.
3. Dispatcher verifies room type, member ownership, enabled binding, creates a run, calls worker/client, appends Fellow reply, and broadcasts `room.message_appended`.

- [ ] **Step 4: Verify GREEN**

Run the two dispatcher tests. Expected: PASS.

### Task 5: Final Verification

**Files:**
- Modify only if failures identify missing integration.

- [ ] **Step 1: Run focused cloud-agent tests**

Run:

```bash
node --test tests/cloud-agent-*.test.js
```

Expected: PASS.

- [ ] **Step 2: Run project check**

Run: `npm run check`

Expected: PASS.

- [ ] **Step 3: Run full tests**

Run: `npm test`

Expected: PASS or only pre-existing unrelated failures documented with exact failing test names and reason.
