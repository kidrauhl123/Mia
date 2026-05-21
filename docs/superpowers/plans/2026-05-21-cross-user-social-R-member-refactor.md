# R 阶段：Group 引入 Member 抽象 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把现有 group 模型里的 `hostFellowId: string` / `members: string[]` 重构成 `hostMember: Member` / `members: Member[]` 抽象，行为不变。这是 spec `docs/superpowers/specs/2026-05-21-cross-user-social-design.md` §2 的 R 阶段，是后续 S2（跨用户群聊）的前置门闸。

**Architecture:** 引入 `src/main/group/member-model.js` 承载 Member 类型 + helpers；`group-store.js` 在读现有 `group.json` 时按需把 `hostFellowId` / `members: string[]` 升级为 Member 形态（migration on read），写入只写新格式；renderer/conductor/prompts 全部读 `hostMember.fellowId` 而非 `hostFellowId`。本阶段 Member 只支持 `kind: 'fellow'`，不引入 user kind。messages.jsonl 行格式不动（仍用 `senderFellowId`），等 S2 再扩。

**Tech Stack:** Node.js + Electron（CommonJS）、`node:test`、`node:assert/strict`。无新依赖。

**Prerequisite:** 本 plan 假设 `refactor/code-restructure` 分支已 merge 到 main（路径用 refactor 后的布局，如 `src/renderer/group/group.js`、`src/renderer/group/conductor.js`、`src/renderer/group/group-prompts.js`）。如果尚未 merge，先 merge 再开始本 plan，避免 path drift。

---

## File Structure

| Status | Path | Responsibility |
|---|---|---|
| Create | `src/main/group/member-model.js` | Member 类型 + 校验 + 序列化 / 反序列化 helpers |
| Create | `tests/group-member-model.test.js` | member-model 的单元测试 |
| Modify | `src/main/group-store.js` | create/get/updateGroup 接受 + 返回 Member 形态；read migration |
| Modify | `tests/group-store.test.js` | 测试场景升级到 Member；新增 migration 测试 |
| Modify | `src/renderer/group/group.js` | 渲染、创建、host 切换、成员管理全部用 Member |
| Modify | `src/renderer/group/conductor.js` | 调度读 hostMember 而非 hostFellowId |
| Modify | `src/renderer/group/group-prompts.js` | prompts 读 hostMember 而非 hostFellowId |
| Modify | `tests/group-integration.test.js` | 集成测试入参出参升级 |
| Modify | `tests/conductor.test.js` | 同上 |
| Modify | `tests/group-prompts.test.js` | 同上 |

`src/main.js` 的 IPC handlers (`group:create` / `group:update` 等) 是透传层，本身不解读 payload 字段，**不需要改**。同理 `src/preload.js` 的 bridge 不需要改。

---

## Member 形态约定（贯穿全 plan）

```js
// Member 是 plain JS object（不引入 TS）
{ kind: 'fellow', fellowId: 'aimashi', ownerId: null }

// 序列化进 group.json 时直接 JSON.stringify
// 反序列化时由 member-model.js 校验

// 等价旧格式（migration source）：
// hostFellowId: 'aimashi' → hostMember: { kind: 'fellow', fellowId: 'aimashi', ownerId: null }
// members: ['aimashi', 'codex'] → members: [
//   { kind: 'fellow', fellowId: 'aimashi', ownerId: null },
//   { kind: 'fellow', fellowId: 'codex',   ownerId: null }
// ]
```

`ownerId: null` 表示"未声明主人"。R 阶段不引入用户身份系统，全部留 null。S2 才填实际 userId。

---

### Task 1: 新建 member-model.js

**Files:**
- Create: `src/main/group/member-model.js`
- Test: `tests/group-member-model.test.js`

- [ ] **Step 1: 写 failing 测试**

写到 `tests/group-member-model.test.js`：

