# S1a Cloud：加好友 + 私聊 + 多端 seq 一致性（服务端）— 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 mia cloud server 上加齐"加好友 + 1:1 私聊 + 服务端权威 seq + 端增量拉取"所需的 schema、store helpers、HTTP endpoints、WS 广播事件。本 plan 范围仅 server 端，**不动桌面 client / 移动端 / Web 端 UI**（那是 S1b plan）。

**Architecture:** 在现有 `src/cloud/sqlite-store.js` 上叠 schema v2（5 张新表）；新建 `src/cloud/social-store.js` + `src/cloud/messages-store.js` 承担 CRUD（隔离 sqlite-store.js 不让它继续膨胀）；新增 `/api/social/*` + `/api/rooms/*` HTTP routes 接入 `scripts/serve-cloud.js` 的 `handleRequest`；WS 广播复用现有 `broadcastEvent(eventHub, userId, payload)` 通道，新增 `social.*` / `room.*` 事件类型。Messages 表每条消息由 server 分配 per-room 递增 `seq`，客户端按 `since_seq=N` 增量拉取。本阶段 DM 房间是退化群（两个 `kind='user'` 成员 + 无 host），room id 由 user pair 派生 `dm:<userA>:<userB>` 字典序归一。

**Tech Stack:** Node.js + better-sqlite3（现有项目模式）、`node:test`、`node:assert/strict`、`node:crypto`、`ws`。无新依赖。

**Prerequisite:** R 阶段已 merge 到 main（`62b5dbd` + `e188347`）。本 plan 基于 main HEAD。

**Spec reference:** `docs/superpowers/specs/2026-05-21-cross-user-social-design.md` §4-§6, §9, §10.1, §10.2。

---

## File Structure

| Status | Path | Responsibility |
|---|---|---|
| Modify | `src/cloud/sqlite-store.js` | `migrate()` 增加 schema v2 (5 张新表 + 索引)；导出 `getDb()` 给新 store 用 |
| Create | `src/cloud/social-store.js` | friendships / friend_requests / rooms / room_members CRUD helpers |
| Create | `src/cloud/messages-store.js` | messages CRUD + per-room `nextSeq` 分配器 |
| Create | `src/cloud/dm-room.js` | DM room id 派生 helper + DM 创建/查找 |
| Modify | `scripts/serve-cloud.js` | `handleRequest` 中加 `/api/social/*` + `/api/rooms/*` routes；初始化 social/messages store；接入 `broadcastEvent` |
| Create | `tests/cloud-social-store.test.js` | social-store 单测 |
| Create | `tests/cloud-messages-store.test.js` | messages-store 单测 |
| Create | `tests/cloud-dm-room.test.js` | dm-room helper 单测 |
| Create | `tests/cloud-social-api.test.js` | 端到端 HTTP API 测试（启动 server，模拟两用户互动）|

**File-size budget**（CLAUDE.md 硬规则 100-500 行）：
- `social-store.js`: 目标 200-300 行
- `messages-store.js`: 目标 100-150 行
- `dm-room.js`: 目标 < 50 行
- `sqlite-store.js`: 现 700 行已饱和，本 plan 只增 ~80 行 schema + ~10 行 `getDb` 导出，控制在 ~800 行
- `serve-cloud.js`: 现 887 行已饱和，本 plan 增 ~150 行新 routes，控制在 ~1050 行（≈ 即将触发拆分门槛；S1b 之后强制拆分）

---

## Schema 总览（贯穿全 plan）

5 张新表，全部加在 cloud sqlite，schema_migrations version=2：

```sql
CREATE TABLE friendships (
  user_a       TEXT NOT NULL,           -- 字典序较小的 user_id
  user_b       TEXT NOT NULL,           -- 字典序较大的 user_id
  created_at   TEXT NOT NULL,
  PRIMARY KEY (user_a, user_b)
);

CREATE TABLE friend_requests (
  id           TEXT PRIMARY KEY,
  from_user    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_user      TEXT,                     -- 可空（短码模式未指定对方）
  code         TEXT UNIQUE,
  status       TEXT NOT NULL,            -- 'pending' | 'accepted' | 'rejected' | 'expired'
  created_at   TEXT NOT NULL,
  resolved_at  TEXT
);
CREATE INDEX idx_friend_requests_to ON friend_requests(to_user, status);
CREATE INDEX idx_friend_requests_code ON friend_requests(code, status);

CREATE TABLE rooms (
  id                TEXT PRIMARY KEY,
  name              TEXT,
  avatar            TEXT,
  host_member_json  TEXT,                -- DM 时为 NULL，群聊本期约束 kind='fellow'（S2 才用）
  decorations_json  TEXT,
  context_card_json TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE TABLE room_members (
  room_id       TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  member_kind   TEXT NOT NULL,           -- 'fellow' | 'user'
  member_ref    TEXT NOT NULL,           -- fellowId 或 userId
  owner_id      TEXT,                     -- member_kind='fellow' 时是 fellow 主人
  ai_perms_json TEXT,                     -- 群范围 permission override（仅 fellow）
  joined_at     TEXT NOT NULL,
  PRIMARY KEY (room_id, member_kind, member_ref)
);
CREATE INDEX idx_room_members_user ON room_members(member_kind, member_ref);

CREATE TABLE messages (
  id              TEXT PRIMARY KEY,
  room_id         TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  seq             INTEGER NOT NULL,
  turn_id         TEXT,
  sender_kind     TEXT NOT NULL,         -- 'user' | 'fellow' | 'system'
  sender_ref      TEXT NOT NULL,
  sender_owner_id TEXT,
  body_md         TEXT NOT NULL DEFAULT '',
  attachments_json TEXT,
  mentions_json   TEXT,
  status          TEXT NOT NULL,         -- 'streaming' | 'complete' | 'error'
  error_json      TEXT,
  created_at      TEXT NOT NULL,
  UNIQUE (room_id, seq)
);
CREATE INDEX idx_messages_room_seq ON messages(room_id, seq);
```

DM room id 规则：`dm:` + 字典序较小的 user_id + `:` + 字典序较大的 user_id。例：`dm:u_abc:u_xyz`。

---

### Task 1: Schema v2 migration

**Files:**
- Modify: `src/cloud/sqlite-store.js` (`migrate()` 函数 + 导出 `getDb`)
- Test: `tests/cloud-sqlite-store.test.js` (新增 schema 校验测试)

- [ ] **Step 1: 写 failing 测试**

在 `tests/cloud-sqlite-store.test.js` 末尾追加：

```js
test("schema v2 creates social tables and indexes", () => {
  const { store, tmpDir } = makeStore();
  try {
    const db = store.getDb();
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all().map((r) => r.name);
    for (const t of ["friendships", "friend_requests", "rooms", "room_members", "messages"]) {
      assert.ok(tables.includes(t), `missing table: ${t}`);
    }
    const idx = db.prepare(`SELECT name FROM sqlite_master WHERE type='index' ORDER BY name`).all().map((r) => r.name);
    for (const i of ["idx_friend_requests_to", "idx_friend_requests_code", "idx_room_members_user", "idx_messages_room_seq"]) {
      assert.ok(idx.includes(i), `missing index: ${i}`);
    }
    const version = db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get().v;
    assert.ok(version >= 2, `schema_migrations max version should be >= 2, got ${version}`);
  } finally {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
```

如果 `makeStore` / `tmpDir` helper 不存在，在测试文件顶部加：

```js
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createCloudStore } = require("../src/cloud/sqlite-store.js");

function makeStore() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-cloud-test-"));
  const store = createCloudStore({ dataDir: tmpDir });
  return { store, tmpDir };
}
```

（如果文件已有等价的 helper，复用现有的，不重复定义。）

- [ ] **Step 2: 跑测试看它 fail**

```bash
node --test tests/cloud-sqlite-store.test.js
```

Expected: 新增测试 FAIL（新表 / index 不存在；version=1）。

- [ ] **Step 3: 修改 `src/cloud/sqlite-store.js` 的 `migrate()` 函数 + 导出 `getDb`**

在 `function migrate(db) { ... }` 的现有 `db.exec(\`...\`)` 块末尾（CREATE INDEX `idx_bridge_runs_user` 之后，闭合反引号之前），追加：

```sql

    CREATE TABLE IF NOT EXISTS friendships (
      user_a       TEXT NOT NULL,
      user_b       TEXT NOT NULL,
      created_at   TEXT NOT NULL,
      PRIMARY KEY (user_a, user_b)
    );

    CREATE TABLE IF NOT EXISTS friend_requests (
      id           TEXT PRIMARY KEY,
      from_user    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      to_user      TEXT,
      code         TEXT UNIQUE,
      status       TEXT NOT NULL,
      created_at   TEXT NOT NULL,
      resolved_at  TEXT
    );

    CREATE TABLE IF NOT EXISTS rooms (
      id                TEXT PRIMARY KEY,
      name              TEXT,
      avatar            TEXT,
      host_member_json  TEXT,
      decorations_json  TEXT,
      context_card_json TEXT,
      created_at        TEXT NOT NULL,
      updated_at        TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS room_members (
      room_id       TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      member_kind   TEXT NOT NULL,
      member_ref    TEXT NOT NULL,
      owner_id      TEXT,
      ai_perms_json TEXT,
      joined_at     TEXT NOT NULL,
      PRIMARY KEY (room_id, member_kind, member_ref)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id              TEXT PRIMARY KEY,
      room_id         TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      seq             INTEGER NOT NULL,
      turn_id         TEXT,
      sender_kind     TEXT NOT NULL,
      sender_ref      TEXT NOT NULL,
      sender_owner_id TEXT,
      body_md         TEXT NOT NULL DEFAULT '',
      attachments_json TEXT,
      mentions_json   TEXT,
      status          TEXT NOT NULL,
      error_json      TEXT,
      created_at      TEXT NOT NULL,
      UNIQUE (room_id, seq)
    );

    CREATE INDEX IF NOT EXISTS idx_friend_requests_to ON friend_requests(to_user, status);
    CREATE INDEX IF NOT EXISTS idx_friend_requests_code ON friend_requests(code, status);
    CREATE INDEX IF NOT EXISTS idx_room_members_user ON room_members(member_kind, member_ref);
    CREATE INDEX IF NOT EXISTS idx_messages_room_seq ON messages(room_id, seq);
```

