const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { test } = require("node:test");
const { createMiaMemoryService } = require("../src/main/mia-memory-service.js");
const {
  createMem0HttpMemoryProvider,
  createMiaMemoryProvider,
  normalizeProviderResult
} = require("../src/main/mia-memory-provider.js");

function setup(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-memory-"));
  const memoryPath = path.join(dir, "memory.json");
  const memoryDb = path.join(dir, "memory.sqlite");
  const services = [];
  t.after(() => {
    for (const service of services) service.close?.();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  function createService(extra = {}) {
    const service = createMiaMemoryService({
      runtimePaths: () => ({ home: dir, memory: memoryPath, memoryDb }),
      now: () => "2026-06-03T00:00:00.000Z",
      currentUserId: () => "user_a",
      ...overrides,
      ...extra
    });
    services.push(service);
    return service;
  }
  return { createService, dir, memoryPath, memoryDb };
}

test("memory service stores scoped memories without exposing a prompt block renderer", (t) => {
  const { createService } = setup(t);
  const service = createService();

  service.setSharedMemory(["prefers concise Chinese answers"]);
  service.setBotMemory("mei", ["Mei should confirm risky actions first"]);
  const session = service.rememberMemory({
    botId: "mei",
    sessionId: "s1",
    scope: "session",
    kind: "preference",
    text: "This session is about lunch plans",
    confidence: 0.9
  });

  assert.equal(session.status, "active");
  assert.equal(service.memoryBlock, undefined);
  assert.equal(service.searchMemories({ botId: "mei", sessionId: "s1", query: "concise" }).length, 1);
  assert.equal(service.searchMemories({ botId: "mei", sessionId: "s1", query: "risky" }).length, 1);
  assert.equal(service.searchMemories({ botId: "mei", sessionId: "s1", query: "lunch" }).length, 1);
});

test("memory retrieval audit stores budgets without raw text", (t) => {
  const { createService, memoryDb } = setup(t);
  const service = createService();
  const memoryText = "User likes soba noodles on rainy Fridays";

  service.rememberMemory({
    botId: "mei",
    sessionId: "s1",
    scope: "bot",
    text: memoryText,
    confidence: 0.9
  });
  assert.equal(service.searchMemories({ botId: "mei", sessionId: "s1", query: "soba noodles" }).length, 1);

  const db = new DatabaseSync(memoryDb);
  try {
    const rows = db.prepare("SELECT after_json FROM memory_events WHERE event = 'retrieve'").all();
    assert.equal(rows.length, 1);
    const after = JSON.parse(rows[0].after_json);
    assert.deepEqual(Object.keys(after).sort(), ["botId", "queryChars", "resultChars", "resultCount", "sessionId"].sort());
    assert.equal(after.queryChars, "soba noodles".length);
    assert.equal(after.resultCount, 1);
    assert.equal(after.resultChars, memoryText.length);
    assert.equal(after.botId, "mei");
    assert.equal(after.sessionId, "s1");
    const serialized = JSON.stringify(after);
    assert.equal(serialized.includes("soba"), false);
    assert.equal(serialized.includes("noodles"), false);
    assert.equal(serialized.includes("rainy"), false);
  } finally {
    db.close();
  }
});

test("legacy mia-memory.json is migrated into the scoped store", (t) => {
  const { createService, memoryPath } = setup(t);
  fs.writeFileSync(memoryPath, JSON.stringify({
    shared: ["legacy shared preference"],
    bots: { mei: ["legacy mei note"] },
    updatedAt: "2026-06-01T00:00:00.000Z"
  }), "utf8");

  const service = createService();

  assert.equal(service.memoryBlock, undefined);
  assert.equal(service.searchMemories({ botId: "mei", sessionId: "s1", query: "shared preference" })
    .some((memory) => memory.text === "legacy shared preference"), true);
  assert.equal(service.searchMemories({ botId: "mei", sessionId: "s1", query: "mei note" })
    .some((memory) => memory.text === "legacy mei note"), true);
  assert.deepEqual(service.readStore().shared, ["legacy shared preference"]);
  assert.deepEqual(service.readStore().bots.mei, ["legacy mei note"]);
});

test("memory search respects bot and session scope isolation", (t) => {
  const { createService } = setup(t);
  const service = createService();

  assert.equal(service.rememberMemory({
    botId: "mei",
    sessionId: "s1",
    scope: "bot",
    text: "Mei project codename is apricot",
    confidence: 0.9
  }).status, "active");
  assert.equal(service.rememberMemory({
    botId: "mei",
    sessionId: "s1",
    scope: "session",
    text: "The s1 decision is noodles",
    confidence: 0.9
  }).status, "active");

  assert.equal(service.searchMemories({ botId: "mei", sessionId: "s1", query: "apricot" }).length, 1);
  assert.equal(service.searchMemories({ botId: "other", sessionId: "s1", query: "apricot" }).length, 0);
  assert.equal(service.searchMemories({ botId: "mei", sessionId: "s1", query: "noodles" }).length, 1);
  assert.equal(service.searchMemories({ botId: "mei", sessionId: "s2", query: "noodles" }).length, 0);
});

test("memory policy stores scoped memories and ignores credentials", (t) => {
  const { createService } = setup(t);
  const service = createService();

  const userWide = service.rememberMemory({
    botId: "mei",
    sessionId: "s1",
    scope: "user",
    text: "User prefers morning summaries",
    confidence: 0.9
  });
  assert.equal(userWide.status, "active");
  assert.equal(userWide.effectiveScope, "user");
  assert.equal(service.searchMemories({ botId: "mei", sessionId: "s1", query: "morning" }).length, 1);
  assert.equal(service.listMemories({ botId: "mei", sessionId: "s1", scopes: ["user"] }).length, 1);

  const lowConfidence = service.rememberMemory({
    botId: "mei",
    sessionId: "s1",
    scope: "bot",
    text: "Maybe the user likes long reports",
    confidence: 0.3
  });
  assert.equal(lowConfidence.status, "active");

  const ignored = service.rememberMemory({
    botId: "mei",
    sessionId: "s1",
    scope: "bot",
    text: "password is hunter2",
    confidence: 0.9
  });
  assert.equal(ignored.status, "ignored");
  assert.equal(service.searchMemories({ botId: "mei", sessionId: "s1", query: "hunter2" }).length, 0);
});

test("manual and agent user memories are active and list queries are side-effect free", (t) => {
  const { createService } = setup(t);
  const service = createService();

  const agentWide = service.rememberMemory({
    botId: "mei",
    sessionId: "s1",
    scope: "user",
    text: "User likes morning check-ins",
    confidence: 0.9
  });
  assert.equal(agentWide.status, "active");

  const manualWide = service.rememberMemory({
    botId: "mei",
    sessionId: "s1",
    scope: "user",
    text: "User prefers short weekly summaries",
    source: "manual",
    trusted: true,
    confidence: 1
  });
  assert.equal(manualWide.status, "active");
  assert.equal(manualWide.effectiveScope, "user");

  const rows = service.listMemories({
    botId: "mei",
    sessionId: "s1",
    scopes: ["user"],
    query: "weekly"
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].lastUsedAt, "");
  assert.equal(service.listMemories({
    botId: "other",
    sessionId: "s2",
    scopes: ["user"],
    query: "weekly"
  }).length, 1);
});

test("near-duplicate memory writes reuse scoped entries", (t) => {
  const { createService } = setup(t);
  const service = createService();

  const first = service.rememberMemory({
    botId: "mei",
    sessionId: "s1",
    scope: "bot",
    kind: "preference",
    text: "User prefers compact architecture notes in Chinese",
    confidence: 0.9
  });
  assert.equal(first.status, "active");

  const duplicate = service.rememberMemory({
    botId: "mei",
    sessionId: "s1",
    scope: "bot",
    kind: "preference",
    text: "The user prefers compact architecture notes in Chinese.",
    confidence: 0.95
  });
  assert.equal(duplicate.status, "active");
  assert.equal(duplicate.memoryId, first.memoryId);
  assert.equal(duplicate.policyReason, "duplicate memory");
  const activeRows = service.listMemories({ botId: "mei", sessionId: "s1", query: "architecture" });
  assert.equal(activeRows.length, 1);

  const isolated = service.rememberMemory({
    botId: "other",
    sessionId: "s1",
    scope: "bot",
    kind: "preference",
    text: "The user prefers compact architecture notes in Chinese.",
    confidence: 0.95
  });
  assert.equal(isolated.status, "active");
  assert.notEqual(isolated.memoryId, first.memoryId);

  const userDuplicate = service.rememberMemory({
    botId: "mei",
    sessionId: "s1",
    scope: "user",
    kind: "preference",
    text: "The user prefers morning summaries.",
    confidence: 0.9
  });
  assert.equal(userDuplicate.status, "active");
  assert.equal(service.listMemories({ botId: "mei", sessionId: "s1", scopes: ["user"], query: "morning" }).length, 1);
});

test("memory priority influences visible retrieval order and can be updated", (t) => {
  const { createService } = setup(t);
  const service = createService();

  const low = service.rememberMemory({
    botId: "mei",
    sessionId: "s1",
    scope: "bot",
    text: "Use the standard launch checklist",
    confidence: 0.9,
    priority: 1
  });
  const high = service.rememberMemory({
    botId: "mei",
    sessionId: "s1",
    scope: "bot",
    text: "Always confirm launch blockers before publishing",
    confidence: 0.9,
    priority: 50
  });

  assert.equal(low.status, "active");
  assert.equal(high.status, "active");
  assert.deepEqual(
    service.listMemories({ botId: "mei", sessionId: "s1", scopes: ["bot"], query: "" }).map((memory) => memory.id),
    [high.memoryId, low.memoryId]
  );

  const promoted = service.updateMemory({
    botId: "mei",
    sessionId: "s1",
    memoryId: low.memoryId,
    text: "Use the standard launch checklist",
    confidence: 0.9,
    priority: 80
  });
  assert.equal(promoted.status, "active");
  assert.equal(promoted.memory.priority, 80);
  assert.deepEqual(
    service.listMemories({ botId: "mei", sessionId: "s1", scopes: ["bot"], query: "" }).map((memory) => memory.id),
    [low.memoryId, high.memoryId]
  );
});

test("native memory file sync exports only visible scoped active memories", (t) => {
  const { createService, dir } = setup(t);
  const service = createService();

  service.rememberMemory({
    botId: "mei",
    sessionId: "s1",
    scope: "user",
    source: "manual",
    trusted: true,
    text: "User prefers direct summaries",
    confidence: 1
  });
  service.rememberMemory({
    botId: "mei",
    sessionId: "s1",
    scope: "bot",
    text: "Mei should keep architecture notes compact",
    confidence: 0.9
  });
  service.rememberMemory({
    botId: "mei",
    sessionId: "s1",
    scope: "session",
    text: "This conversation is about native memory files",
    confidence: 0.9
  });
  service.rememberMemory({
    botId: "other",
    sessionId: "s1",
    scope: "bot",
    text: "Other bot private memory must not leak",
    confidence: 0.9
  });

  const result = service.syncNativeMemoryFiles({ engine: "openclaw", botId: "mei", sessionId: "s1" });
  assert.equal(result.ok, true);
  assert.equal(result.count, 3);
  assert.match(result.memoryPath, /native-memory[\\/]openclaw[\\/]mei[\\/]MEMORY\.md$/);

  const content = fs.readFileSync(result.memoryPath, "utf8");
  assert.match(content, /# Mia Memories/);
  assert.match(content, /## User Memory/);
  assert.match(content, /User prefers direct summaries/);
  assert.match(content, /## Bot Memory/);
  assert.match(content, /Mei should keep architecture notes compact/);
  assert.match(content, /## Session Memory/);
  assert.match(content, /native memory files/);
  assert.doesNotMatch(content, /Other bot private memory/);

  const explicitWorkspace = path.join(dir, "explicit-openclaw-workspace");
  const explicit = service.syncNativeMemoryFiles({
    engine: "openclaw",
    botId: "mei",
    sessionId: "s1",
    includeSession: false,
    workspaceDir: explicitWorkspace
  });
  assert.equal(explicit.memoryPath, path.join(explicitWorkspace, "MEMORY.md"));
  assert.equal(explicit.count, 2);
  assert.doesNotMatch(fs.readFileSync(explicit.memoryPath, "utf8"), /native memory files/);
});

test("account memory governance lists and deletes owned memories", (t) => {
  const { createService } = setup(t);
  const service = createService();
  const otherUserService = createService({ currentUserId: () => "user_b" });

  const memory = service.rememberMemory({
    botId: "mei",
    sessionId: "s1",
    scope: "user",
    text: "User prefers product notes in Chinese",
    confidence: 0.9
  });
  assert.equal(memory.status, "active");

  assert.equal(service.listAllMemories({ scopes: ["user"] }).length, 1);
  assert.equal(otherUserService.listAllMemories({ scopes: ["user"] }).length, 0);

  assert.equal(service.searchMemories({ botId: "mei", sessionId: "s1", query: "Chinese" }).length, 1);

  const deleted = service.deleteMemory({ memoryId: memory.memoryId });
  assert.equal(deleted.status, "deleted");
  assert.equal(service.listAllMemories({ scopes: ["user"] }).length, 0);
});

test("memory sync methods preserve cloud tombstones while hiding them from governance", (t) => {
  const { createService } = setup(t);
  const service = createService();

  const local = service.rememberMemory({
    botId: "mei",
    scope: "bot",
    text: "Local memory should sync",
    confidence: 0.9
  });
  assert.equal(service.listSyncMemories({ includeDeleted: true }).length, 1);

  const deleted = service.deleteMemory({ memoryId: local.memoryId });
  assert.equal(deleted.status, "deleted");
  assert.equal(service.listAllMemories().length, 0);

  const tombstones = service.listSyncMemories({
    since: "2026-01-01T00:00:00.000Z",
    includeDeleted: true
  });
  assert.equal(tombstones.length, 1);
  assert.equal(tombstones[0].id, local.memoryId);
  assert.equal(tombstones[0].text, "");
  assert.ok(tombstones[0].deletedAt);

  const applied = service.applySyncedMemories([{
    id: "mem_remote_deleted",
    botId: "mei",
    scope: "bot",
    text: "",
    status: "deleted",
    deletedAt: "2026-06-03T00:00:00.000Z",
    updatedAt: "2026-06-03T00:00:00.000Z",
    revision: 2
  }]);
  assert.equal(applied.applied.length, 1);
  assert.equal(service.listAllMemories().length, 0);
  assert.equal(service.listSyncMemories({ includeDeleted: true }).length, 2);

  const prioritized = service.applySyncedMemories([{
    id: "mem_remote_priority",
    botId: "mei",
    scope: "bot",
    text: "Remote prioritized memory should be clamped",
    status: "active",
    priority: 999,
    updatedAt: "2026-06-04T00:00:00.000Z",
    revision: 1
  }]);
  assert.equal(prioritized.applied.length, 1);
  const rows = service.listMemories({ botId: "mei", query: "prioritized" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].priority, 100);
});

test("provider-backed extraction imports mature provider memories through Mia policy", async (t) => {
  const { createService } = setup(t);
  const providerCalls = [];
  const service = createService({
    memoryProvider: {
      name: "fake-provider",
      isAvailable: () => true,
      addMessages: async (input) => {
        providerCalls.push(input);
        return {
          memories: [
            { id: "provider-1", text: "User prefers architectural notes in Chinese", confidence: 0.9 },
            { id: "provider-2", text: "password is not imported", confidence: 0.9 }
          ],
          raw: { ok: true }
        };
      }
    }
  });

  const result = await service.extractMemoriesFromMessages({
    botId: "mei",
    sessionId: "s1",
    scope: "bot",
    messages: [
      { role: "user", content: "以后架构笔记用中文。" },
      { role: "assistant", content: "我会记住。" }
    ],
    originEngine: "hermes"
  });

  assert.equal(result.status, "ok");
  assert.equal(result.provider, "fake-provider");
  assert.equal(providerCalls.length, 1);
  assert.equal(providerCalls[0].userId, "user_a");
  assert.equal(providerCalls[0].botId, "mei");
  assert.equal(providerCalls[0].sessionId, "s1");
  assert.equal(result.memories[0].status, "active");
  assert.equal(result.memories[1].status, "ignored");
  assert.equal(service.searchMemories({ botId: "mei", sessionId: "s1", query: "Chinese" }).length, 1);
  assert.equal(service.searchMemories({ botId: "mei", sessionId: "s1", query: "password" }).length, 0);
});

test("provider-disabled extraction captures only explicit memory commands through Mia policy", async (t) => {
  const { createService } = setup(t);
  const service = createService();

  const result = await service.extractMemoriesFromMessages({
    botId: "mei",
    sessionId: "s1",
    scope: "bot",
    messages: [
      { role: "user", content: "Please remember that I prefer concise answers." },
      { role: "assistant", content: "I will remember that." }
    ],
    originEngine: "hermes",
    sourceMessageIds: ["msg_user_1", "msg_assistant_1"]
  });

  assert.equal(result.status, "ok");
  assert.equal(result.provider, "local-explicit");
  assert.equal(result.memories.length, 1);
  assert.equal(result.memories[0].status, "active");
  const stored = service.searchMemories({ botId: "mei", sessionId: "s1", query: "concise" });
  assert.equal(stored.length, 1);
  assert.equal(stored[0].kind, "preference");
  assert.equal(stored[0].source, "explicit_memory_command");
  assert.deepEqual(stored[0].sourceMessageIds, ["msg_user_1", "msg_assistant_1"]);
});

test("provider-disabled extraction accepts Chinese explicit memory punctuation", async (t) => {
  const { createService } = setup(t);
  const service = createService();

  const result = await service.extractMemoriesFromMessages({
    botId: "mei",
    sessionId: "s1",
    scope: "bot",
    messages: [
      { role: "user", content: "记住，我喜欢简短回答。" },
      { role: "assistant", content: "我会记住。" }
    ],
    originEngine: "hermes"
  });

  assert.equal(result.status, "ok");
  assert.equal(result.provider, "local-explicit");
  assert.equal(result.memories.length, 1);
  assert.equal(result.memories[0].status, "active");
  const stored = service.searchMemories({ botId: "mei", sessionId: "s1", query: "简短" });
  assert.equal(stored.length, 1);
  assert.equal(stored[0].kind, "preference");
  const listed = service.listAllMemories({ botId: "mei", sessionId: "s1", query: "简短" });
  assert.equal(listed.length, 1);
});

test("provider-disabled extraction does not infer ordinary preferences without memory commands", async (t) => {
  const { createService } = setup(t);
  const service = createService();

  const result = await service.extractMemoriesFromMessages({
    botId: "mei",
    sessionId: "s1",
    scope: "bot",
    messages: [
      { role: "user", content: "I prefer concise answers." },
      { role: "assistant", content: "Got it." }
    ],
    originEngine: "hermes"
  });

  assert.equal(result.status, "disabled");
  assert.equal(result.provider, "none");
  assert.equal(result.memories.length, 0);
  assert.equal(service.searchMemories({ botId: "mei", sessionId: "s1", query: "concise" }).length, 0);
});

test("provider-disabled explicit memory capture still rejects credentials", async (t) => {
  const { createService } = setup(t);
  const service = createService();

  const result = await service.extractMemoriesFromMessages({
    botId: "mei",
    sessionId: "s1",
    scope: "bot",
    messages: [
      { role: "user", content: "Remember that password is hunter2." }
    ],
    originEngine: "hermes"
  });

  assert.equal(result.status, "ok");
  assert.equal(result.provider, "local-explicit");
  assert.equal(result.memories.length, 1);
  assert.equal(result.memories[0].status, "ignored");
  assert.equal(service.searchMemories({ botId: "mei", sessionId: "s1", query: "hunter2" }).length, 0);
});

test("provider-backed semantic search only returns Mia-owned scoped memories", async (t) => {
  const { createService } = setup(t);
  const providerCalls = [];
  const service = createService({
    memoryProvider: {
      name: "fake-provider",
      isAvailable: () => true,
      search: async (input) => {
        providerCalls.push(input);
        return {
          memories: [
            { id: "provider-owned", text: "User prefers soba noodles", confidence: 0.95 },
            { id: "provider-other-bot", text: "Other bot private memory", confidence: 0.95 },
            { id: "provider-only", text: "Remote-only memory should not leak", confidence: 0.95 }
          ]
        };
      }
    }
  });

  const owned = service.rememberMemory({
    botId: "mei",
    sessionId: "s1",
    scope: "bot",
    kind: "preference",
    text: "User prefers soba noodles",
    confidence: 0.9
  });
  service.rememberMemory({
    botId: "other",
    sessionId: "s1",
    scope: "bot",
    kind: "fact",
    text: "Other bot private memory",
    confidence: 0.9
  });

  assert.equal(service.searchMemories({ botId: "mei", sessionId: "s1", query: "meal cuisine" }).length, 0);
  const result = await service.searchMemoriesDeep({
    botId: "mei",
    sessionId: "s1",
    query: "meal cuisine",
    limit: 5
  });

  assert.deepEqual(result.map((memory) => memory.id), [owned.memoryId]);
  assert.equal(providerCalls.length, 1);
  assert.deepEqual(providerCalls[0], {
    query: "meal cuisine",
    userId: "user_a",
    botId: "mei",
    sessionId: "s1",
    limit: 5,
    scopes: undefined,
    kinds: undefined,
    status: "active"
  });
});

test("provider-backed semantic search falls back to local results on provider errors", async (t) => {
  const { createService } = setup(t);
  const service = createService({
    memoryProvider: {
      name: "broken-provider",
      isAvailable: () => true,
      search: async () => {
        throw new Error("provider down");
      }
    }
  });

  const created = service.rememberMemory({
    botId: "mei",
    sessionId: "s1",
    scope: "bot",
    text: "User likes compact status updates",
    confidence: 0.9
  });

  const result = await service.searchMemoriesDeep({
    botId: "mei",
    sessionId: "s1",
    query: "compact",
    limit: 5
  });

  assert.deepEqual(result.map((memory) => memory.id), [created.memoryId]);
});

test("Mem0-compatible provider posts Mia scope ids and normalizes results", async () => {
  const requests = [];
  const provider = createMem0HttpMemoryProvider({
    host: "https://mem0.example",
    apiKey: "test-key",
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return {
        ok: true,
        json: async () => ({
          results: [
            { id: "m1", memory: "User likes compact answers", metadata: { event: "ADD" } },
            { id: "m2", memory: "Should be skipped", metadata: { event: "DELETE" } }
          ]
        })
      };
    }
  });

  assert.equal(provider.isAvailable(), true);
  const result = await provider.addMessages({
    userId: "user_a",
    botId: "mei",
    sessionId: "s1",
    messages: [{ role: "user", content: "I like compact answers" }],
    metadata: { source: "test" }
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://mem0.example/v3/memories/add/");
  assert.equal(requests[0].options.headers.Authorization, "Token test-key");
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    messages: [{ role: "user", content: "I like compact answers" }],
    user_id: "user_a",
    agent_id: "mei",
    run_id: "s1",
    metadata: { source: "test" }
  });
  assert.deepEqual(result.memories.map((item) => item.text), ["User likes compact answers"]);
  assert.deepEqual(normalizeProviderResult([{ id: "x", text: "hello" }]).map((item) => item.text), ["hello"]);
});

test("memory provider exposes a Hermes-style lifecycle surface while disabled by default", async () => {
  const provider = createMiaMemoryProvider({ provider: "none", env: {} });

  assert.equal(provider.isAvailable(), false);
  assert.equal((await provider.initialize()).available, false);
  assert.equal((await provider.prefetch({ query: "anything" })).memories.length, 0);
  assert.equal((await provider.searchMemories({ query: "anything" })).memories.length, 0);
  assert.equal((await provider.write({ text: "remember this" })).skipped, true);
  assert.equal((await provider.update({ text: "replace this" })).skipped, true);
  assert.equal((await provider.archive({ text: "forget this" })).skipped, true);
  assert.equal((await provider.shutdown()).ok, true);
});

test("Mem0-compatible provider searches with scoped Mia ids", async () => {
  const requests = [];
  const provider = createMem0HttpMemoryProvider({
    host: "https://mem0.example",
    apiKey: "test-key",
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return {
        ok: true,
        json: async () => ({
          memories: [
            { id: "m1", text: "User prefers soba noodles", score: 0.91 }
          ]
        })
      };
    }
  });

  const result = await provider.search({
    userId: "user_a",
    botId: "mei",
    sessionId: "s1",
    query: "food preference"
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://mem0.example/v3/memories/search/");
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    query: "food preference",
    output_format: "v1.1",
    filters: {
      user_id: "user_a",
      agent_id: "mei",
      run_id: "s1"
    }
  });
  assert.deepEqual(result.memories.map((item) => item.text), ["User prefers soba noodles"]);
});

test("Mem0-compatible provider exposes lifecycle aliases without changing scope mapping", async () => {
  const requests = [];
  const provider = createMem0HttpMemoryProvider({
    host: "https://mem0.example",
    apiKey: "test-key",
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return {
        ok: true,
        json: async () => ({ results: [{ id: "m1", memory: "User likes quiet UI" }] })
      };
    }
  });

  assert.deepEqual(await provider.initialize(), { ok: true, provider: "mem0-http", available: true });

  const searched = await provider.searchMemories({
    userId: "user_a",
    botId: "mei",
    sessionId: "s1",
    query: "ui preference"
  });
  assert.deepEqual(searched.memories.map((item) => item.text), ["User likes quiet UI"]);
  assert.equal(requests[0].url, "https://mem0.example/v3/memories/search/");
  assert.deepEqual(JSON.parse(requests[0].options.body).filters, {
    user_id: "user_a",
    agent_id: "mei",
    run_id: "s1"
  });

  const written = await provider.write({
    userId: "user_a",
    botId: "mei",
    sessionId: "s1",
    text: "User likes quiet UI"
  });
  assert.deepEqual(written.memories.map((item) => item.text), ["User likes quiet UI"]);
  assert.equal(requests[1].url, "https://mem0.example/v3/memories/add/");
  assert.deepEqual(JSON.parse(requests[1].options.body), {
    messages: [{ role: "user", content: "User likes quiet UI" }],
    user_id: "user_a",
    agent_id: "mei",
    run_id: "s1",
    metadata: {}
  });
  assert.equal((await provider.update({ text: "new" })).skipped, true);
  assert.equal((await provider.archive({ text: "old" })).skipped, true);
  assert.equal((await provider.shutdown()).ok, true);
});

test("memory update and forget use visible scoped targets only", (t) => {
  const { createService } = setup(t);
  const service = createService();

  const created = service.rememberMemory({
    botId: "mei",
    sessionId: "s1",
    scope: "bot",
    text: "User prefers mild food",
    confidence: 0.9
  });
  assert.equal(created.status, "active");

  const updated = service.updateMemory({
    botId: "mei",
    sessionId: "s1",
    memoryId: created.memoryId,
    text: "User prefers mildly spicy food",
    kind: "preference",
    confidence: 0.9
  });
  assert.equal(updated.status, "active");
  assert.equal(updated.memory.text, "User prefers mildly spicy food");
  assert.equal(service.searchMemories({ botId: "mei", sessionId: "s1", query: "mildly" }).length, 1);

  assert.equal(service.updateMemory({
    botId: "other",
    sessionId: "s1",
    memoryId: created.memoryId,
    text: "Other bot should not edit this"
  }).status, "not_found");

  const forgotten = service.forgetMemory({
    botId: "mei",
    sessionId: "s1",
    oldText: "mildly spicy"
  });
  assert.equal(forgotten.status, "deleted");
  assert.equal(service.searchMemories({ botId: "mei", sessionId: "s1", query: "mildly" }).length, 0);
});

test("empty memory exposes no prompt block renderer", (t) => {
  const { createService } = setup(t);
  const service = createService();

  assert.equal(service.memoryBlock, undefined);
  assert.deepEqual(service.searchMemories({ botId: "mei", sessionId: "s1", query: "" }), []);
});