```js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  makeFellowMember,
  isFellowMember,
  memberKey,
  normalizeMember,
  normalizeMembersList,
  membersIncludeKey,
} = require("../src/main/group/member-model.js");

test("makeFellowMember builds canonical Member", () => {
  const m = makeFellowMember("aimashi");
  assert.deepEqual(m, { kind: "fellow", fellowId: "aimashi", ownerId: null });
});

test("makeFellowMember rejects empty fellowId", () => {
  assert.throws(() => makeFellowMember(""), /fellowId/);
  assert.throws(() => makeFellowMember(null), /fellowId/);
});

test("makeFellowMember preserves ownerId when provided", () => {
  const m = makeFellowMember("codex", { ownerId: "u-123" });
  assert.equal(m.ownerId, "u-123");
});

test("isFellowMember discriminates kind", () => {
  assert.equal(isFellowMember({ kind: "fellow", fellowId: "x", ownerId: null }), true);
  assert.equal(isFellowMember({ kind: "user", userId: "u" }), false);
  assert.equal(isFellowMember(null), false);
  assert.equal(isFellowMember({ fellowId: "x" }), false);
});

test("memberKey returns kind-prefixed unique key", () => {
  assert.equal(memberKey({ kind: "fellow", fellowId: "aimashi", ownerId: null }), "fellow:aimashi");
});

test("normalizeMember upgrades legacy string to fellow Member", () => {
  assert.deepEqual(
    normalizeMember("aimashi"),
    { kind: "fellow", fellowId: "aimashi", ownerId: null }
  );
});

test("normalizeMember passes through already-normalized Member", () => {
  const m = { kind: "fellow", fellowId: "codex", ownerId: null };
  assert.deepEqual(normalizeMember(m), m);
});

test("normalizeMember rejects malformed input", () => {
  assert.throws(() => normalizeMember(null), /member/);
  assert.throws(() => normalizeMember({ kind: "fellow" }), /fellowId/);
  assert.throws(() => normalizeMember({ kind: "user" }), /kind/); // R 阶段不接受 user kind
});

test("normalizeMembersList accepts mixed legacy + new", () => {
  const list = normalizeMembersList([
    "aimashi",
    { kind: "fellow", fellowId: "codex", ownerId: null },
  ]);
  assert.equal(list.length, 2);
  assert.equal(list[0].fellowId, "aimashi");
  assert.equal(list[1].fellowId, "codex");
});

test("membersIncludeKey matches by canonical key", () => {
  const list = [makeFellowMember("aimashi"), makeFellowMember("codex")];
  assert.equal(membersIncludeKey(list, "fellow:aimashi"), true);
  assert.equal(membersIncludeKey(list, "fellow:nope"), false);
});
```

- [ ] **Step 2: 跑测试看它 fail**

```bash
node --test tests/group-member-model.test.js
```

Expected: 全部测试 FAIL，原因是 `src/main/group/member-model.js` 不存在或导出为空。

- [ ] **Step 3: 实现 member-model.js**

写到 `src/main/group/member-model.js`：

```js
function makeFellowMember(fellowId, options = {}) {
  const id = String(fellowId || "").trim();
  if (!id) throw new Error("fellowId is required");
  return { kind: "fellow", fellowId: id, ownerId: options.ownerId ?? null };
}

function isFellowMember(value) {
  return Boolean(value) && typeof value === "object" && value.kind === "fellow" && typeof value.fellowId === "string" && value.fellowId.length > 0;
}

function memberKey(member) {
  if (isFellowMember(member)) return "fellow:" + member.fellowId;
  throw new Error("unsupported member kind: " + (member && member.kind));
}

function normalizeMember(input) {
  if (input == null) throw new Error("member is required");
  if (typeof input === "string") return makeFellowMember(input);
  if (typeof input !== "object") throw new Error("member must be object or legacy string");
  if (input.kind === "fellow") return makeFellowMember(input.fellowId, { ownerId: input.ownerId ?? null });
  throw new Error("unsupported member kind: " + input.kind);
}

function normalizeMembersList(input) {
  if (!Array.isArray(input)) throw new Error("members must be an array");
  return input.map(normalizeMember);
}

function membersIncludeKey(members, key) {
  return Array.isArray(members) && members.some((m) => memberKey(m) === key);
}

module.exports = {
  makeFellowMember,
  isFellowMember,
  memberKey,
  normalizeMember,
  normalizeMembersList,
  membersIncludeKey,
};
```

- [ ] **Step 4: 跑测试看它 pass**

```bash
node --test tests/group-member-model.test.js
```

Expected: 所有测试 PASS。

- [ ] **Step 5: Commit**

```bash
git add src/main/group/member-model.js tests/group-member-model.test.js
git commit -m "feat(group): add Member abstraction (fellow kind) for R refactor"
```

---

### Task 2: group-store create() 接受 + 持久化 Member 形态

**Files:**
- Modify: `src/main/group-store.js` (function `create`, 约第 53 行起)
- Test: `tests/group-store.test.js` (升级现有 create 用例 + 新增 Member 输入用例)

- [ ] **Step 1: 写 failing 测试**

替换 `tests/group-store.test.js` 中现有 "create group writes group.json and manifest entry" 用例，并新增 "create group accepts Member[] input":