紧跟原 `INSERT OR IGNORE INTO schema_migrations (version=1, ...)` 之后，追加一行 version=2：

```js
  db.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (2, ?)")
    .run(nowIso());
```

并且在 `createCloudStore` 的返回对象（文件末尾 `return { ... }`）里加 `getDb: () => db`。位置：找现有 `return { ... }` 块，在其中追加 `getDb: () => db,` 一行。

- [ ] **Step 4: 跑测试看它 pass**

```bash
node --test tests/cloud-sqlite-store.test.js
```

Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add src/cloud/sqlite-store.js tests/cloud-sqlite-store.test.js
git commit -m "feat(cloud): schema v2 — social tables (friendships, requests, rooms, messages)"
```

---

### Task 2: social-store.js — friendships + friend_requests CRUD

**Files:**
- Create: `src/cloud/social-store.js`
- Test: `tests/cloud-social-store.test.js`

**Helpers to export this task:**
- `createSocialStore(db)` — factory that takes a sqlite db handle, returns object with the methods below
- `addFriendship(userA, userB)` — inserts (sorted by lexicographic order), idempotent
- `removeFriendship(userA, userB)` — deletes the pair
- `areFriends(userA, userB)` — boolean
- `listFriends(userId)` — returns array of friend user_ids
- `createFriendRequest({ fromUser, toUser?, code })` — inserts pending, returns the row
- `getFriendRequestByCode(code)` — returns row or null
- `acceptFriendRequest(code, accepterUserId)` — atomic: validate pending + not expired + adds friendship + marks accepted + returns resolved row; throws on invalid
- `revokeFriendRequest(code, ownerUserId)` — marks status='expired' if owner matches; throws otherwise
- `listIncomingPending(userId)` — pending requests where to_user = userId
- `expireOldRequests(maxAgeMs)` — utility for cron: mark old pending as expired

- [ ] **Step 1: 写 failing 测试**

`tests/cloud-social-store.test.js`：

```js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createCloudStore } = require("../src/cloud/sqlite-store.js");
const { createSocialStore } = require("../src/cloud/social-store.js");

function makeStores() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-social-test-"));
  const cloudStore = createCloudStore({ dataDir: tmpDir });
  const db = cloudStore.getDb();
  const social = createSocialStore(db);
  const alice = cloudStore.registerUser({ username: "alice", password: "Pa55word!" });
  const bob = cloudStore.registerUser({ username: "bob", password: "Pa55word!" });
  return { cloudStore, social, alice, bob, tmpDir };
}

function cleanup(ctx) {
  ctx.cloudStore.close();
  fs.rmSync(ctx.tmpDir, { recursive: true, force: true });
}

test("addFriendship normalizes order and is idempotent", () => {
  const ctx = makeStores();
  try {
    ctx.social.addFriendship(ctx.alice.id, ctx.bob.id);
    ctx.social.addFriendship(ctx.bob.id, ctx.alice.id); // reverse order
    const friends = ctx.social.listFriends(ctx.alice.id);
    assert.equal(friends.length, 1);
    assert.equal(friends[0], ctx.bob.id);
  } finally { cleanup(ctx); }
});

test("areFriends returns true after addFriendship, false after remove", () => {
  const ctx = makeStores();
  try {
    assert.equal(ctx.social.areFriends(ctx.alice.id, ctx.bob.id), false);
    ctx.social.addFriendship(ctx.alice.id, ctx.bob.id);
    assert.equal(ctx.social.areFriends(ctx.alice.id, ctx.bob.id), true);
    assert.equal(ctx.social.areFriends(ctx.bob.id, ctx.alice.id), true);
    ctx.social.removeFriendship(ctx.alice.id, ctx.bob.id);
    assert.equal(ctx.social.areFriends(ctx.alice.id, ctx.bob.id), false);
  } finally { cleanup(ctx); }
});

test("createFriendRequest stores pending with code", () => {
  const ctx = makeStores();
  try {
    const req = ctx.social.createFriendRequest({ fromUser: ctx.alice.id, code: "ABC12345" });
    assert.ok(req.id);
    assert.equal(req.status, "pending");
    assert.equal(req.code, "ABC12345");
    const fetched = ctx.social.getFriendRequestByCode("ABC12345");
    assert.equal(fetched.id, req.id);
  } finally { cleanup(ctx); }
});

test("acceptFriendRequest creates friendship and marks accepted atomically", () => {
  const ctx = makeStores();
  try {
    ctx.social.createFriendRequest({ fromUser: ctx.alice.id, code: "CODE1" });
    const resolved = ctx.social.acceptFriendRequest("CODE1", ctx.bob.id);
    assert.equal(resolved.status, "accepted");
    assert.ok(resolved.resolved_at);
    assert.equal(ctx.social.areFriends(ctx.alice.id, ctx.bob.id), true);
  } finally { cleanup(ctx); }
});

test("acceptFriendRequest rejects already-consumed code", () => {
  const ctx = makeStores();
  try {
    ctx.social.createFriendRequest({ fromUser: ctx.alice.id, code: "ONCE" });
    ctx.social.acceptFriendRequest("ONCE", ctx.bob.id);
    const charlie = ctx.cloudStore.registerUser({ username: "charlie", password: "Pa55word!" });
    assert.throws(() => ctx.social.acceptFriendRequest("ONCE", charlie.id), /not pending|already/i);
  } finally { cleanup(ctx); }
});

test("acceptFriendRequest rejects self-accept", () => {
  const ctx = makeStores();
  try {
    ctx.social.createFriendRequest({ fromUser: ctx.alice.id, code: "SELF" });
    assert.throws(() => ctx.social.acceptFriendRequest("SELF", ctx.alice.id), /self/i);
  } finally { cleanup(ctx); }
});

test("revokeFriendRequest marks expired only by owner", () => {
  const ctx = makeStores();
  try {
    ctx.social.createFriendRequest({ fromUser: ctx.alice.id, code: "REV" });
    assert.throws(() => ctx.social.revokeFriendRequest("REV", ctx.bob.id), /not owner|forbidden/i);
    ctx.social.revokeFriendRequest("REV", ctx.alice.id);
    const row = ctx.social.getFriendRequestByCode("REV");
    assert.equal(row.status, "expired");
  } finally { cleanup(ctx); }
});

test("expireOldRequests transitions pending older than maxAgeMs to expired", async () => {
  const ctx = makeStores();
  try {
    ctx.social.createFriendRequest({ fromUser: ctx.alice.id, code: "OLD" });
    await new Promise((r) => setTimeout(r, 50));
    const n = ctx.social.expireOldRequests(25);
    assert.ok(n >= 1);
    const row = ctx.social.getFriendRequestByCode("OLD");
    assert.equal(row.status, "expired");
  } finally { cleanup(ctx); }
});
```

- [ ] **Step 2: 跑测试看它 fail**

```bash
node --test tests/cloud-social-store.test.js
```

Expected: FAIL（`src/cloud/social-store.js` 不存在）。

- [ ] **Step 3: 实现 `src/cloud/social-store.js`**

```js
const crypto = require("node:crypto");

function nowIso() {
  return new Date().toISOString();
}

function randomId(prefix) {
  return prefix + "_" + crypto.randomBytes(8).toString("hex");
}

function orderPair(a, b) {
  return a < b ? [a, b] : [b, a];
}

function createSocialStore(db) {
  const insertFriendship = db.prepare(
    "INSERT OR IGNORE INTO friendships (user_a, user_b, created_at) VALUES (?, ?, ?)"
  );
  const deleteFriendship = db.prepare(
    "DELETE FROM friendships WHERE user_a = ? AND user_b = ?"
  );
  const selectFriendship = db.prepare(
    "SELECT 1 FROM friendships WHERE user_a = ? AND user_b = ?"
  );
  const selectFriendsOf = db.prepare(
    "SELECT user_a, user_b FROM friendships WHERE user_a = ? OR user_b = ?"
  );

  const insertRequest = db.prepare(`
    INSERT INTO friend_requests (id, from_user, to_user, code, status, created_at)
    VALUES (?, ?, ?, ?, 'pending', ?)
  `);
  const selectRequestByCode = db.prepare(
    "SELECT * FROM friend_requests WHERE code = ?"
  );
  const updateRequestStatus = db.prepare(
    "UPDATE friend_requests SET status = ?, resolved_at = ? WHERE id = ?"
  );
  const selectIncomingPending = db.prepare(`
    SELECT * FROM friend_requests
    WHERE to_user = ? AND status = 'pending'
    ORDER BY created_at DESC
  `);
  const expirePendingOlderThan = db.prepare(
    "UPDATE friend_requests SET status = 'expired' WHERE status = 'pending' AND created_at < ?"
  );

  function addFriendship(userA, userB) {
    if (userA === userB) throw new Error("cannot befriend self");
    const [a, b] = orderPair(String(userA), String(userB));
    insertFriendship.run(a, b, nowIso());
  }

  function removeFriendship(userA, userB) {
    const [a, b] = orderPair(String(userA), String(userB));
    deleteFriendship.run(a, b);
  }

  function areFriends(userA, userB) {
    const [a, b] = orderPair(String(userA), String(userB));
    return Boolean(selectFriendship.get(a, b));
  }

  function listFriends(userId) {
    const id = String(userId);
    return selectFriendsOf.all(id, id).map((row) => (row.user_a === id ? row.user_b : row.user_a));
  }

  function createFriendRequest({ fromUser, toUser = null, code }) {
    const id = randomId("fr");
    const createdAt = nowIso();
    insertRequest.run(id, String(fromUser), toUser ? String(toUser) : null, String(code), createdAt);
    return { id, from_user: String(fromUser), to_user: toUser ? String(toUser) : null, code: String(code), status: "pending", created_at: createdAt, resolved_at: null };
  }

  function getFriendRequestByCode(code) {
    return selectRequestByCode.get(String(code)) || null;
  }

  function acceptFriendRequest(code, accepterUserId) {
    const row = selectRequestByCode.get(String(code));
    if (!row) throw new Error("friend request not found");
    if (row.status !== "pending") throw new Error("friend request not pending");
    if (row.from_user === String(accepterUserId)) throw new Error("cannot accept self friend request");
    const resolvedAt = nowIso();
    const tx = db.transaction(() => {
      updateRequestStatus.run("accepted", resolvedAt, row.id);
      const [a, b] = orderPair(row.from_user, String(accepterUserId));
      insertFriendship.run(a, b, resolvedAt);
    });
    tx();
    return { ...row, status: "accepted", resolved_at: resolvedAt };
  }

  function revokeFriendRequest(code, ownerUserId) {
    const row = selectRequestByCode.get(String(code));
    if (!row) throw new Error("friend request not found");
    if (row.from_user !== String(ownerUserId)) throw new Error("not owner of friend request");
    if (row.status !== "pending") return row; // idempotent on already-resolved
    const resolvedAt = nowIso();
    updateRequestStatus.run("expired", resolvedAt, row.id);
    return { ...row, status: "expired", resolved_at: resolvedAt };
  }

  function listIncomingPending(userId) {
    return selectIncomingPending.all(String(userId));
  }

  function expireOldRequests(maxAgeMs) {
    const cutoff = new Date(Date.now() - Number(maxAgeMs)).toISOString();
    const info = expirePendingOlderThan.run(cutoff);
    return info.changes;
  }

  return {
    addFriendship,
    removeFriendship,
    areFriends,
    listFriends,
    createFriendRequest,
    getFriendRequestByCode,
    acceptFriendRequest,
    revokeFriendRequest,
    listIncomingPending,
    expireOldRequests,
  };
}