```js
const { makeFellowMember } = require("../src/main/group/member-model.js");

test("create group writes group.json with Member-shaped fields", () => {
  const root = makeTmpRoot();
  const store = createGroupStore(root);
  const group = store.create({
    name: "Test Group",
    members: [makeFellowMember("alice"), makeFellowMember("bob")],
    hostMember: makeFellowMember("alice"),
  });
  assert.ok(group.id);
  assert.equal(group.name, "Test Group");
  assert.equal(group.members.length, 2);
  assert.equal(group.members[0].kind, "fellow");
  assert.equal(group.members[0].fellowId, "alice");
  assert.equal(group.hostMember.kind, "fellow");
  assert.equal(group.hostMember.fellowId, "alice");

  const onDisk = JSON.parse(
    fs.readFileSync(path.join(root, group.id, "group.json"), "utf8")
  );
  assert.equal(onDisk.hostMember.fellowId, "alice");
  assert.equal(onDisk.members.length, 2);
});

test("create group accepts legacy string inputs and normalizes to Member", () => {
  const root = makeTmpRoot();
  const store = createGroupStore(root);
  const group = store.create({
    name: "Legacy",
    members: ["alice", "bob"],
    hostFellowId: "alice",
  });
  assert.equal(group.hostMember.fellowId, "alice");
  assert.equal(group.members[1].fellowId, "bob");
  // 旧字段不再出现在结果对象上
  assert.equal(group.hostFellowId, undefined);
});

test("create group throws when hostMember is not in members", () => {
  const root = makeTmpRoot();
  const store = createGroupStore(root);
  assert.throws(
    () => store.create({
      name: "Bad",
      members: [makeFellowMember("a"), makeFellowMember("b")],
      hostMember: makeFellowMember("c"),
    }),
    /hostMember must be one of members/
  );
});
```

- [ ] **Step 2: 跑测试看它 fail**

```bash
node --test tests/group-store.test.js
```

Expected: 新加的三条测试 FAIL（旧 `create` 返回的 group 是 `hostFellowId` 形态，没有 `hostMember`）。

- [ ] **Step 3: 改 group-store.js 的 create()**

把 `src/main/group-store.js` 顶部加 import：

```js
const {
  normalizeMember,
  normalizeMembersList,
  memberKey,
  membersIncludeKey,
} = require("./group/member-model.js");
```

把 `create` 函数（原第 53 行）替换为：

```js
function create({ name, members, hostMember, hostFellowId, avatar = null }) {
  const normalizedMembers = normalizeMembersList(members);
  if (normalizedMembers.length < 2 || normalizedMembers.length > 5) {
    throw new Error("group members must be between 2 and 5");
  }
  // 兼容旧入参：如果传了 hostFellowId 没传 hostMember，自动升级
  const hostInput = hostMember != null ? hostMember : hostFellowId;
  if (hostInput == null) throw new Error("hostMember is required");
  const normalizedHost = normalizeMember(hostInput);
  if (!membersIncludeKey(normalizedMembers, memberKey(normalizedHost))) {
    throw new Error("hostMember must be one of members");
  }
  const id = "g-" + crypto.randomBytes(8).toString("hex");
  const now = Date.now();
  const group = {
    id,
    name,
    avatar,
    members: normalizedMembers,
    hostMember: normalizedHost,
    decorations: { pinnedGoal: null, todos: [] },
    contextCard: null,
    createdAt: now,
    updatedAt: now,
  };
  fs.mkdirSync(groupPath(id), { recursive: true });
  atomicWrite(groupJsonPath(id), JSON.stringify(group, null, 2));
  fs.writeFileSync(messagesPath(id), "");
  const manifest = loadManifest();
  manifest.groups.push({ id, name, createdAt: now });
  saveManifest(manifest);
  return group;
}
```

- [ ] **Step 4: 跑测试看它 pass**

```bash
node --test tests/group-store.test.js
```

Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add src/main/group-store.js tests/group-store.test.js
git commit -m "refactor(group): create() emits hostMember/Member[] schema"
```

---

### Task 3: group-store get() / list() 读取时迁移旧 group.json

**Files:**
- Modify: `src/main/group-store.js` (function `get` + helper `migrateLegacyGroup`)
- Test: `tests/group-store.test.js`

**背景**：现有用户的磁盘上有 `group.json` 是 `{ hostFellowId, members: string[] }` 形态。`get()` 读时必须升级为 Member 形态，让上层永远拿到新 schema。

- [ ] **Step 1: 写 failing 测试**

追加到 `tests/group-store.test.js`：

```js
test("get() migrates legacy group.json on read", () => {
  const root = makeTmpRoot();
  const id = "g-legacy";
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "group.json"), JSON.stringify({
    id,
    name: "Legacy Group",
    avatar: null,
    members: ["alice", "bob"],
    hostFellowId: "alice",
    decorations: { pinnedGoal: null, todos: [] },
    contextCard: null,
    createdAt: 1,
    updatedAt: 1,
  }));
  fs.writeFileSync(path.join(dir, "messages.jsonl"), "");
  fs.writeFileSync(path.join(root, "manifest.json"), JSON.stringify({
    groups: [{ id, name: "Legacy Group", createdAt: 1 }],
  }));

  const store = createGroupStore(root);
  const group = store.get(id);
  assert.equal(group.hostMember.kind, "fellow");
  assert.equal(group.hostMember.fellowId, "alice");
  assert.equal(group.members.length, 2);
  assert.equal(group.members[0].fellowId, "alice");
  // 旧字段不在返回对象上（防御后续代码继续读 hostFellowId）
  assert.equal(group.hostFellowId, undefined);
});

test("list() returns all groups normalized", () => {
  const root = makeTmpRoot();
  const store = createGroupStore(root);
  store.create({
    name: "A",
    members: [makeFellowMember("x"), makeFellowMember("y")],
    hostMember: makeFellowMember("x"),
  });
  // 手工塞一个 legacy
  const legacyId = "g-leg";
  fs.mkdirSync(path.join(root, legacyId), { recursive: true });
  fs.writeFileSync(path.join(root, legacyId, "group.json"), JSON.stringify({
    id: legacyId, name: "Old", avatar: null,
    members: ["m", "n"], hostFellowId: "m",
    decorations: { pinnedGoal: null, todos: [] },
    contextCard: null, createdAt: 1, updatedAt: 1,
  }));
  fs.writeFileSync(path.join(root, legacyId, "messages.jsonl"), "");
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  manifest.groups.push({ id: legacyId, name: "Old", createdAt: 1 });
  fs.writeFileSync(path.join(root, "manifest.json"), JSON.stringify(manifest));

  const groups = store.list();
  assert.equal(groups.length, 2);
  for (const g of groups) {
    assert.equal(g.hostMember.kind, "fellow");
    assert.ok(g.members.every((m) => m.kind === "fellow"));
    assert.equal(g.hostFellowId, undefined);
  }
});
```

- [ ] **Step 2: 跑测试看它 fail**

```bash
node --test tests/group-store.test.js
```

Expected: 两条新测试 FAIL（`get()` 直接返回 readJSON 的原始对象，没做 migration）。

- [ ] **Step 3: 实现 migration**

在 `src/main/group-store.js` 中，在 `function get(id)` 之前增加：

```js
function migrateLegacyGroup(raw) {
  if (!raw) return raw;
  // 已经是新 schema：直接返回
  if (raw.hostMember && Array.isArray(raw.members) && raw.members.every((m) => m && m.kind === "fellow")) {
    return raw;
  }
  const normalizedMembers = Array.isArray(raw.members) ? raw.members.map(normalizeMember) : [];
  const hostSrc = raw.hostMember ?? raw.hostFellowId;
  const hostMember = hostSrc != null ? normalizeMember(hostSrc) : null;
  // 删除旧字段，确保上层只看到新形态
  const { hostFellowId, ...rest } = raw;
  return { ...rest, members: normalizedMembers, hostMember };
}
```

把 `function get` 替换为：

```js
function get(id) {
  const raw = readJSON(groupJsonPath(id), null);
  return migrateLegacyGroup(raw);
}
```

`list()` 调的就是 `get(entry.id)`，自动受益。

- [ ] **Step 4: 跑测试看它 pass**

```bash
node --test tests/group-store.test.js
```

Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add src/main/group-store.js tests/group-store.test.js
git commit -m "refactor(group): migrate legacy hostFellowId on read in get()"
```

---

### Task 4: group-store updateGroup() 接受 Member 入参

**Files:**
- Modify: `src/main/group-store.js` (function `updateGroup`)
- Test: `tests/group-store.test.js`

- [ ] **Step 1: 写 failing 测试**

替换原有 "updateGroup persists host switch" 用例：