module.exports = { createSocialStore };
```

- [ ] **Step 4: 跑测试看它 pass**

```bash
node --test tests/cloud-social-store.test.js
```

Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add src/cloud/social-store.js tests/cloud-social-store.test.js
git commit -m "feat(cloud): social-store with friendships + friend_requests"
```

---

### Task 3: social-store.js — rooms + room_members

**Files:**
- Modify: `src/cloud/social-store.js` (add room helpers)
- Modify: `tests/cloud-social-store.test.js` (add room tests)

**Helpers to add:**
- `createRoom({ id, name, avatar, hostMember, decorations, contextCard })` — inserts a room
- `getRoom(roomId)` — returns parsed room or null
- `updateRoom(roomId, patch)` — partial update
- `deleteRoom(roomId)` — cascade-deletes members via FK
- `addRoomMember({ roomId, memberKind, memberRef, ownerId, aiPerms })` — inserts
- `removeRoomMember(roomId, memberKind, memberRef)` — deletes
- `listRoomMembers(roomId)` — array
- `listRoomsForUser(userId)` — rooms where the user is a member (kind='user' member_ref=userId)
- `updateRoomMemberPerms(roomId, memberKind, memberRef, aiPerms)` — for fellow override (used in S2)

- [ ] **Step 1: Failing tests**

Append to `tests/cloud-social-store.test.js`:

```js
test("createRoom + getRoom roundtrip stores JSON fields", () => {
  const ctx = makeStores();
  try {
    const created = ctx.social.createRoom({
      id: "r-1",
      name: "Test",
      avatar: null,
      hostMember: null,
      decorations: { pinnedGoal: null, todos: [] },
      contextCard: null,
    });
    assert.equal(created.id, "r-1");
    assert.equal(created.name, "Test");
    assert.deepEqual(created.decorations, { pinnedGoal: null, todos: [] });
    assert.equal(created.hostMember, null);
    const fetched = ctx.social.getRoom("r-1");
    assert.deepEqual(fetched.decorations, { pinnedGoal: null, todos: [] });
  } finally { cleanup(ctx); }
});

test("addRoomMember + listRoomMembers", () => {
  const ctx = makeStores();
  try {
    ctx.social.createRoom({ id: "r-2", name: "Pair", avatar: null, hostMember: null, decorations: null, contextCard: null });
    ctx.social.addRoomMember({ roomId: "r-2", memberKind: "user", memberRef: ctx.alice.id, ownerId: null });
    ctx.social.addRoomMember({ roomId: "r-2", memberKind: "user", memberRef: ctx.bob.id, ownerId: null });
    const members = ctx.social.listRoomMembers("r-2");
    assert.equal(members.length, 2);
    const refs = members.map((m) => m.member_ref).sort();
    assert.deepEqual(refs, [ctx.alice.id, ctx.bob.id].sort());
  } finally { cleanup(ctx); }
});

test("listRoomsForUser returns rooms where user is a member", () => {
  const ctx = makeStores();
  try {
    ctx.social.createRoom({ id: "r-3", name: "R3", avatar: null, hostMember: null, decorations: null, contextCard: null });
    ctx.social.addRoomMember({ roomId: "r-3", memberKind: "user", memberRef: ctx.alice.id, ownerId: null });
    ctx.social.addRoomMember({ roomId: "r-3", memberKind: "user", memberRef: ctx.bob.id, ownerId: null });
    ctx.social.createRoom({ id: "r-4", name: "R4", avatar: null, hostMember: null, decorations: null, contextCard: null });
    ctx.social.addRoomMember({ roomId: "r-4", memberKind: "user", memberRef: ctx.bob.id, ownerId: null });
    const aliceRooms = ctx.social.listRoomsForUser(ctx.alice.id).map((r) => r.id).sort();
    assert.deepEqual(aliceRooms, ["r-3"]);
    const bobRooms = ctx.social.listRoomsForUser(ctx.bob.id).map((r) => r.id).sort();
    assert.deepEqual(bobRooms, ["r-3", "r-4"]);
  } finally { cleanup(ctx); }
});

test("deleteRoom cascade-removes room_members", () => {
  const ctx = makeStores();
  try {
    ctx.social.createRoom({ id: "r-5", name: "X", avatar: null, hostMember: null, decorations: null, contextCard: null });
    ctx.social.addRoomMember({ roomId: "r-5", memberKind: "user", memberRef: ctx.alice.id, ownerId: null });
    ctx.social.deleteRoom("r-5");
    assert.equal(ctx.social.getRoom("r-5"), null);
    assert.deepEqual(ctx.social.listRoomMembers("r-5"), []);
  } finally { cleanup(ctx); }
});

test("removeRoomMember", () => {
  const ctx = makeStores();
  try {
    ctx.social.createRoom({ id: "r-6", name: "Y", avatar: null, hostMember: null, decorations: null, contextCard: null });
    ctx.social.addRoomMember({ roomId: "r-6", memberKind: "user", memberRef: ctx.alice.id, ownerId: null });
    ctx.social.addRoomMember({ roomId: "r-6", memberKind: "user", memberRef: ctx.bob.id, ownerId: null });
    ctx.social.removeRoomMember("r-6", "user", ctx.bob.id);
    const refs = ctx.social.listRoomMembers("r-6").map((m) => m.member_ref);
    assert.deepEqual(refs, [ctx.alice.id]);
  } finally { cleanup(ctx); }
});
```

- [ ] **Step 2: Run, verify fail**

```bash
node --test tests/cloud-social-store.test.js
```

Expected: 5 new tests FAIL.

- [ ] **Step 3: Implement**

Append inside `createSocialStore(db)` (before the final `return {...}` block):