```js
test("updateGroup persists hostMember switch", () => {
  const root = makeTmpRoot();
  const store = createGroupStore(root);
  const group = store.create({
    name: "G",
    members: [makeFellowMember("a"), makeFellowMember("b")],
    hostMember: makeFellowMember("a"),
  });
  store.updateGroup(group.id, { hostMember: makeFellowMember("b") });
  const fresh = store.get(group.id);
  assert.equal(fresh.hostMember.fellowId, "b");
  assert.equal(fresh.hostFellowId, undefined);
});

test("updateGroup accepts legacy hostFellowId and normalizes", () => {
  const root = makeTmpRoot();
  const store = createGroupStore(root);
  const group = store.create({
    name: "G",
    members: [makeFellowMember("a"), makeFellowMember("b")],
    hostMember: makeFellowMember("a"),
  });
  store.updateGroup(group.id, { hostFellowId: "b" });
  const fresh = store.get(group.id);
  assert.equal(fresh.hostMember.fellowId, "b");
});

test("updateGroup normalizes members when patch provides them", () => {
  const root = makeTmpRoot();
  const store = createGroupStore(root);
  const group = store.create({
    name: "G",
    members: [makeFellowMember("a"), makeFellowMember("b")],
    hostMember: makeFellowMember("a"),
  });
  store.updateGroup(group.id, { members: ["a", "b", "c"] });
  const fresh = store.get(group.id);
  assert.equal(fresh.members.length, 3);
  assert.equal(fresh.members[2].fellowId, "c");
  assert.equal(fresh.members[2].kind, "fellow");
});
```

- [ ] **Step 2: 跑测试看它 fail**

```bash
node --test tests/group-store.test.js
```

Expected: 三条新测试 FAIL（updateGroup 直接 spread patch，不做 normalization）。

- [ ] **Step 3: 改 updateGroup()**

替换 `function updateGroup(id, patch)`：

```js
function updateGroup(id, patch) {
  const existing = get(id);
  if (!existing) throw new Error("group not found: " + id);
  const normalizedPatch = { ...patch };
  if (Object.prototype.hasOwnProperty.call(normalizedPatch, "members")) {
    normalizedPatch.members = normalizeMembersList(normalizedPatch.members);
  }
  // host 字段升级：hostMember > hostFellowId
  if (normalizedPatch.hostMember != null) {
    normalizedPatch.hostMember = normalizeMember(normalizedPatch.hostMember);
  } else if (normalizedPatch.hostFellowId != null) {
    normalizedPatch.hostMember = normalizeMember(normalizedPatch.hostFellowId);
  }
  delete normalizedPatch.hostFellowId;
  const updated = { ...existing, ...normalizedPatch, updatedAt: Date.now() };
  atomicWrite(groupJsonPath(id), JSON.stringify(updated, null, 2));
  if (normalizedPatch.name) {
    const manifest = loadManifest();
    const entry = manifest.groups.find((g) => g.id === id);
    if (entry) entry.name = normalizedPatch.name;
    saveManifest(manifest);
  }
  if (normalizedPatch && Object.prototype.hasOwnProperty.call(normalizedPatch, "contextCard") && normalizedPatch.contextCard === null) {
    try { fs.unlinkSync(contextCardPath(id)); } catch { /* may not exist */ }
  }
  return updated;
}
```

- [ ] **Step 4: 跑测试看它 pass**

```bash
node --test tests/group-store.test.js
```

Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add src/main/group-store.js tests/group-store.test.js
git commit -m "refactor(group): updateGroup accepts and normalizes hostMember/members"
```

---

### Task 5: renderer/group/group.js — 创建群 UI 输出 Member

**Files:**
- Modify: `src/renderer/group/group.js` (创建群表单提交处，原 main 分支视角约第 239-244 行)

**背景**：创建群的代码当前从 select 元素读 fellowId 字符串然后直接传 `{ members, hostFellowId }`。改成传 Member 形态。

- [ ] **Step 1: 定位代码**

在 `src/renderer/group/group.js` 找到形如以下的代码（创建群表单的 submit handler）：

```js
const hostFellowId = hostSelect.value || members[0];
// ...
const group = await window.aimashi.groups.create({ name, members, hostFellowId });
```

注意：渲染端没有 require module-resolution，Member 工厂函数需要通过 preload 暴露**或**直接在 renderer 端 inline 一个等价函数。本 plan 选择 **inline**（避免动 preload bridge）。

- [ ] **Step 2: 写一个小 helper（renderer 端）**

在 `src/renderer/group/group.js` 文件顶部模块作用域加（如果文件是 IIFE，加在 IIFE 内部顶部）：

```js
function fellowMember(fellowId) {
  return { kind: "fellow", fellowId: String(fellowId), ownerId: null };
}
```

- [ ] **Step 3: 替换创建群提交逻辑**

把：

```js
const hostFellowId = hostSelect.value || members[0];
// ...
const group = await window.aimashi.groups.create({ name, members, hostFellowId });
```

改成：

```js
const hostFellowIdValue = hostSelect.value || members[0];
const memberList = members.map(fellowMember);
const hostMember = fellowMember(hostFellowIdValue);
const group = await window.aimashi.groups.create({ name, members: memberList, hostMember });
```

注意 `members` 数组从 UI 收集到的是 fellowId 字符串数组（select / checkbox dataset），保留这层；只在调 IPC 前转 Member。

- [ ] **Step 4: 启动 Electron 烟测**

```bash
npm run open
```

操作：联系人页 → 新建群 → 选 2 个 fellow → 提交。检查：
- 群创建成功，侧边栏出现
- 关闭 app，看 `~/Library/Application Support/Aimashi/groups/<gid>/group.json` 内容确实是 Member 形态（`hostMember.fellowId = ...`）
- 没有报错

- [ ] **Step 5: Commit**

```bash
git add src/renderer/group/group.js
git commit -m "refactor(group): renderer create group submits Member[] + hostMember"
```

---

### Task 6: renderer/group/group.js — 渲染、host 切换、成员管理读取 hostMember

**Files:**
- Modify: `src/renderer/group/group.js`

**背景**：当前 renderer 多处用 `group.hostFellowId`、`group.members.includes(fellowId)` 这种字符串假设。逐处改成读 `group.hostMember.fellowId` / `group.members.some(m => m.fellowId === fellowId)`。

为了减小改动面，**保留 fellowId 字符串作为 UI 内部标识符**，只在 group / 持久化边界用 Member。

- [ ] **Step 1: 加 helper 函数（同文件顶部）**

```js
function memberFellowIds(group) {
  return Array.isArray(group?.members) ? group.members.map((m) => m.fellowId) : [];
}
function getHostFellowId(group) {
  return group?.hostMember?.fellowId || null;
}
```

- [ ] **Step 2: 改群列表渲染（原约 306 行 `(memberId === group.hostFellowId ? " 👑" : "")`）**

```js
(memberId === getHostFellowId(group) ? " 👑" : "")
```

- [ ] **Step 3: 改 host select 当前选中（原约 411 行）**

```js
if (memberId === getHostFellowId(group)) opt.selected = true;
```

- [ ] **Step 4: 改 host 切换 handler（原约 416-418 行）**

把：
```js
group.hostFellowId = newHost;
// ...
Object.assign(group, await window.aimashi.groups.update(group.id, { hostFellowId: newHost }));
```
改成：
```js
group.hostMember = fellowMember(newHost);
// ...
Object.assign(group, await window.aimashi.groups.update(group.id, { hostMember: fellowMember(newHost) }));
```

- [ ] **Step 5: 改 message 渲染中的 host 判断（原约 550 行 `senderFellowId === group.hostFellowId`）**

```js
const isHost = msg.senderFellowId === getHostFellowId(group);
```

- [ ] **Step 6: 改成员加 / 移除（原约 368-378 行）**

把：
```js
const newMembers = [...group.members, fellowId];
// ...
Object.assign(group, await window.aimashi.groups.update(group.id, { members: newMembers }));
```
改成：
```js
const newMembers = [...memberFellowIds(group), fellowId].map(fellowMember);
// ...
Object.assign(group, await window.aimashi.groups.update(group.id, { members: newMembers }));
```

- [ ] **Step 7: 改 dispatchToFellow 入口（原约 727 行 `group.members.includes(f.id || f.key)`）**

```js
members: currentFellows().filter((f) => memberFellowIds(group).includes(f.id || f.key)),
```

- [ ] **Step 8: 改 host wrapup 调用（原约 774-778 行 `group.hostFellowId`）**

```js
getHostFellowId(group)
// ...
await dispatchToFellow(group, getHostFellowId(group), wrapupMsg, turnId)
```

- [ ] **Step 9: 改成员移除时的 host fallback（原约 898-907 行）**

把：
```js
let newHost = group.hostFellowId;
// ...
if (memberId === group.hostFellowId) {
  newHost = ...
}
group.hostFellowId = newHost;
Object.assign(group, await window.aimashi.groups.update(group.id, { members: newMembers, hostFellowId: newHost }));
```
改成：
```js
let newHost = getHostFellowId(group);
// ...
if (memberId === getHostFellowId(group)) {
  newHost = ...
}
group.hostMember = fellowMember(newHost);
Object.assign(group, await window.aimashi.groups.update(group.id, {
  members: newMembers.map(fellowMember),
  hostMember: fellowMember(newHost),
}));
```

- [ ] **Step 10: 全文 grep 自检**

```bash
grep -n "hostFellowId" src/renderer/group/group.js
```

Expected: 应为空（或仅出现在 Task 9 移除成员的兼容 patch 路径，如果你保留了 hostFellowId 入参兼容）。如果 renderer 里还有 `group.hostFellowId` 或 `payload.hostFellowId` 直接读写，回到对应 step 补改。

- [ ] **Step 11: 烟测**

```bash
npm run open
```

操作：
- 打开已存在的旧群（migration 路径），群头像 / 成员列表 / host 标识（👑）正常
- 切换 host：右键群成员或 host 下拉切换，刷新后持久
- 添加 / 移除成员：列表正常更新
- 发消息：host 消息边框/标识与之前一致
- 关闭后查看 group.json：所有 group 都是 Member 形态

- [ ] **Step 12: Commit**

```bash
git add src/renderer/group/group.js
git commit -m "refactor(group): renderer reads hostMember/Member[] throughout"
```

---

### Task 7: conductor.js 适配 Member

**Files:**
- Modify: `src/renderer/group/conductor.js`
- Modify: `tests/conductor.test.js`

**背景**：conductor 不读 `group.hostMember`（host 调度在 group.js renderer 处理），但读 `group.members` 三次，全部是 `members.includes(id)` 形态 —— `id` 是 mention/parsed-output 里的 fellowId 字符串，但 `members` 现在是 Member 对象数组，`.includes` 会全部 false。必须改成基于 `fellowId` 字段的查找。

- [ ] **Step 1: 写 failing 测试**

`tests/conductor.test.js` 里把构造 group fixture 的地方升级到 Member 形态。先看现有用例：

```bash
grep -nE "members:|hostFellowId|group: \{" tests/conductor.test.js
```

把每处 `members: ["a", "b"]` 改成：

```js
members: [
  { kind: "fellow", fellowId: "a", ownerId: null },
  { kind: "fellow", fellowId: "b", ownerId: null },
],
```

把每处 `hostFellowId: "a"` 改成：

```js
hostMember: { kind: "fellow", fellowId: "a", ownerId: null },
```

（conductor 不读 hostMember，但 fixture 形态要跟 group-store 输出对齐。）

- [ ] **Step 2: 跑测试看它 fail**

```bash
node --test tests/conductor.test.js
```

Expected: `decideDispatch` 相关用例 FAIL，因为 `ctx.group.members.includes(id)` 在 Member 数组上返回 false，导致 `valid` 永远是空数组，dispatch 返回空。

- [ ] **Step 3: 改 conductor.js 三处 includes**

在 `src/renderer/group/conductor.js` 把这三处分别改：

**第一处**（`decideDispatch` 内 mention fast-path）：

把：
```js
const valid = ctx.userMessage.mentions.filter((id) =>
  ctx.group.members.includes(id)
);
```
改成：
```js
const valid = ctx.userMessage.mentions.filter((id) =>
  ctx.group.members.some((m) => m.fellowId === id)
);
```

**第二处**（`decideDispatch` 内 parsed.speak 过滤）：

把：
```js
const valid = parsed.speak.filter((id) => ctx.group.members.includes(id));
return { speak: valid };
```
改成：
```js
const valid = parsed.speak.filter((id) => ctx.group.members.some((m) => m.fellowId === id));
return { speak: valid };
```

**第三处**（`decideRelay` 内 parsed.speak 过滤）：

把：
```js
const valid = parsed.speak.filter((id) => ctx.group.members.includes(id));
return { speak: valid };
```
改成：
```js
const valid = parsed.speak.filter((id) => ctx.group.members.some((m) => m.fellowId === id));
return { speak: valid };
```

- [ ] **Step 4: 跑测试看它 pass**

```bash
node --test tests/conductor.test.js
```

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/renderer/group/conductor.js tests/conductor.test.js
git commit -m "refactor(group): conductor reads Member[] via fellowId field"
```