```js
  const insertRoom = db.prepare(`
    INSERT INTO rooms (id, name, avatar, host_member_json, decorations_json, context_card_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const selectRoomById = db.prepare("SELECT * FROM rooms WHERE id = ?");
  const updateRoomCols = db.prepare(`
    UPDATE rooms SET
      name = COALESCE(?, name),
      avatar = COALESCE(?, avatar),
      host_member_json = COALESCE(?, host_member_json),
      decorations_json = COALESCE(?, decorations_json),
      context_card_json = COALESCE(?, context_card_json),
      updated_at = ?
    WHERE id = ?
  `);
  const deleteRoomStmt = db.prepare("DELETE FROM rooms WHERE id = ?");

  const insertMember = db.prepare(`
    INSERT OR IGNORE INTO room_members (room_id, member_kind, member_ref, owner_id, ai_perms_json, joined_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const deleteMember = db.prepare(
    "DELETE FROM room_members WHERE room_id = ? AND member_kind = ? AND member_ref = ?"
  );
  const selectMembers = db.prepare(
    "SELECT * FROM room_members WHERE room_id = ? ORDER BY joined_at"
  );
  const selectRoomsByUser = db.prepare(`
    SELECT r.* FROM rooms r
    INNER JOIN room_members m ON m.room_id = r.id
    WHERE m.member_kind = 'user' AND m.member_ref = ?
    ORDER BY r.updated_at DESC
  `);
  const updateMemberPerms = db.prepare(`
    UPDATE room_members SET ai_perms_json = ?
    WHERE room_id = ? AND member_kind = ? AND member_ref = ?
  `);

  function parseRoomRow(row) {
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      avatar: row.avatar,
      hostMember: row.host_member_json ? JSON.parse(row.host_member_json) : null,
      decorations: row.decorations_json ? JSON.parse(row.decorations_json) : null,
      contextCard: row.context_card_json ? JSON.parse(row.context_card_json) : null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  function createRoom({ id, name = null, avatar = null, hostMember = null, decorations = null, contextCard = null }) {
    const now = nowIso();
    insertRoom.run(
      String(id),
      name,
      avatar,
      hostMember ? JSON.stringify(hostMember) : null,
      decorations ? JSON.stringify(decorations) : null,
      contextCard ? JSON.stringify(contextCard) : null,
      now,
      now
    );
    return parseRoomRow(selectRoomById.get(String(id)));
  }

  function getRoom(roomId) {
    return parseRoomRow(selectRoomById.get(String(roomId)));
  }

  function updateRoom(roomId, patch = {}) {
    const has = (k) => Object.prototype.hasOwnProperty.call(patch, k);
    updateRoomCols.run(
      has("name") ? patch.name : null,
      has("avatar") ? patch.avatar : null,
      has("hostMember") ? (patch.hostMember ? JSON.stringify(patch.hostMember) : null) : null,
      has("decorations") ? (patch.decorations ? JSON.stringify(patch.decorations) : null) : null,
      has("contextCard") ? (patch.contextCard ? JSON.stringify(patch.contextCard) : null) : null,
      nowIso(),
      String(roomId)
    );
    return parseRoomRow(selectRoomById.get(String(roomId)));
  }

  function deleteRoom(roomId) {
    deleteRoomStmt.run(String(roomId));
  }

  function addRoomMember({ roomId, memberKind, memberRef, ownerId = null, aiPerms = null }) {
    insertMember.run(
      String(roomId),
      String(memberKind),
      String(memberRef),
      ownerId ? String(ownerId) : null,
      aiPerms ? JSON.stringify(aiPerms) : null,
      nowIso()
    );
  }

  function removeRoomMember(roomId, memberKind, memberRef) {
    deleteMember.run(String(roomId), String(memberKind), String(memberRef));
  }

  function listRoomMembers(roomId) {
    return selectMembers.all(String(roomId));
  }

  function listRoomsForUser(userId) {
    return selectRoomsByUser.all(String(userId)).map(parseRoomRow);
  }

  function updateRoomMemberPerms(roomId, memberKind, memberRef, aiPerms) {
    updateMemberPerms.run(
      aiPerms ? JSON.stringify(aiPerms) : null,
      String(roomId),
      String(memberKind),
      String(memberRef)
    );
  }
```

And extend the returned object:

```js
  return {
    addFriendship,
    removeFriendship,
    areFriends,
    listFriends,
    createFriendRequest,
    getFriendRequestByCode,
    acceptFriendRequest,
    revokeFriendRequest,
    listIncomingPending,
    expireOldRequests,
    createRoom,
    getRoom,
    updateRoom,
    deleteRoom,
    addRoomMember,
    removeRoomMember,
    listRoomMembers,
    listRoomsForUser,
    updateRoomMemberPerms,
  };
```

- [ ] **Step 4: Run, verify pass**

```bash
node --test tests/cloud-social-store.test.js
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/cloud/social-store.js tests/cloud-social-store.test.js
git commit -m "feat(cloud): social-store rooms + room_members CRUD"
```

---

### Task 4: messages-store.js — per-room seq allocator + CRUD

**Files:**
- Create: `src/cloud/messages-store.js`
- Test: `tests/cloud-messages-store.test.js`

**Helpers to export:**
- `createMessagesStore(db)` — factory
- `appendMessage({ roomId, senderKind, senderRef, senderOwnerId?, bodyMd, attachments?, mentions?, turnId?, status?, errorJson? })` — atomic: allocates next seq for room, inserts row, returns row with assigned `seq` and generated `id`
- `listMessagesSince(roomId, sinceSeq, limit?)` — returns rows with seq > sinceSeq, ascending by seq, default limit 100
- `getMessage(id)` — returns row or null
- `updateMessageStatus(id, status, errorJson?)` — used when streaming completes / errors

Critical correctness: `appendMessage` MUST be in a transaction. The seq is `MAX(seq) + 1` from messages WHERE room_id = ?. Concurrent appends to the same room must be serialized.

- [ ] **Step 1: Failing tests**

`tests/cloud-messages-store.test.js`:

```js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createCloudStore } = require("../src/cloud/sqlite-store.js");
const { createSocialStore } = require("../src/cloud/social-store.js");
const { createMessagesStore } = require("../src/cloud/messages-store.js");

function setup() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-msg-test-"));
  const cloudStore = createCloudStore({ dataDir: tmpDir });
  const db = cloudStore.getDb();
  const social = createSocialStore(db);
  const messages = createMessagesStore(db);
  const alice = cloudStore.registerUser({ username: "alice", password: "Pa55word!" });
  const bob = cloudStore.registerUser({ username: "bob", password: "Pa55word!" });
  social.createRoom({ id: "r-msg", name: null, avatar: null, hostMember: null, decorations: null, contextCard: null });
  social.addRoomMember({ roomId: "r-msg", memberKind: "user", memberRef: alice.id, ownerId: null });
  social.addRoomMember({ roomId: "r-msg", memberKind: "user", memberRef: bob.id, ownerId: null });
  return { cloudStore, social, messages, alice, bob, tmpDir };
}

function teardown(ctx) {
  ctx.cloudStore.close();
  fs.rmSync(ctx.tmpDir, { recursive: true, force: true });
}

test("appendMessage assigns ascending per-room seq starting at 1", () => {
  const ctx = setup();
  try {
    const m1 = ctx.messages.appendMessage({ roomId: "r-msg", senderKind: "user", senderRef: ctx.alice.id, bodyMd: "hi" });
    const m2 = ctx.messages.appendMessage({ roomId: "r-msg", senderKind: "user", senderRef: ctx.bob.id, bodyMd: "yo" });
    const m3 = ctx.messages.appendMessage({ roomId: "r-msg", senderKind: "user", senderRef: ctx.alice.id, bodyMd: "k" });
    assert.equal(m1.seq, 1);
    assert.equal(m2.seq, 2);
    assert.equal(m3.seq, 3);
    assert.notEqual(m1.id, m2.id);
  } finally { teardown(ctx); }
});

test("appendMessage seq is per-room not global", () => {
  const ctx = setup();
  try {
    ctx.social.createRoom({ id: "r-other", name: null, avatar: null, hostMember: null, decorations: null, contextCard: null });
    ctx.social.addRoomMember({ roomId: "r-other", memberKind: "user", memberRef: ctx.alice.id, ownerId: null });
    ctx.messages.appendMessage({ roomId: "r-msg", senderKind: "user", senderRef: ctx.alice.id, bodyMd: "1" });
    const otherFirst = ctx.messages.appendMessage({ roomId: "r-other", senderKind: "user", senderRef: ctx.alice.id, bodyMd: "1" });
    assert.equal(otherFirst.seq, 1);
  } finally { teardown(ctx); }
});

test("listMessagesSince returns only seq > sinceSeq, ascending", () => {
  const ctx = setup();
  try {
    for (let i = 1; i <= 5; i++) {
      ctx.messages.appendMessage({ roomId: "r-msg", senderKind: "user", senderRef: ctx.alice.id, bodyMd: "m" + i });
    }
    const after2 = ctx.messages.listMessagesSince("r-msg", 2);
    assert.equal(after2.length, 3);
    assert.deepEqual(after2.map((m) => m.seq), [3, 4, 5]);
    assert.equal(after2[0].body_md, "m3");
    const after5 = ctx.messages.listMessagesSince("r-msg", 5);
    assert.equal(after5.length, 0);
    const all = ctx.messages.listMessagesSince("r-msg", 0);
    assert.equal(all.length, 5);
  } finally { teardown(ctx); }
});

test("listMessagesSince respects limit", () => {
  const ctx = setup();
  try {
    for (let i = 1; i <= 10; i++) {
      ctx.messages.appendMessage({ roomId: "r-msg", senderKind: "user", senderRef: ctx.alice.id, bodyMd: "m" + i });
    }
    const page = ctx.messages.listMessagesSince("r-msg", 0, 3);
    assert.equal(page.length, 3);
    assert.deepEqual(page.map((m) => m.seq), [1, 2, 3]);
  } finally { teardown(ctx); }
});

test("appendMessage persists attachments + mentions + turn_id", () => {
  const ctx = setup();
  try {
    const m = ctx.messages.appendMessage({
      roomId: "r-msg",
      senderKind: "user",
      senderRef: ctx.alice.id,
      bodyMd: "@bob look",
      attachments: [{ kind: "image", path: "/x.png" }],
      mentions: [{ kind: "user", userId: ctx.bob.id }],
      turnId: "t-1",
    });
    assert.equal(m.turn_id, "t-1");
    const parsed = JSON.parse(m.attachments_json);
    assert.equal(parsed[0].kind, "image");
    const ments = JSON.parse(m.mentions_json);
    assert.equal(ments[0].userId, ctx.bob.id);
  } finally { teardown(ctx); }
});

test("updateMessageStatus transitions streaming -> complete", () => {
  const ctx = setup();
  try {
    const m = ctx.messages.appendMessage({ roomId: "r-msg", senderKind: "fellow", senderRef: "codex", senderOwnerId: ctx.alice.id, bodyMd: "...", status: "streaming" });
    ctx.messages.updateMessageStatus(m.id, "complete");
    const fetched = ctx.messages.getMessage(m.id);
    assert.equal(fetched.status, "complete");
  } finally { teardown(ctx); }
});
```

- [ ] **Step 2: Run, fail**

```bash
node --test tests/cloud-messages-store.test.js
```

Expected: FAIL (no module).

- [ ] **Step 3: Implement `src/cloud/messages-store.js`**

```js
const crypto = require("node:crypto");

function nowIso() {
  return new Date().toISOString();
}

function randomId(prefix) {
  return prefix + "_" + crypto.randomBytes(8).toString("hex");
}

function createMessagesStore(db) {
  const selectMaxSeq = db.prepare(
    "SELECT COALESCE(MAX(seq), 0) AS max_seq FROM messages WHERE room_id = ?"
  );
  const insertMessage = db.prepare(`
    INSERT INTO messages (
      id, room_id, seq, turn_id, sender_kind, sender_ref, sender_owner_id,
      body_md, attachments_json, mentions_json, status, error_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const selectMessage = db.prepare("SELECT * FROM messages WHERE id = ?");
  const selectSince = db.prepare(`
    SELECT * FROM messages WHERE room_id = ? AND seq > ?
    ORDER BY seq ASC LIMIT ?
  `);
  const updateStatus = db.prepare(
    "UPDATE messages SET status = ?, error_json = COALESCE(?, error_json) WHERE id = ?"
  );

  function appendMessage(args) {
    const {
      roomId,
      senderKind,
      senderRef,
      senderOwnerId = null,
      bodyMd = "",
      attachments = null,
      mentions = null,
      turnId = null,
      status = "complete",
      errorJson = null,
    } = args;
    const id = randomId("m");
    const createdAt = nowIso();
    const tx = db.transaction(() => {
      const seq = selectMaxSeq.get(String(roomId)).max_seq + 1;
      insertMessage.run(
        id,
        String(roomId),
        seq,
        turnId,
        String(senderKind),
        String(senderRef),
        senderOwnerId ? String(senderOwnerId) : null,
        String(bodyMd),
        attachments ? JSON.stringify(attachments) : null,
        mentions ? JSON.stringify(mentions) : null,
        String(status),
        errorJson ? JSON.stringify(errorJson) : null,
        createdAt
      );
      return seq;
    });
    const seq = tx();
    return selectMessage.get(id);
  }

  function getMessage(id) {
    return selectMessage.get(String(id)) || null;
  }

  function listMessagesSince(roomId, sinceSeq, limit = 100) {
    const cap = Math.min(Math.max(Number(limit) || 100, 1), 500);
    return selectSince.all(String(roomId), Number(sinceSeq) || 0, cap);
  }

  function updateMessageStatus(id, status, errorJson = null) {
    updateStatus.run(String(status), errorJson ? JSON.stringify(errorJson) : null, String(id));
  }

  return { appendMessage, getMessage, listMessagesSince, updateMessageStatus };
}

module.exports = { createMessagesStore };
```

- [ ] **Step 4: Run, pass**

```bash
node --test tests/cloud-messages-store.test.js
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/cloud/messages-store.js tests/cloud-messages-store.test.js
git commit -m "feat(cloud): messages-store with per-room seq allocator"
```

---

### Task 5: dm-room.js — DM room id helper + ensureDmRoom

**Files:**
- Create: `src/cloud/dm-room.js`
- Test: `tests/cloud-dm-room.test.js`

**Helpers to export:**
- `dmRoomId(userA, userB)` — returns `"dm:<smaller>:<larger>"`
- `ensureDmRoom(socialStore, userA, userB)` — atomic: if friendship exists and DM room doesn't, create room + add two members; returns the room object (existing or freshly created)

- [ ] **Step 1: Failing tests**

`tests/cloud-dm-room.test.js`:

```js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createCloudStore } = require("../src/cloud/sqlite-store.js");
const { createSocialStore } = require("../src/cloud/social-store.js");
const { dmRoomId, ensureDmRoom } = require("../src/cloud/dm-room.js");

test("dmRoomId is sorted and deterministic regardless of arg order", () => {
  assert.equal(dmRoomId("u_b", "u_a"), "dm:u_a:u_b");
  assert.equal(dmRoomId("u_a", "u_b"), "dm:u_a:u_b");
  assert.equal(dmRoomId("u_xyz", "u_abc"), "dm:u_abc:u_xyz");
});

test("dmRoomId throws on identical user ids", () => {
  assert.throws(() => dmRoomId("u_a", "u_a"), /same user/i);
});

test("ensureDmRoom creates room and adds two members on first call", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-dm-test-"));
  const cloudStore = createCloudStore({ dataDir: tmpDir });
  try {
    const social = createSocialStore(cloudStore.getDb());
    const alice = cloudStore.registerUser({ username: "alice", password: "Pa55word!" });
    const bob = cloudStore.registerUser({ username: "bob", password: "Pa55word!" });
    social.addFriendship(alice.id, bob.id);
    const room = ensureDmRoom(social, alice.id, bob.id);
    assert.equal(room.id, dmRoomId(alice.id, bob.id));
    const members = social.listRoomMembers(room.id);
    const refs = members.map((m) => m.member_ref).sort();
    assert.deepEqual(refs, [alice.id, bob.id].sort());
    for (const m of members) {
      assert.equal(m.member_kind, "user");
    }
  } finally {
    cloudStore.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("ensureDmRoom returns existing room on second call (idempotent)", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-dm-test2-"));
  const cloudStore = createCloudStore({ dataDir: tmpDir });
  try {
    const social = createSocialStore(cloudStore.getDb());
    const alice = cloudStore.registerUser({ username: "alice", password: "Pa55word!" });
    const bob = cloudStore.registerUser({ username: "bob", password: "Pa55word!" });
    social.addFriendship(alice.id, bob.id);
    const first = ensureDmRoom(social, alice.id, bob.id);
    const second = ensureDmRoom(social, alice.id, bob.id);
    assert.equal(first.id, second.id);
    assert.equal(social.listRoomMembers(first.id).length, 2);
  } finally {
    cloudStore.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("ensureDmRoom rejects non-friends", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-dm-test3-"));
  const cloudStore = createCloudStore({ dataDir: tmpDir });
  try {
    const social = createSocialStore(cloudStore.getDb());
    const alice = cloudStore.registerUser({ username: "alice", password: "Pa55word!" });
    const stranger = cloudStore.registerUser({ username: "stranger", password: "Pa55word!" });
    assert.throws(() => ensureDmRoom(social, alice.id, stranger.id), /not friends/i);
  } finally {
    cloudStore.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run, fail**

```bash
node --test tests/cloud-dm-room.test.js
```

Expected: FAIL (module missing).

- [ ] **Step 3: Implement `src/cloud/dm-room.js`**

```js
function dmRoomId(userA, userB) {
  const a = String(userA);
  const b = String(userB);
  if (a === b) throw new Error("DM requires two different users (got same user id)");
  return "dm:" + (a < b ? a + ":" + b : b + ":" + a);
}

function ensureDmRoom(socialStore, userA, userB) {
  if (!socialStore.areFriends(userA, userB)) {
    throw new Error("users are not friends — cannot create DM room");
  }
  const id = dmRoomId(userA, userB);
  const existing = socialStore.getRoom(id);
  if (existing) return existing;
  const room = socialStore.createRoom({
    id,
    name: null,
    avatar: null,
    hostMember: null,
    decorations: null,
    contextCard: null,
  });
  socialStore.addRoomMember({ roomId: id, memberKind: "user", memberRef: String(userA), ownerId: null });
  socialStore.addRoomMember({ roomId: id, memberKind: "user", memberRef: String(userB), ownerId: null });
  return room;
}

module.exports = { dmRoomId, ensureDmRoom };
```

- [ ] **Step 4: Run, pass**

```bash
node --test tests/cloud-dm-room.test.js
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/cloud/dm-room.js tests/cloud-dm-room.test.js
git commit -m "feat(cloud): dm-room helper + ensureDmRoom (friendship-gated)"
```

---

### Task 6: HTTP endpoints — invite codes

**Files:**
- Modify: `scripts/serve-cloud.js` (initialize social store + add `/api/social/invite-codes` routes)
- Test: `tests/cloud-social-api.test.js` (new — boots the server in-process)

**Endpoints to add:**
- `POST /api/social/invite-codes` — generate a new invite code (24h expiry; code is 8-char base32). Body: `{}`. Returns `{ id, code, expiresAt }`.
- `POST /api/social/invite-codes/:code/accept` — accept a pending invite. Returns `{ friend: <user>, room: <dm room> }` (eagerly creates the DM room). Emits `social.friend_added` event to BOTH users.
- `DELETE /api/social/invite-codes/:code` — revoke (only by owner). Returns `{ ok: true }`.
- `GET /api/social/invite-codes` — list current user's own pending invite codes.

Code generation: 8 chars from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (no ambiguous chars).

- [ ] **Step 1: Failing tests**

`tests/cloud-social-api.test.js`:

```js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");

function startServer() {
  return new Promise((resolve, reject) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-api-test-"));
    const port = 4000 + Math.floor(Math.random() * 1000);
    const proc = spawn(process.execPath, ["scripts/serve-cloud.js"], {
      env: {
        ...process.env,
        MIA_CLOUD_HOST: "127.0.0.1",
        MIA_CLOUD_PORT: String(port),
        MIA_CLOUD_DATA: tmpDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let resolved = false;
    proc.stderr.on("data", (chunk) => {
      const s = chunk.toString();
      if (s.includes("listening") || s.includes("Listening") || s.includes("mia-cloud")) {
        if (!resolved) { resolved = true; resolve({ proc, port, tmpDir }); }
      }
    });
    proc.stdout.on("data", (chunk) => {
      const s = chunk.toString();
      if (s.includes("listening") || s.includes("Listening")) {
        if (!resolved) { resolved = true; resolve({ proc, port, tmpDir }); }
      }
    });
    proc.on("error", reject);
    setTimeout(() => { if (!resolved) { resolved = true; resolve({ proc, port, tmpDir }); } }, 1500);
  });
}

async function stopServer(ctx) {
  ctx.proc.kill("SIGTERM");
  await new Promise((r) => ctx.proc.on("exit", r));
  fs.rmSync(ctx.tmpDir, { recursive: true, force: true });
}

function api(port, method, pathStr, { body, token } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: "127.0.0.1", port, path: pathStr, method,
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: "Bearer " + token } : {}),
      },
    }, (res) => {
      let chunks = "";
      res.on("data", (c) => { chunks += c; });
      res.on("end", () => {
        let parsed = null;
        try { parsed = JSON.parse(chunks); } catch { parsed = chunks; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

async function register(port, username) {
  const r = await api(port, "POST", "/api/auth/register", { body: { username, password: "Pa55word!" } });
  if (r.status !== 201) throw new Error("register failed: " + JSON.stringify(r));
  const login = await api(port, "POST", "/api/auth/login", { body: { username, password: "Pa55word!" } });
  return { user: r.body, token: login.body.token };
}

test("POST /api/social/invite-codes generates pending code", async () => {
  const ctx = await startServer();
  try {
    const alice = await register(ctx.port, "alice");
    const r = await api(ctx.port, "POST", "/api/social/invite-codes", { token: alice.token, body: {} });
    assert.equal(r.status, 201);
    assert.ok(r.body.code);
    assert.equal(r.body.code.length, 8);
    assert.ok(r.body.expiresAt);
  } finally { await stopServer(ctx); }
});

test("accept invite creates friendship + DM room + returns both", async () => {
  const ctx = await startServer();
  try {
    const alice = await register(ctx.port, "alice");
    const bob = await register(ctx.port, "bob");
    const created = await api(ctx.port, "POST", "/api/social/invite-codes", { token: alice.token, body: {} });
    const accept = await api(ctx.port, "POST", "/api/social/invite-codes/" + created.body.code + "/accept", { token: bob.token, body: {} });
    assert.equal(accept.status, 200);
    assert.equal(accept.body.friend.id, alice.user.id);
    assert.ok(accept.body.room.id.startsWith("dm:"));
  } finally { await stopServer(ctx); }
});

test("accept same code twice → 409 already consumed", async () => {
  const ctx = await startServer();
  try {
    const alice = await register(ctx.port, "alice");
    const bob = await register(ctx.port, "bob");
    const charlie = await register(ctx.port, "charlie");
    const created = await api(ctx.port, "POST", "/api/social/invite-codes", { token: alice.token, body: {} });
    await api(ctx.port, "POST", "/api/social/invite-codes/" + created.body.code + "/accept", { token: bob.token, body: {} });
    const second = await api(ctx.port, "POST", "/api/social/invite-codes/" + created.body.code + "/accept", { token: charlie.token, body: {} });
    assert.equal(second.status, 409);
  } finally { await stopServer(ctx); }
});

test("DELETE invite-codes/:code by owner marks expired", async () => {
  const ctx = await startServer();
  try {
    const alice = await register(ctx.port, "alice");
    const bob = await register(ctx.port, "bob");
    const created = await api(ctx.port, "POST", "/api/social/invite-codes", { token: alice.token, body: {} });
    const del = await api(ctx.port, "DELETE", "/api/social/invite-codes/" + created.body.code, { token: alice.token });
    assert.equal(del.status, 200);
    const accept = await api(ctx.port, "POST", "/api/social/invite-codes/" + created.body.code + "/accept", { token: bob.token, body: {} });
    assert.notEqual(accept.status, 200);
  } finally { await stopServer(ctx); }
});

test("self-accept invite is rejected", async () => {
  const ctx = await startServer();
  try {
    const alice = await register(ctx.port, "alice");
    const created = await api(ctx.port, "POST", "/api/social/invite-codes", { token: alice.token, body: {} });
    const accept = await api(ctx.port, "POST", "/api/social/invite-codes/" + created.body.code + "/accept", { token: alice.token, body: {} });
    assert.equal(accept.status, 400);
  } finally { await stopServer(ctx); }
});
```

- [ ] **Step 2: Run, fail**

```bash
node --test tests/cloud-social-api.test.js
```

Expected: requests return 404 (routes not defined).

- [ ] **Step 3: Wire routes into `scripts/serve-cloud.js`**

Near the top of `scripts/serve-cloud.js`, in the imports section (where `createCloudStore` is required), add:

```js
const { createSocialStore } = require("../src/cloud/social-store.js");
const { createMessagesStore } = require("../src/cloud/messages-store.js");
const { dmRoomId, ensureDmRoom } = require("../src/cloud/dm-room.js");
```

In the `main()` / startup region, find where `cloudStore = createCloudStore(...)` is called. Right after that, add:

```js
const socialStore = createSocialStore(cloudStore.getDb());
const messagesStore = createMessagesStore(cloudStore.getDb());
```

Then add these to the `context` object passed to `handleRequest`:

```js
const context = {
  // ... existing fields
  socialStore,
  messagesStore,
};
```

Add a helper near the top of the file (somewhere after the other utility functions):

```js
const INVITE_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const INVITE_CODE_TTL_MS = 24 * 60 * 60 * 1000;

function generateInviteCode() {
  let out = "";
  for (let i = 0; i < 8; i++) {
    out += INVITE_CODE_ALPHABET[crypto.randomInt(INVITE_CODE_ALPHABET.length)];
  }
  return out;
}
```

In `handleRequest`, **after** the auth check (`if (!auth) return writeError(res, 401, ...)`) and before the existing `/api/workspace` block (or anywhere logical in the authenticated-route section), add:

```js
if (req.method === "POST" && url.pathname === "/api/social/invite-codes") {
  let code;
  for (let attempt = 0; attempt < 5; attempt++) {
    code = generateInviteCode();
    if (!context.socialStore.getFriendRequestByCode(code)) break;
    code = null;
  }
  if (!code) return writeError(res, 500, "could not generate unique invite code");
  const created = context.socialStore.createFriendRequest({ fromUser: auth.user.id, code });
  const expiresAt = new Date(new Date(created.created_at).getTime() + INVITE_CODE_TTL_MS).toISOString();
  return writeJson(res, 201, { id: created.id, code: created.code, expiresAt });
}

const inviteMatch = url.pathname.match(/^\/api\/social\/invite-codes\/([A-Z0-9]+)(\/accept)?$/);
if (req.method === "POST" && inviteMatch && inviteMatch[2] === "/accept") {
  const code = inviteMatch[1];
  const row = context.socialStore.getFriendRequestByCode(code);
  if (!row) return writeError(res, 404, "invite code not found");
  if (row.status !== "pending") return writeError(res, 409, "invite code already " + row.status);
  if (row.from_user === auth.user.id) return writeError(res, 400, "cannot accept your own invite");
  const createdAtMs = new Date(row.created_at).getTime();
  if (Date.now() - createdAtMs > INVITE_CODE_TTL_MS) {
    context.socialStore.revokeFriendRequest(code, row.from_user);
    return writeError(res, 410, "invite code expired");
  }
  try {
    context.socialStore.acceptFriendRequest(code, auth.user.id);
  } catch (e) {
    return writeError(res, 400, e.message);
  }
  const room = ensureDmRoom(context.socialStore, row.from_user, auth.user.id);
  const friend = context.cloudStore.getUserPublic ? context.cloudStore.getUserPublic(row.from_user) : { id: row.from_user };
  // emit events (Task 9 will wire actual broadcast — for now no-op safely)
  broadcastEvent(context.eventHub, row.from_user, { type: "social.friend_added", friend: { id: auth.user.id }, room });
  broadcastEvent(context.eventHub, auth.user.id, { type: "social.friend_added", friend, room });
  return writeJson(res, 200, { friend, room });
}

if (req.method === "DELETE" && inviteMatch && !inviteMatch[2]) {
  const code = inviteMatch[1];
  try {
    context.socialStore.revokeFriendRequest(code, auth.user.id);
    return writeJson(res, 200, { ok: true });
  } catch (e) {
    return writeError(res, 400, e.message);
  }
}

if (req.method === "GET" && url.pathname === "/api/social/invite-codes") {
  const db = context.cloudStore.getDb();
  const rows = db.prepare(
    "SELECT id, code, status, created_at FROM friend_requests WHERE from_user = ? AND status = 'pending' ORDER BY created_at DESC"
  ).all(auth.user.id);
  return writeJson(res, 200, { invites: rows });
}
```

Note: `getUserPublic` is a small helper — add it to `sqlite-store.js`'s returned object if it doesn't exist:

In `createCloudStore` near the existing `return { ... }`, add this helper:

```js
function getUserPublic(userId) {
  const row = getUserById(userId);
  return row ? publicUser(row) : null;
}
```

And add `getUserPublic` to the return list.

- [ ] **Step 4: Run, pass**

```bash
node --test tests/cloud-social-api.test.js
```

Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/serve-cloud.js src/cloud/sqlite-store.js tests/cloud-social-api.test.js
git commit -m "feat(cloud): /api/social/invite-codes endpoints (create/accept/revoke/list)"
```

---

### Task 7: HTTP endpoints — friends list + unfriend

**Files:**
- Modify: `scripts/serve-cloud.js` (add 2 routes)
- Modify: `tests/cloud-social-api.test.js` (add tests)

**Endpoints:**
- `GET /api/social/friends` — returns `{ friends: [<publicUser>...] }`
- `DELETE /api/social/friends/:userId` — removes friendship. Does NOT cascade-delete DM rooms (per spec §13). Returns `{ ok: true }`.

- [ ] **Step 1: Failing tests**

Append to `tests/cloud-social-api.test.js`:

```js
test("GET /api/social/friends lists accepted friends", async () => {
  const ctx = await startServer();
  try {
    const alice = await register(ctx.port, "alice");
    const bob = await register(ctx.port, "bob");
    const created = await api(ctx.port, "POST", "/api/social/invite-codes", { token: alice.token, body: {} });
    await api(ctx.port, "POST", "/api/social/invite-codes/" + created.body.code + "/accept", { token: bob.token, body: {} });
    const aliceList = await api(ctx.port, "GET", "/api/social/friends", { token: alice.token });
    assert.equal(aliceList.status, 200);
    assert.equal(aliceList.body.friends.length, 1);
    assert.equal(aliceList.body.friends[0].id, bob.user.id);
    const bobList = await api(ctx.port, "GET", "/api/social/friends", { token: bob.token });
    assert.equal(bobList.body.friends[0].id, alice.user.id);
  } finally { await stopServer(ctx); }
});

test("DELETE /api/social/friends/:userId removes friendship but keeps DM room", async () => {
  const ctx = await startServer();
  try {
    const alice = await register(ctx.port, "alice");
    const bob = await register(ctx.port, "bob");
    const created = await api(ctx.port, "POST", "/api/social/invite-codes", { token: alice.token, body: {} });
    const accepted = await api(ctx.port, "POST", "/api/social/invite-codes/" + created.body.code + "/accept", { token: bob.token, body: {} });
    const roomId = accepted.body.room.id;
    const del = await api(ctx.port, "DELETE", "/api/social/friends/" + bob.user.id, { token: alice.token });
    assert.equal(del.status, 200);
    const aliceList = await api(ctx.port, "GET", "/api/social/friends", { token: alice.token });
    assert.equal(aliceList.body.friends.length, 0);
    // DM room itself is not auto-deleted — but we won't query it here directly until Task 8
  } finally { await stopServer(ctx); }
});
```

- [ ] **Step 2: Run, fail**

```bash
node --test tests/cloud-social-api.test.js
```

Expected: new tests FAIL (404).

- [ ] **Step 3: Add routes in `handleRequest`**

Right after the invite-codes block, add:

```js
if (req.method === "GET" && url.pathname === "/api/social/friends") {
  const friendIds = context.socialStore.listFriends(auth.user.id);
  const friends = friendIds
    .map((id) => context.cloudStore.getUserPublic(id))
    .filter(Boolean);
  return writeJson(res, 200, { friends });
}

const unfriendMatch = url.pathname.match(/^\/api\/social\/friends\/([a-zA-Z0-9_-]+)$/);
if (req.method === "DELETE" && unfriendMatch) {
  context.socialStore.removeFriendship(auth.user.id, unfriendMatch[1]);
  return writeJson(res, 200, { ok: true });
}
```

- [ ] **Step 4: Run, pass**

```bash
node --test tests/cloud-social-api.test.js
```

Expected: all tests in the file pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/serve-cloud.js tests/cloud-social-api.test.js
git commit -m "feat(cloud): /api/social/friends list + unfriend"
```

---

### Task 8: HTTP endpoints — room messages (POST send + GET since_seq) + room detail

**Files:**
- Modify: `scripts/serve-cloud.js`
- Modify: `tests/cloud-social-api.test.js`

**Endpoints:**
- `POST /api/rooms/:id/messages` — body `{ tempId?, bodyMd, attachments?, mentions?, turnId? }`. Caller MUST be a member of the room (or in the DM case, MUST be one of the two users in the id). Returns the saved message including assigned `seq` and `id`. Emits `room.message_appended` event to all room members.
- `GET /api/rooms/:id/messages?since_seq=N&limit=100` — returns `{ messages: [...] }` with `seq > N` ascending. Caller MUST be a room member.
- `GET /api/rooms/:id` — returns `{ room, members }`. Caller MUST be a room member.
- `GET /api/rooms` — returns `{ rooms: [...] }` for current user.

DM auto-creation: `POST /api/rooms/:id/messages` for a non-existent `dm:userA:userB` room MUST verify the caller is one of those users AND that they are friends with the other, then call `ensureDmRoom` before appending. This is the only way DM rooms get created in this phase (no explicit "start DM" endpoint).

- [ ] **Step 1: Failing tests**

Append to `tests/cloud-social-api.test.js`:

```js
async function friendUp(port, a, b) {
  const created = await api(port, "POST", "/api/social/invite-codes", { token: a.token, body: {} });
  const accepted = await api(port, "POST", "/api/social/invite-codes/" + created.body.code + "/accept", { token: b.token, body: {} });
  return accepted.body.room;
}

test("POST /api/rooms/:id/messages sends to DM room, server assigns seq", async () => {
  const ctx = await startServer();
  try {
    const alice = await register(ctx.port, "alice");
    const bob = await register(ctx.port, "bob");
    const room = await friendUp(ctx.port, alice, bob);
    const m1 = await api(ctx.port, "POST", "/api/rooms/" + room.id + "/messages", {
      token: alice.token, body: { bodyMd: "hi bob" }
    });
    assert.equal(m1.status, 201);
    assert.equal(m1.body.message.seq, 1);
    assert.equal(m1.body.message.sender_ref, alice.user.id);
    const m2 = await api(ctx.port, "POST", "/api/rooms/" + room.id + "/messages", {
      token: bob.token, body: { bodyMd: "sup" }
    });
    assert.equal(m2.body.message.seq, 2);
  } finally { await stopServer(ctx); }
});

test("GET /api/rooms/:id/messages?since_seq=N returns incremental", async () => {
  const ctx = await startServer();
  try {
    const alice = await register(ctx.port, "alice");
    const bob = await register(ctx.port, "bob");
    const room = await friendUp(ctx.port, alice, bob);
    for (let i = 1; i <= 5; i++) {
      await api(ctx.port, "POST", "/api/rooms/" + room.id + "/messages", { token: alice.token, body: { bodyMd: "m" + i } });
    }
    const r = await api(ctx.port, "GET", "/api/rooms/" + room.id + "/messages?since_seq=2", { token: bob.token });
    assert.equal(r.status, 200);
    assert.equal(r.body.messages.length, 3);
    assert.deepEqual(r.body.messages.map((m) => m.seq), [3, 4, 5]);
  } finally { await stopServer(ctx); }
});

test("POST to room user is not member of returns 403", async () => {
  const ctx = await startServer();
  try {
    const alice = await register(ctx.port, "alice");
    const bob = await register(ctx.port, "bob");
    const charlie = await register(ctx.port, "charlie");
    const room = await friendUp(ctx.port, alice, bob);
    const r = await api(ctx.port, "POST", "/api/rooms/" + room.id + "/messages", { token: charlie.token, body: { bodyMd: "intruder" } });
    assert.equal(r.status, 403);
  } finally { await stopServer(ctx); }
});

test("POST to DM room id derives membership from friendship even before explicit room", async () => {
  const ctx = await startServer();
  try {
    const alice = await register(ctx.port, "alice");
    const bob = await register(ctx.port, "bob");
    // Don't friend up yet — try to send without friendship
    const dmId = "dm:" + [alice.user.id, bob.user.id].sort().join(":");
    const r1 = await api(ctx.port, "POST", "/api/rooms/" + dmId + "/messages", { token: alice.token, body: { bodyMd: "hi" } });
    assert.equal(r1.status, 403, "non-friends cannot start DM");

    await friendUp(ctx.port, alice, bob);
    const r2 = await api(ctx.port, "POST", "/api/rooms/" + dmId + "/messages", { token: alice.token, body: { bodyMd: "hi friend" } });
    assert.equal(r2.status, 201);
  } finally { await stopServer(ctx); }
});

test("GET /api/rooms lists current user's rooms", async () => {
  const ctx = await startServer();
  try {
    const alice = await register(ctx.port, "alice");
    const bob = await register(ctx.port, "bob");
    await friendUp(ctx.port, alice, bob);
    const list = await api(ctx.port, "GET", "/api/rooms", { token: alice.token });
    assert.equal(list.status, 200);
    assert.equal(list.body.rooms.length, 1);
    assert.ok(list.body.rooms[0].id.startsWith("dm:"));
  } finally { await stopServer(ctx); }
});

test("GET /api/rooms/:id returns room + members", async () => {
  const ctx = await startServer();
  try {
    const alice = await register(ctx.port, "alice");
    const bob = await register(ctx.port, "bob");
    const room = await friendUp(ctx.port, alice, bob);
    const r = await api(ctx.port, "GET", "/api/rooms/" + room.id, { token: alice.token });
    assert.equal(r.status, 200);
    assert.equal(r.body.room.id, room.id);
    assert.equal(r.body.members.length, 2);
  } finally { await stopServer(ctx); }
});
```

- [ ] **Step 2: Run, fail**

```bash
node --test tests/cloud-social-api.test.js
```

Expected: new tests FAIL (404).

- [ ] **Step 3: Implement helper + routes**

Add a helper near the top of `scripts/serve-cloud.js`:

```js
function userIsMemberOfRoom(socialStore, roomId, userId) {
  if (roomId.startsWith("dm:")) {
    const parts = roomId.split(":");
    if (parts.length !== 3) return false;
    const [_, a, b] = parts;
    if (userId !== a && userId !== b) return false;
    const other = userId === a ? b : a;
    return socialStore.areFriends(userId, other);
  }
  return socialStore.listRoomMembers(roomId).some(
    (m) => m.member_kind === "user" && m.member_ref === userId
  );
}
```

In `handleRequest`, after the friends routes block, add:

```js
if (req.method === "GET" && url.pathname === "/api/rooms") {
  const rooms = context.socialStore.listRoomsForUser(auth.user.id);
  return writeJson(res, 200, { rooms });
}

const roomDetailMatch = url.pathname.match(/^\/api\/rooms\/([A-Za-z0-9_:-]+)$/);
if (req.method === "GET" && roomDetailMatch) {
  const roomId = roomDetailMatch[1];
  if (!userIsMemberOfRoom(context.socialStore, roomId, auth.user.id)) {
    return writeError(res, 403, "not a member of this room");
  }
  const room = context.socialStore.getRoom(roomId);
  if (!room) return writeError(res, 404, "room not found");
  const members = context.socialStore.listRoomMembers(roomId);
  return writeJson(res, 200, { room, members });
}

const roomMsgsMatch = url.pathname.match(/^\/api\/rooms\/([A-Za-z0-9_:-]+)\/messages$/);
if (req.method === "GET" && roomMsgsMatch) {
  const roomId = roomMsgsMatch[1];
  if (!userIsMemberOfRoom(context.socialStore, roomId, auth.user.id)) {
    return writeError(res, 403, "not a member of this room");
  }
  const sinceSeq = Number(url.searchParams.get("since_seq") || 0);
  const limit = Number(url.searchParams.get("limit") || 100);
  const messages = context.messagesStore.listMessagesSince(roomId, sinceSeq, limit);
  return writeJson(res, 200, { messages });
}

if (req.method === "POST" && roomMsgsMatch) {
  const roomId = roomMsgsMatch[1];
  if (!userIsMemberOfRoom(context.socialStore, roomId, auth.user.id)) {
    return writeError(res, 403, "not a member of this room");
  }
  const body = await readJson(req);
  // For DM rooms, ensure the room exists (lazy creation per spec)
  if (roomId.startsWith("dm:") && !context.socialStore.getRoom(roomId)) {
    const parts = roomId.split(":");
    const [_, a, b] = parts;
    const other = auth.user.id === a ? b : a;
    ensureDmRoom(context.socialStore, auth.user.id, other);
  }
  const message = context.messagesStore.appendMessage({
    roomId,
    senderKind: "user",
    senderRef: auth.user.id,
    bodyMd: body.bodyMd || "",
    attachments: body.attachments || null,
    mentions: body.mentions || null,
    turnId: body.turnId || null,
    status: "complete",
  });
  // broadcast to all room members
  for (const m of context.socialStore.listRoomMembers(roomId)) {
    if (m.member_kind === "user") {
      broadcastEvent(context.eventHub, m.member_ref, { type: "room.message_appended", roomId, message });
    }
  }
  return writeJson(res, 201, { message });
}
```

- [ ] **Step 4: Run, pass**

```bash
node --test tests/cloud-social-api.test.js
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/serve-cloud.js tests/cloud-social-api.test.js
git commit -m "feat(cloud): /api/rooms endpoints (list, detail, messages POST/GET since_seq)"
```

---

### Task 9: WS event integration test — verify events flow end-to-end

**Files:**
- Modify: `tests/cloud-social-api.test.js` (add WS-based tests)

**Goal:** Verify that:
- After `accept invite`, BOTH users receive `social.friend_added` event on their WS connection
- After `POST /messages`, all room members receive `room.message_appended` event with the message body and seq

Events go through existing `broadcastEvent(context.eventHub, userId, payload)`. Routes already emit them (Tasks 6, 8). This task is purely test coverage.

WS endpoint (verified by reading `scripts/serve-cloud.js:820-844`):
- Path: `/api/events`
- Auth (production): subprotocol header `Sec-WebSocket-Protocol: mia-token.<token>` parsed by `tokenFromWebSocketProtocol(req)` (`serve-cloud.js:488`)
- Auth (test-only fallback): `?token=<token>` query param, **but only when env `MIA_CLOUD_ALLOW_QUERY_TOKEN=1`** (see `serve-cloud.js:834` — `context.allowQueryTokenAuth`)

For these tests, use the subprotocol method (matches production), no env tweak needed. `ws` npm package accepts subprotocols as the second arg to the constructor.

- [ ] **Step 1: Write helper to open WS + collect events**

In `tests/cloud-social-api.test.js`, add near the top:

```js
const WebSocket = require("ws");

function openEventsWs(port, token) {
  const ws = new WebSocket(
    "ws://127.0.0.1:" + port + "/api/events",
    ["mia-token." + token]
  );
  const events = [];
  ws.on("message", (data) => {
    try { events.push(JSON.parse(data.toString())); } catch { /* ignore */ }
  });
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve({ ws, events }));
    ws.once("error", reject);
  });
}

async function waitForEvent(events, predicate, timeoutMs = 1500) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const found = events.find(predicate);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error("event not received within " + timeoutMs + "ms; got: " + JSON.stringify(events));
}
```

- [ ] **Step 2: Add WS tests**

```js
test("accept invite emits social.friend_added to both users", async () => {
  const ctx = await startServer();
  try {
    const alice = await register(ctx.port, "alice");
    const bob = await register(ctx.port, "bob");
    const aliceWs = await openEventsWs(ctx.port, alice.token);
    const bobWs = await openEventsWs(ctx.port, bob.token);
    try {
      const created = await api(ctx.port, "POST", "/api/social/invite-codes", { token: alice.token, body: {} });
      await api(ctx.port, "POST", "/api/social/invite-codes/" + created.body.code + "/accept", { token: bob.token, body: {} });
      const ae = await waitForEvent(aliceWs.events, (e) => e.type === "social.friend_added");
      const be = await waitForEvent(bobWs.events, (e) => e.type === "social.friend_added");
      assert.equal(ae.friend.id, bob.user.id);
      assert.equal(be.friend.id, alice.user.id);
      assert.ok(ae.room.id.startsWith("dm:"));
    } finally {
      aliceWs.ws.close();
      bobWs.ws.close();
    }
  } finally { await stopServer(ctx); }
});

test("post DM message emits room.message_appended to both members", async () => {
  const ctx = await startServer();
  try {
    const alice = await register(ctx.port, "alice");
    const bob = await register(ctx.port, "bob");
    await friendUp(ctx.port, alice, bob);
    const aliceWs = await openEventsWs(ctx.port, alice.token);
    const bobWs = await openEventsWs(ctx.port, bob.token);
    try {
      const dmId = "dm:" + [alice.user.id, bob.user.id].sort().join(":");
      await api(ctx.port, "POST", "/api/rooms/" + dmId + "/messages", { token: alice.token, body: { bodyMd: "boo" } });
      const ae = await waitForEvent(aliceWs.events, (e) => e.type === "room.message_appended");
      const be = await waitForEvent(bobWs.events, (e) => e.type === "room.message_appended");
      assert.equal(ae.message.seq, 1);
      assert.equal(ae.message.body_md, "boo");
      assert.equal(be.message.body_md, "boo");
    } finally {
      aliceWs.ws.close();
      bobWs.ws.close();
    }
  } finally { await stopServer(ctx); }
});
```

- [ ] **Step 3: Run**

```bash
node --test tests/cloud-social-api.test.js
```

Expected: WS tests pass.

- [ ] **Step 4: Commit**

```bash
git add tests/cloud-social-api.test.js
git commit -m "test(cloud): WS event integration tests for social.friend_added + room.message_appended"
```

---

### Task 10: End-to-end scenario + grep self-check + commit

**Files:**
- Modify: `tests/cloud-social-api.test.js` (one scenario test)
- Inspection only: grep + size check

- [ ] **Step 1: Write end-to-end scenario test**

Append to `tests/cloud-social-api.test.js`:

```js
test("end-to-end: two users meet, friend up, exchange DM messages with seq", async () => {
  const ctx = await startServer();
  try {
    const alice = await register(ctx.port, "alice");
    const bob = await register(ctx.port, "bob");

    // Alice creates invite
    const invite = await api(ctx.port, "POST", "/api/social/invite-codes", { token: alice.token, body: {} });
    assert.equal(invite.status, 201);

    // Bob accepts
    const accepted = await api(ctx.port, "POST", "/api/social/invite-codes/" + invite.body.code + "/accept", { token: bob.token, body: {} });
    assert.equal(accepted.status, 200);
    const roomId = accepted.body.room.id;

    // Both list each other as friend
    const aFriends = await api(ctx.port, "GET", "/api/social/friends", { token: alice.token });
    assert.equal(aFriends.body.friends.length, 1);

    // Both list the new DM room
    const aRooms = await api(ctx.port, "GET", "/api/rooms", { token: alice.token });
    assert.equal(aRooms.body.rooms.length, 1);
    assert.equal(aRooms.body.rooms[0].id, roomId);

    // Exchange messages
    const m1 = await api(ctx.port, "POST", "/api/rooms/" + roomId + "/messages", { token: alice.token, body: { bodyMd: "hi bob" } });
    const m2 = await api(ctx.port, "POST", "/api/rooms/" + roomId + "/messages", { token: bob.token, body: { bodyMd: "hey alice" } });
    const m3 = await api(ctx.port, "POST", "/api/rooms/" + roomId + "/messages", { token: alice.token, body: { bodyMd: "tomorrow at 9?" } });
    assert.deepEqual([m1.body.message.seq, m2.body.message.seq, m3.body.message.seq], [1, 2, 3]);

    // Bob fetches since_seq=0
    const all = await api(ctx.port, "GET", "/api/rooms/" + roomId + "/messages?since_seq=0", { token: bob.token });
    assert.equal(all.body.messages.length, 3);
    assert.deepEqual(all.body.messages.map((m) => m.body_md), ["hi bob", "hey alice", "tomorrow at 9?"]);

    // Bob simulates partial sync: since_seq=1 returns only m2 and m3
    const partial = await api(ctx.port, "GET", "/api/rooms/" + roomId + "/messages?since_seq=1", { token: bob.token });
    assert.equal(partial.body.messages.length, 2);
    assert.deepEqual(partial.body.messages.map((m) => m.seq), [2, 3]);
  } finally { await stopServer(ctx); }
});
```

- [ ] **Step 2: Run full social test suite**

```bash
node --test tests/cloud-sqlite-store.test.js tests/cloud-social-store.test.js tests/cloud-messages-store.test.js tests/cloud-dm-room.test.js tests/cloud-social-api.test.js
```

Expected: all tests pass.

- [ ] **Step 3: Grep self-check + file size audit**

```bash
wc -l src/cloud/social-store.js src/cloud/messages-store.js src/cloud/dm-room.js src/cloud/sqlite-store.js scripts/serve-cloud.js
```

Expected (approximate targets):
- `social-store.js`: 250-350 lines (well under 500)
- `messages-store.js`: 80-130 lines
- `dm-room.js`: 20-40 lines
- `sqlite-store.js`: 780-820 lines (grew ~80 lines from schema additions + `getUserPublic`)
- `serve-cloud.js`: 1000-1100 lines (grew ~150 lines from new routes; approaching 800-line ceiling — flag in commit message for follow-up split)

If `serve-cloud.js` > 1100 lines, this should be noted in the final commit as a known follow-up for refactor (split routes by feature: auth / workspace / bridge / social / rooms).

```bash
grep -rn "/api/social\|/api/rooms" scripts/ src/ --include="*.js" | head
```

Expected: all references are within `scripts/serve-cloud.js` (route definitions) and the tests.

- [ ] **Step 4: Run full repo test suite**

```bash
npm test 2>&1 | tail -10
```

Expected: zero new failures introduced (pre-existing failures from missing `dist/mia-cloud-release/` artifacts are not this plan's concern — same as R baseline).

- [ ] **Step 5: Final commit (if cleanup needed)**

```bash
git status -s
# If anything uncommitted from the run, commit; otherwise skip.
```

If `serve-cloud.js` is approaching 1100 lines, the commit message should note: "FOLLOW-UP: serve-cloud.js is approaching the project's 800-line single-file ceiling. S1b implementation should not add more routes here without first splitting routes into per-feature modules (e.g., `scripts/cloud-routes/social.js`, `scripts/cloud-routes/rooms.js`, `scripts/cloud-routes/auth.js`)."

---

## Validation Summary

完成本 plan 后应满足：

1. SQLite schema v2 自动创建 5 张新表 + 4 个索引；现有 v1 数据库再次启动时自动升级（IF NOT EXISTS）
2. `src/cloud/social-store.js` 提供 friendships + friend_requests + rooms + room_members 完整 CRUD
3. `src/cloud/messages-store.js` 提供消息 CRUD + 服务端权威 per-room seq 分配（事务内 MAX(seq)+1）
4. `src/cloud/dm-room.js` 提供 dmRoomId + ensureDmRoom（friendship-gated）
5. HTTP endpoints 全部可用：invite codes (4) + friends (2) + rooms (4) = 10 个新 routes
6. WS 事件 `social.friend_added` 和 `room.message_appended` 通过现有 `broadcastEvent` fan out 到对应用户的所有在线 socket
7. 完整 end-to-end 测试：两个用户 register → 互加好友 → DM 房间自动创建 → 双向消息 → 服务端 seq 单调递增 → since_seq 增量拉取语义正确
8. 全部测试通过；现有 cloud 测试无回归

完成后客户端（S1b plan）就能直接调这些 endpoints + 订阅 WS 事件实现桌面 / 移动 / Web 端的真人好友 + 1:1 私聊体验。