---

### Task 8: 验证 group-prompts.js 不需要改

**Files:** （无改动 — 验证为主）

**背景**：审阅 `src/renderer/group/group-prompts.js` 后，所有对外接口都不直接读 `group.members` 或 `group.hostMember`：
- `parseMentions(content, fellows)` 的 `fellows` 是 caller 传入的 rich fellow 对象数组（`{id, name, ...}`）
- `formatMembersForPrompt(members)` 的 `members` 同样是 rich 对象
- `filterRecentTurnsForFellow(messages, fellowId, k)` / `formatMessagesForPrompt(messages, fellowNamesById)` 用 `msg.senderFellowId` —— 字符串，本阶段不变
- `shouldSummarize(group, messages)` 只读 `group.contextCard`

所有"原始 group.members 数组形态"的解构都发生在 caller（group.js renderer 或 conductor），由它们传入 prompts 需要的 rich 形态。R 阶段 group-prompts.js 无需改动。

- [ ] **Step 1: 验证 grep 结果**

```bash
grep -nE "group\.members|group\.hostFellowId|group\.hostMember" src/renderer/group/group-prompts.js
```

Expected: 无输出（除 `group.contextCard` 之外不应该有 `group.<field>` 形式访问 members/host）。

如果 grep 有结果，说明此前理解错误，需要按 Task 7 风格补改。

- [ ] **Step 2: 跑 group-prompts 测试确认未受影响**

```bash
node --test tests/group-prompts.test.js
```

Expected: PASS（理论上不受 R 影响因为 group-prompts.js 没动）。

- [ ] **Step 3: 跳过 commit**

本 task 无代码改动 → 无 commit。在执行 plan 时此 task 仅用于挡门 / 验证假设。

---

### Task 9: 升级 group-integration.test.js

**Files:**
- Modify: `tests/group-integration.test.js`

**背景**：集成测试可能通过 IPC payload 传 group。升级测试入参为 Member 形态。

- [ ] **Step 1: 看现有用例**

```bash
grep -n "hostFellowId\|members:" tests/group-integration.test.js
```

- [ ] **Step 2: 升级 fixture**

对所有传入 group-store 或 IPC 的 group payload，把 `hostFellowId: "x"` 改成 `hostMember: { kind: "fellow", fellowId: "x", ownerId: null }`，`members: ["a", ...]` 改成 Member[]。

也可以使用 `require("../src/main/group/member-model.js").makeFellowMember` 简化构造。

- [ ] **Step 3: 跑集成测试**

```bash
node --test tests/group-integration.test.js
```

Expected: PASS。

- [ ] **Step 4: Commit**

```bash
git add tests/group-integration.test.js
git commit -m "refactor(group): group integration test uses Member fixtures"
```

---

### Task 10: 跑全套测试 + 全仓 grep 收尾

**Files:** （无新文件，纯验证）

- [ ] **Step 1: 全 grep 自检**

```bash
grep -rn "hostFellowId" src/ tests/ --include="*.js" | grep -v "member-model.js\|^src/main/group-store\.js"
```

Expected: 仅出现在 group-store.js 内部 migration 兼容路径（`raw.hostFellowId`、入参 `hostFellowId`）和 member-model 测试。如果在 renderer / conductor / prompts 还有遗漏，逐处补改。

- [ ] **Step 2: 全套测试**

```bash
npm test
```

Expected: 全 PASS。如果有红测：

- `cloud-*` 类 — 不应该受 R 影响（R 不动 cloud 路径）。如果挂了说明 R 有副作用，需 root-cause。
- `group-*` / `conductor` — 必然在 R 范围内，根据失败信息回到对应 task 修。
- `project-structure-check` — 如果挂，可能是新文件路径不符合项目结构约定，按 CLAUDE.md 调整。

- [ ] **Step 3: 烟测脚本**

```bash
npm run open
```

操作 checklist：
- [ ] 启动无报错
- [ ] 已有旧群可打开（migration 生效）
- [ ] 创建新群（2-3 个 fellow）成功，磁盘 group.json 是 Member 形态
- [ ] 切换 host fellow 持久
- [ ] 加 / 移除成员持久
- [ ] 群里发一条用户消息，host fellow 接话，dispatch 到其它 fellow 接话正常
- [ ] 删除群成功

- [ ] **Step 4: 文件大小合规检查**

```bash
wc -l src/main/group/member-model.js src/main/group-store.js src/renderer/group/group.js
```

Expected:
- `member-model.js` < 100 行
- `group-store.js` < 250 行（原 154 + migration 增量）
- `group.js` ≈ 1000 行（原 974 + helper 增量，保持在 < 1000 一旦超过应在下一步拆分计划里登记，但不本 plan 范围内）

- [ ] **Step 5: 最终 commit（如果上面 step 有微调）**

```bash
git status -s
# 如果有未提交的微调，单独 commit
git add -A
git commit -m "refactor(group): final cleanup after Member migration"
```

如果 step 1-4 都干净没改动，跳过本 step。

---

## Validation Summary

完成本 plan 后应满足：

1. `grep -rn "hostFellowId" src/ --include="*.js"` 仅出现在 `group-store.js` 内部兼容入参 / migration 路径
2. `npm test` 全 PASS
3. 旧 `group.json` 文件能被读取并自动以 Member 形态返回
4. 新建 group 时磁盘上的 `group.json` 是 Member 形态
5. 现有所有群聊功能（创建、host 切换、加 / 移除成员、消息发送、host wrapup、删除群）行为不变

完成后跨用户社交 S2 阶段可以基于 Member 抽象叠加 `kind: 'user'` 成员，无需再动 group-store 主结构。
