# Aimashi Group Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 aimashi 群聊 v1，支持把多个 Fellow 拉到同一会话，由群主 Fellow 承担调度/摘要的不可见 LLM 调用，跨引擎共群，按 spec `docs/superpowers/specs/2026-05-14-group-chat-design.md` 落地。

**Architecture:** 单一 "group" 实体（侧边栏与 1v1 单聊并列）。群主 Fellow 是 members 之一，在群里承担三种行为——可见的"接话发言"（带人设）、不可见的"调度决策"和"摘要生成"（系统 prompt，无人设，无状态调用，不污染 Fellow session）。群上下文（摘要 + 被 @ 历史）在 dispatch 时由 main 进程按 Fellow 引擎注入。

**Tech Stack:** Vanilla JS（无 React、无 TS、无构建链），Electron `main + preload + renderer` 三层，与现有 `src/main.js` / `src/preload.js` / `src/renderer/app.js` 同栈。测试用 Node 内置 `node:test`（无新依赖）。引擎调用复用现有 Hermes HTTP / `@anthropic-ai/claude-agent-sdk` / `@openai/codex-sdk`。

**Spec reference:** `docs/superpowers/specs/2026-05-14-group-chat-design.md`（commit `db89083`）

---

## 文件清单

### 新增

```
src/main/group-store.js          # 群 CRUD、messages.jsonl 追加、IPC handler 注册
src/main/group-adapters.js       # 三引擎的群上下文注入
src/renderer/group.js            # renderer 侧群 UI 与交互（DOM 操作，参考 pet.js 风格）
src/renderer/conductor.js        # 调度 / 摘要 / nudge 协调（renderer 侧，无状态调用）
src/renderer/group-prompts.js    # prompt 构造与 @ 解析等纯函数
resources/conductor/default-prompts/dispatch.md
resources/conductor/default-prompts/summarize.md
resources/conductor/default-prompts/nudge.md
tests/group-store.test.js
tests/group-prompts.test.js
tests/conductor.test.js
tests/group-adapters.test.js
```

### 修改

```
package.json                                              # 加 npm test 脚本
src/main.js                                               # 注册 group-store + group-adapters IPC
src/preload.js                                            # 暴露 aimashi.groups.* API
src/renderer/app.js                                       # 侧边栏识别 group / 1v1，群入口
src/renderer/index.html                                   # group 视图 DOM 节点
src/renderer/styles.css                                   # 群相关样式
src/check.js                                              # 新文件加入 required 列表
runtime/hermes-engine/aimashi_plugins/fellow_overlay.py   # 解析 X-Aimashi-Group-Context header
```

---

## Task 1: 安装 node:test 运行器 + smoke test

**Files:**
- Modify: `package.json`
- Create: `tests/smoke.test.js`

- [ ] **Step 1: 写最小 smoke test**

Create `tests/smoke.test.js`:
```js
const { test } = require("node:test");
const assert = require("node:assert/strict");

test("node:test runs", () => {
  assert.equal(1 + 1, 2);
});
```

- [ ] **Step 2: 加 npm script**

Edit `package.json`, in `"scripts"` add:
```json
"test": "node --test tests/"
```

- [ ] **Step 3: 跑测试，确认运行器工作**

Run: `npm test`
Expected: `# tests 1`, `# pass 1`, exit code 0

- [ ] **Step 4: Commit**

```bash
git add package.json tests/smoke.test.js
git commit -m "test: add node:test runner with smoke test"
```

---

## Task 2: Group store 数据层（读写 group.json + manifest + messages.jsonl）

**Files:**
- Create: `src/main/group-store.js`
- Test: `tests/group-store.test.js`

设计：`group-store.js` 导出纯函数 + 一个工厂 `createGroupStore(rootDir)`。工厂返回带 `create/list/get/appendMessage/listMessages/updateGroup/saveContextCard` 方法的对象。Root dir 由 main 进程注入（生产用 `engine-home/groups/`，测试用 tmp）。

- [ ] **Step 1: 写测试**

Create `tests/group-store.test.js`:
```js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createGroupStore } = require("../src/main/group-store.js");

function makeTmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "aimashi-group-test-"));
}

test("create group writes group.json and manifest entry", () => {
  const root = makeTmpRoot();
  const store = createGroupStore(root);
  const group = store.create({
    name: "Test Group",
    members: ["alice", "bob"],
    hostFellowId: "alice",
  });
  assert.ok(group.id);
  assert.equal(group.name, "Test Group");
  assert.deepEqual(group.members, ["alice", "bob"]);

  const onDisk = JSON.parse(
    fs.readFileSync(path.join(root, group.id, "group.json"), "utf8")
  );
  assert.equal(onDisk.id, group.id);

  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, "manifest.json"), "utf8")
  );
  assert.equal(manifest.groups.length, 1);
});

test("list returns all groups", () => {
  const root = makeTmpRoot();
  const store = createGroupStore(root);
  store.create({ name: "A", members: ["x", "y"], hostFellowId: "x" });
  store.create({ name: "B", members: ["y", "z"], hostFellowId: "y" });
  const groups = store.list();
  assert.equal(groups.length, 2);
});

test("appendMessage and listMessages roundtrip", () => {
  const root = makeTmpRoot();
  const store = createGroupStore(root);
  const group = store.create({
    name: "G", members: ["a", "b"], hostFellowId: "a",
  });
  store.appendMessage(group.id, {
    id: "m1", role: "user", content: "hi", mentions: [], turnId: "t1",
  });
  store.appendMessage(group.id, {
    id: "m2", role: "fellow", senderFellowId: "a", content: "hello",
    mentions: [], turnId: "t1",
  });
  const msgs = store.listMessages(group.id);
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].content, "hi");
  assert.equal(msgs[1].senderFellowId, "a");
});

test("updateGroup persists host switch", () => {
  const root = makeTmpRoot();
  const store = createGroupStore(root);
  const group = store.create({
    name: "G", members: ["a", "b"], hostFellowId: "a",
  });
  store.updateGroup(group.id, { hostFellowId: "b" });
  const fresh = store.get(group.id);
  assert.equal(fresh.hostFellowId, "b");
});

test("saveContextCard atomic write", () => {
  const root = makeTmpRoot();
  const store = createGroupStore(root);
  const group = store.create({
    name: "G", members: ["a", "b"], hostFellowId: "a",
  });
  store.saveContextCard(group.id, {
    summary: "they're talking about X",
    summaryUpToMsgId: "m5",
    updatedAt: Date.now(),
  });
  const card = JSON.parse(
    fs.readFileSync(path.join(root, group.id, "context-card.json"), "utf8")
  );
  assert.equal(card.summary, "they're talking about X");
});
```

- [ ] **Step 2: 跑测试确认全 FAIL**

Run: `npm test`
Expected: 多条 FAIL，提示 `Cannot find module '../src/main/group-store.js'`

- [ ] **Step 3: 实现 group-store.js**

Create `src/main/group-store.js`:
```js
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

function atomicWrite(filePath, content) {
  const tmp = filePath + ".tmp." + crypto.randomBytes(6).toString("hex");
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, filePath);
}

function readJSON(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return fallback;
    throw e;
  }
}

function createGroupStore(rootDir) {
  fs.mkdirSync(rootDir, { recursive: true });
  const manifestPath = path.join(rootDir, "manifest.json");

  function loadManifest() {
    return readJSON(manifestPath, { groups: [] });
  }

  function saveManifest(manifest) {
    atomicWrite(manifestPath, JSON.stringify(manifest, null, 2));
  }

  function groupPath(id) {
    return path.join(rootDir, id);
  }

  function groupJsonPath(id) {
    return path.join(groupPath(id), "group.json");
  }

  function messagesPath(id) {
    return path.join(groupPath(id), "messages.jsonl");
  }

  function contextCardPath(id) {
    return path.join(groupPath(id), "context-card.json");
  }

  function create({ name, members, hostFellowId, avatar = null }) {
    if (!Array.isArray(members) || members.length < 2 || members.length > 5) {
      throw new Error("group members must be between 2 and 5");
    }
    if (!members.includes(hostFellowId)) {
      throw new Error("hostFellowId must be one of members");
    }
    const id = "g-" + crypto.randomBytes(8).toString("hex");
    const now = Date.now();
    const group = {
      id,
      name,
      avatar,
      members,
      hostFellowId,
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

  function list() {
    return loadManifest().groups.map((entry) => get(entry.id)).filter(Boolean);
  }

  function get(id) {
    return readJSON(groupJsonPath(id), null);
  }

  function updateGroup(id, patch) {
    const existing = get(id);
    if (!existing) throw new Error("group not found: " + id);
    const updated = { ...existing, ...patch, updatedAt: Date.now() };
    atomicWrite(groupJsonPath(id), JSON.stringify(updated, null, 2));
    if (patch.name) {
      const manifest = loadManifest();
      const entry = manifest.groups.find((g) => g.id === id);
      if (entry) entry.name = patch.name;
      saveManifest(manifest);
    }
    return updated;
  }

  function appendMessage(id, message) {
    fs.appendFileSync(messagesPath(id), JSON.stringify(message) + "\n");
  }

  function listMessages(id) {
    let raw;
    try {
      raw = fs.readFileSync(messagesPath(id), "utf8");
    } catch (e) {
      if (e.code === "ENOENT") return [];
      throw e;
    }
    return raw.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  }

  function saveContextCard(id, card) {
    atomicWrite(contextCardPath(id), JSON.stringify(card, null, 2));
    updateGroup(id, { contextCard: card });
  }

  return { create, list, get, updateGroup, appendMessage, listMessages, saveContextCard };
}

module.exports = { createGroupStore };
```

- [ ] **Step 4: 跑测试确认全 PASS**

Run: `npm test`
Expected: 全 PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/group-store.js tests/group-store.test.js
git commit -m "feat(group): add group-store with CRUD and message log"
```

---

## Task 3: @ 解析器 + Fellow 上下文过滤（纯函数）

**Files:**
- Create: `src/renderer/group-prompts.js`（renderer 和 main 都用，CommonJS）
- Test: `tests/group-prompts.test.js`

`group-prompts.js` 放 4 个纯函数：`parseMentions`、`filterRecentTurnsForFellow`、`buildDispatchPrompt`、`buildSummarizePrompt`、`buildFellowGroupContext`、`shouldSummarize`。这一 task 先做前两个。

- [ ] **Step 1: 写测试**

Create `tests/group-prompts.test.js`:
```js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  parseMentions,
  filterRecentTurnsForFellow,
} = require("../src/renderer/group-prompts.js");

const fellows = [
  { id: "alice", name: "Alice" },
  { id: "bob", name: "Bob" },
  { id: "coder", name: "Coder" },
];

test("parseMentions extracts @name and resolves to fellow ids", () => {
  assert.deepEqual(parseMentions("hey @alice 看下", fellows), ["alice"]);
  assert.deepEqual(parseMentions("@alice @bob 一起", fellows), ["alice", "bob"]);
  assert.deepEqual(parseMentions("没人", fellows), []);
});

test("parseMentions ignores unknown @names", () => {
  assert.deepEqual(parseMentions("@nobody 在吗", fellows), []);
});

test("parseMentions dedupes", () => {
  assert.deepEqual(parseMentions("@alice @alice 重复", fellows), ["alice"]);
});

test("parseMentions skips escaped \\@name", () => {
  assert.deepEqual(parseMentions("看下 \\@alice 转义", fellows), []);
});

test("filterRecentTurnsForFellow returns last K turns mentioning the fellow", () => {
  const messages = [
    { id: "m1", role: "user", turnId: "t1", mentions: ["alice"], content: "@alice" },
    { id: "m2", role: "fellow", senderFellowId: "alice", turnId: "t1", content: "hi" },
    { id: "m3", role: "user", turnId: "t2", mentions: ["bob"], content: "@bob" },
    { id: "m4", role: "fellow", senderFellowId: "bob", turnId: "t2", content: "yo" },
    { id: "m5", role: "user", turnId: "t3", mentions: ["alice"], content: "@alice 2" },
    { id: "m6", role: "fellow", senderFellowId: "alice", turnId: "t3", content: "hi 2" },
  ];
  const filtered = filterRecentTurnsForFellow(messages, "alice", 3);
  assert.equal(filtered.length, 4);
  assert.deepEqual(filtered.map((m) => m.id), ["m1", "m2", "m5", "m6"]);
});

test("filterRecentTurnsForFellow caps at K most recent matching turns", () => {
  const messages = Array.from({ length: 10 }, (_, i) => ({
    id: "m" + i,
    role: i % 2 === 0 ? "user" : "fellow",
    turnId: "t" + Math.floor(i / 2),
    senderFellowId: i % 2 === 0 ? null : "alice",
    mentions: i % 2 === 0 ? ["alice"] : [],
    content: "msg " + i,
  }));
  const filtered = filterRecentTurnsForFellow(messages, "alice", 2);
  const turnIds = [...new Set(filtered.map((m) => m.turnId))];
  assert.deepEqual(turnIds, ["t3", "t4"]);
});
```

- [ ] **Step 2: 跑测试确认 FAIL**

Run: `npm test`
Expected: `Cannot find module '../src/renderer/group-prompts.js'`

- [ ] **Step 3: 实现这两个函数**

Create `src/renderer/group-prompts.js`:
```js
function parseMentions(content, fellows) {
  const result = [];
  const seen = new Set();
  const nameToId = new Map(fellows.map((f) => [f.name.toLowerCase(), f.id]));
  // \\@ 转义跳过；其他 @name 匹配（name = 字母数字下划线+中日韩字符）
  const regex = /(\\@|@([A-Za-z0-9_一-龥぀-ヿ]+))/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    if (match[1] === "\\@") continue;
    const name = match[2].toLowerCase();
    const id = nameToId.get(name);
    if (id && !seen.has(id)) {
      seen.add(id);
      result.push(id);
    }
  }
  return result;
}

function filterRecentTurnsForFellow(messages, fellowId, k) {
  const turnsTouchingFellow = [];
  const seenTurns = new Set();
  for (const msg of messages) {
    if (seenTurns.has(msg.turnId)) continue;
    const touches =
      (msg.mentions && msg.mentions.includes(fellowId)) ||
      msg.senderFellowId === fellowId;
    if (touches) {
      turnsTouchingFellow.push(msg.turnId);
      seenTurns.add(msg.turnId);
    }
  }
  const lastK = new Set(turnsTouchingFellow.slice(-k));
  return messages.filter((m) => lastK.has(m.turnId));
}

module.exports = { parseMentions, filterRecentTurnsForFellow };
```

- [ ] **Step 4: 跑测试确认 PASS**

Run: `npm test`
Expected: 全 PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/group-prompts.js tests/group-prompts.test.js
git commit -m "feat(group): add @ parser and per-fellow context filter"
```

---

## Task 4: Prompt 构造函数（dispatch / summarize / fellow context）

**Files:**
- Modify: `src/renderer/group-prompts.js`
- Modify: `tests/group-prompts.test.js`
- Create: `resources/conductor/default-prompts/dispatch.md`
- Create: `resources/conductor/default-prompts/summarize.md`
- Create: `resources/conductor/default-prompts/nudge.md`

- [ ] **Step 1: 创建 prompt 模板文件**

Create `resources/conductor/default-prompts/dispatch.md`:
```
你正在协调一个多 Fellow 群聊。你的任务：根据最近的群上下文，决定接下来该让哪个或哪几个 Fellow 发言。

群成员（不含用户自己）：
{{members}}

群摘要：
{{summary}}

最近 6 条消息：
{{recent}}

用户刚发了：
{{userMessage}}

输出 JSON，仅一行，格式：
{"speak": ["<fellowId>", ...]}
- 选 0 到 3 个 fellowId
- 选 0 个表示"暂时没人发言合适"
- 不要解释，只输出 JSON
```

Create `resources/conductor/default-prompts/summarize.md`:
```
你正在为一个多 Fellow 群聊维护上下文摘要。你的任务：在不超过 200 字的篇幅内，更新摘要，让接下来加入对话的 Fellow 能快速理解群里在聊什么。

旧摘要：
{{oldSummary}}

新增的消息：
{{newMessages}}

直接输出新摘要正文，不要 metadata、不要前缀、不要 markdown。
```

Create `resources/conductor/default-prompts/nudge.md`:
```
你是群主 {{hostName}}，刚才群里挂了一个目标但话题停滞了。请以你的人设，发一句自然的话推进这个目标——可以 @ 某个成员，或者抛个问题。一句话就好。

目标：
{{goal}}

最近群对话：
{{recent}}
```

- [ ] **Step 2: 追加测试**

Append to `tests/group-prompts.test.js`:
```js
const {
  buildDispatchPrompt,
  buildSummarizePrompt,
  buildFellowGroupContext,
  shouldSummarize,
} = require("../src/renderer/group-prompts.js");

const dispatchTemplate = `members: {{members}}\nsummary: {{summary}}\nrecent: {{recent}}\nuser: {{userMessage}}`;

test("buildDispatchPrompt fills template", () => {
  const out = buildDispatchPrompt(dispatchTemplate, {
    members: [{ id: "a", name: "Alice" }, { id: "b", name: "Bob" }],
    summary: "talking about lunch",
    recentMessages: [
      { role: "user", content: "hi" },
      { role: "fellow", senderFellowId: "a", content: "yo" },
    ],
    fellowNamesById: { a: "Alice", b: "Bob" },
    userMessage: "where to eat",
  });
  assert.match(out, /Alice/);
  assert.match(out, /Bob/);
  assert.match(out, /talking about lunch/);
  assert.match(out, /where to eat/);
});

test("buildSummarizePrompt fills template", () => {
  const tmpl = `old: {{oldSummary}}\nnew: {{newMessages}}`;
  const out = buildSummarizePrompt(tmpl, {
    oldSummary: "they were arguing",
    newMessages: [
      { role: "user", content: "ok fine" },
    ],
    fellowNamesById: { a: "Alice" },
  });
  assert.match(out, /they were arguing/);
  assert.match(out, /ok fine/);
});

test("buildFellowGroupContext returns block ready for engine prefix", () => {
  const block = buildFellowGroupContext({
    groupName: "lunch crew",
    summary: "discussing lunch",
    recentForFellow: [
      { role: "user", content: "@alice", mentions: ["alice"] },
      { role: "fellow", senderFellowId: "alice", content: "yes?" },
    ],
    fellowNamesById: { alice: "Alice" },
  });
  assert.match(block, /lunch crew/);
  assert.match(block, /discussing lunch/);
  assert.match(block, /Alice/);
});

test("shouldSummarize triggers every 4 user turns", () => {
  const card = null;
  const messages = [
    { role: "user", turnId: "t1" },
    { role: "user", turnId: "t2" },
    { role: "user", turnId: "t3" },
  ];
  assert.equal(shouldSummarize({ contextCard: card }, messages), false);

  const four = [...messages, { role: "user", turnId: "t4" }];
  assert.equal(shouldSummarize({ contextCard: card }, four), true);
});

test("shouldSummarize respects last covered message", () => {
  const cardCovering3 = {
    summary: "x",
    summaryUpToMsgId: "m3",
    updatedAt: 0,
  };
  const msgs = [
    { id: "m1", role: "user", turnId: "t1" },
    { id: "m2", role: "user", turnId: "t2" },
    { id: "m3", role: "user", turnId: "t3" },
    { id: "m4", role: "user", turnId: "t4" },
    { id: "m5", role: "user", turnId: "t5" },
    { id: "m6", role: "user", turnId: "t6" },
    { id: "m7", role: "user", turnId: "t7" },
  ];
  assert.equal(shouldSummarize({ contextCard: cardCovering3 }, msgs), true);

  const cardCovering7 = {
    summary: "x",
    summaryUpToMsgId: "m7",
    updatedAt: 0,
  };
  assert.equal(shouldSummarize({ contextCard: cardCovering7 }, msgs), false);
});
```

- [ ] **Step 3: 跑测试确认 FAIL**

Run: `npm test`
Expected: 新增测试 FAIL（函数未导出）

- [ ] **Step 4: 实现新函数**

Append to `src/renderer/group-prompts.js`:
```js
function formatMessagesForPrompt(messages, fellowNamesById) {
  return messages.map((m) => {
    if (m.role === "user") return "用户: " + m.content;
    const name = fellowNamesById[m.senderFellowId] || m.senderFellowId || "Fellow";
    return name + ": " + m.content;
  }).join("\n");
}

function formatMembersForPrompt(members) {
  return members.map((m) => `- ${m.name} (id=${m.id})`).join("\n");
}

function fillTemplate(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    return Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : "";
  });
}

function buildDispatchPrompt(template, ctx) {
  return fillTemplate(template, {
    members: formatMembersForPrompt(ctx.members),
    summary: ctx.summary || "（暂无摘要）",
    recent: formatMessagesForPrompt(ctx.recentMessages, ctx.fellowNamesById),
    userMessage: ctx.userMessage,
  });
}

function buildSummarizePrompt(template, ctx) {
  return fillTemplate(template, {
    oldSummary: ctx.oldSummary || "（首次摘要）",
    newMessages: formatMessagesForPrompt(ctx.newMessages, ctx.fellowNamesById),
  });
}

function buildFellowGroupContext(ctx) {
  const recent = formatMessagesForPrompt(ctx.recentForFellow, ctx.fellowNamesById);
  return [
    "[群上下文]",
    "群名：" + ctx.groupName,
    "群摘要：" + (ctx.summary || "（暂无摘要）"),
    "最近相关消息：",
    recent || "（无）",
    "[/群上下文]",
  ].join("\n");
}

function userTurnsIn(messages) {
  const seen = new Set();
  for (const m of messages) {
    if (m.role === "user") seen.add(m.turnId);
  }
  return seen;
}

function userTurnsAfter(messages, msgId) {
  const idx = messages.findIndex((m) => m.id === msgId);
  if (idx < 0) return userTurnsIn(messages);
  return userTurnsIn(messages.slice(idx + 1));
}

function shouldSummarize(group, messages) {
  const card = group && group.contextCard;
  const turns = card
    ? userTurnsAfter(messages, card.summaryUpToMsgId)
    : userTurnsIn(messages);
  return turns.size >= 4;
}

module.exports = {
  parseMentions,
  filterRecentTurnsForFellow,
  buildDispatchPrompt,
  buildSummarizePrompt,
  buildFellowGroupContext,
  shouldSummarize,
};
```

- [ ] **Step 5: 跑测试 PASS**

Run: `npm test`
Expected: 全 PASS

- [ ] **Step 6: Commit**

```bash
git add src/renderer/group-prompts.js tests/group-prompts.test.js resources/conductor/default-prompts/
git commit -m "feat(group): add prompt builders and summary trigger"
```

---

## Task 5: Conductor 协调层（dispatch + summarize 流程）

**Files:**
- Create: `src/renderer/conductor.js`
- Test: `tests/conductor.test.js`

`conductor.js` 是 renderer 侧的纯协调逻辑——它接收"发起 LLM 调用"的回调（由调用方注入，便于测试 mock 引擎），并按 spec 第 5 节流程跑。

- [ ] **Step 1: 写测试（mock engine）**

Create `tests/conductor.test.js`:
```js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createConductor } = require("../src/renderer/conductor.js");

function mockEngine(responses) {
  const calls = [];
  return {
    calls,
    call: async ({ kind, prompt }) => {
      calls.push({ kind, prompt });
      if (kind in responses) {
        if (responses[kind] instanceof Error) throw responses[kind];
        return responses[kind];
      }
      throw new Error("no mock for kind " + kind);
    },
  };
}

const fellows = [
  { id: "alice", name: "Alice" },
  { id: "bob", name: "Bob" },
];

const dispatchTpl = "members:{{members}} summary:{{summary}} user:{{userMessage}}";
const summarizeTpl = "old:{{oldSummary}} new:{{newMessages}}";

test("explicit @ skips dispatch LLM call", async () => {
  const engine = mockEngine({});
  const conductor = createConductor({
    engineCall: engine.call,
    dispatchTemplate: dispatchTpl,
    summarizeTemplate: summarizeTpl,
  });
  const result = await conductor.decideDispatch({
    group: { id: "g1", members: ["alice", "bob"], hostFellowId: "alice", contextCard: null },
    members: fellows,
    fellowNamesById: { alice: "Alice", bob: "Bob" },
    userMessage: { content: "@alice 看下", mentions: ["alice"], turnId: "t1" },
    messages: [],
  });
  assert.deepEqual(result, { speak: ["alice"] });
  assert.equal(engine.calls.length, 0);
});

test("no @ calls dispatch LLM and parses JSON", async () => {
  const engine = mockEngine({ dispatch: '{"speak":["bob"]}' });
  const conductor = createConductor({
    engineCall: engine.call,
    dispatchTemplate: dispatchTpl,
    summarizeTemplate: summarizeTpl,
  });
  const result = await conductor.decideDispatch({
    group: { id: "g1", members: ["alice", "bob"], hostFellowId: "alice", contextCard: null },
    members: fellows,
    fellowNamesById: { alice: "Alice", bob: "Bob" },
    userMessage: { content: "随便说", mentions: [], turnId: "t1" },
    messages: [],
  });
  assert.deepEqual(result, { speak: ["bob"] });
  assert.equal(engine.calls.length, 1);
  assert.equal(engine.calls[0].kind, "dispatch");
});

test("dispatch failure degrades to no speakers", async () => {
  const engine = mockEngine({ dispatch: new Error("engine down") });
  const conductor = createConductor({
    engineCall: engine.call,
    dispatchTemplate: dispatchTpl,
    summarizeTemplate: summarizeTpl,
  });
  const result = await conductor.decideDispatch({
    group: { id: "g1", members: ["alice", "bob"], hostFellowId: "alice", contextCard: null },
    members: fellows,
    fellowNamesById: { alice: "Alice", bob: "Bob" },
    userMessage: { content: "啥", mentions: [], turnId: "t1" },
    messages: [],
  });
  assert.deepEqual(result, { speak: [], degraded: true });
});

test("dispatch returns non-JSON degrades", async () => {
  const engine = mockEngine({ dispatch: "the answer is alice" });
  const conductor = createConductor({
    engineCall: engine.call,
    dispatchTemplate: dispatchTpl,
    summarizeTemplate: summarizeTpl,
  });
  const result = await conductor.decideDispatch({
    group: { id: "g1", members: ["alice", "bob"], hostFellowId: "alice", contextCard: null },
    members: fellows,
    fellowNamesById: { alice: "Alice", bob: "Bob" },
    userMessage: { content: "啥", mentions: [], turnId: "t1" },
    messages: [],
  });
  assert.deepEqual(result.speak, []);
  assert.equal(result.degraded, true);
});

test("dispatch filters unknown fellow ids", async () => {
  const engine = mockEngine({ dispatch: '{"speak":["alice","unknown"]}' });
  const conductor = createConductor({
    engineCall: engine.call,
    dispatchTemplate: dispatchTpl,
    summarizeTemplate: summarizeTpl,
  });
  const result = await conductor.decideDispatch({
    group: { id: "g1", members: ["alice", "bob"], hostFellowId: "alice", contextCard: null },
    members: fellows,
    fellowNamesById: { alice: "Alice", bob: "Bob" },
    userMessage: { content: "啥", mentions: [], turnId: "t1" },
    messages: [],
  });
  assert.deepEqual(result.speak, ["alice"]);
});

test("summarize returns new card", async () => {
  const engine = mockEngine({ summarize: "  they decided on pasta  " });
  const conductor = createConductor({
    engineCall: engine.call,
    dispatchTemplate: dispatchTpl,
    summarizeTemplate: summarizeTpl,
  });
  const msgs = [
    { id: "m1", role: "user", turnId: "t1", content: "lunch?" },
    { id: "m2", role: "fellow", senderFellowId: "alice", turnId: "t1", content: "pasta" },
  ];
  const card = await conductor.summarize({
    group: { id: "g1", contextCard: null },
    fellowNamesById: { alice: "Alice" },
    messages: msgs,
  });
  assert.equal(card.summary, "they decided on pasta");
  assert.equal(card.summaryUpToMsgId, "m2");
  assert.ok(card.updatedAt > 0);
});

test("summarize failure returns null (caller keeps old card)", async () => {
  const engine = mockEngine({ summarize: new Error("engine down") });
  const conductor = createConductor({
    engineCall: engine.call,
    dispatchTemplate: dispatchTpl,
    summarizeTemplate: summarizeTpl,
  });
  const card = await conductor.summarize({
    group: { id: "g1", contextCard: null },
    fellowNamesById: {},
    messages: [{ id: "m1", role: "user", turnId: "t1", content: "x" }],
  });
  assert.equal(card, null);
});
```

- [ ] **Step 2: 跑测试确认 FAIL**

Run: `npm test`
Expected: `Cannot find module '../src/renderer/conductor.js'`

- [ ] **Step 3: 实现 conductor.js**

Create `src/renderer/conductor.js`:
```js
const {
  buildDispatchPrompt,
  buildSummarizePrompt,
} = require("./group-prompts.js");

function safeParseJSON(text) {
  if (!text || typeof text !== "string") return null;
  try {
    const match = text.match(/\{[^}]*"speak"[^}]*\}/);
    if (!match) return null;
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

function createConductor({ engineCall, dispatchTemplate, summarizeTemplate }) {
  async function decideDispatch(ctx) {
    if (ctx.userMessage.mentions && ctx.userMessage.mentions.length > 0) {
      const valid = ctx.userMessage.mentions.filter((id) =>
        ctx.group.members.includes(id)
      );
      return { speak: valid };
    }
    const prompt = buildDispatchPrompt(dispatchTemplate, {
      members: ctx.members,
      summary: ctx.group.contextCard ? ctx.group.contextCard.summary : null,
      recentMessages: (ctx.messages || []).slice(-6),
      fellowNamesById: ctx.fellowNamesById,
      userMessage: ctx.userMessage.content,
    });
    let raw;
    try {
      raw = await engineCall({ kind: "dispatch", prompt, group: ctx.group });
    } catch {
      return { speak: [], degraded: true };
    }
    const parsed = safeParseJSON(raw);
    if (!parsed || !Array.isArray(parsed.speak)) {
      return { speak: [], degraded: true };
    }
    const valid = parsed.speak.filter((id) => ctx.group.members.includes(id));
    return { speak: valid };
  }

  async function summarize(ctx) {
    const oldCard = ctx.group.contextCard;
    const oldSummary = oldCard ? oldCard.summary : null;
    const cutoff = oldCard ? oldCard.summaryUpToMsgId : null;
    const newMessages = cutoff
      ? ctx.messages.slice(ctx.messages.findIndex((m) => m.id === cutoff) + 1)
      : ctx.messages;
    if (newMessages.length === 0) return null;

    const prompt = buildSummarizePrompt(summarizeTemplate, {
      oldSummary,
      newMessages,
      fellowNamesById: ctx.fellowNamesById,
    });

    let raw;
    try {
      raw = await engineCall({ kind: "summarize", prompt, group: ctx.group });
    } catch {
      return null;
    }
    if (!raw || typeof raw !== "string") return null;
    const lastMsg = ctx.messages[ctx.messages.length - 1];
    return {
      summary: raw.trim(),
      summaryUpToMsgId: lastMsg.id,
      updatedAt: Date.now(),
    };
  }

  return { decideDispatch, summarize };
}

module.exports = { createConductor };
```

- [ ] **Step 4: 跑测试 PASS**

Run: `npm test`
Expected: 全 PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/conductor.js tests/conductor.test.js
git commit -m "feat(group): add conductor for dispatch and summarize"
```

---

## Task 6: 跨引擎 group adapters（Hermes header + CC/Codex prefix）

**Files:**
- Create: `src/main/group-adapters.js`
- Test: `tests/group-adapters.test.js`

`group-adapters.js` 提供两类函数：
- `buildHermesGroupHeader(groupContextBlock)` → 返回 `X-Aimashi-Group-Context` header 值（base64 编码 JSON）
- `injectGroupContextForSdk(originalUserMessage, groupContextBlock)` → 返回拼接好的 user message 给 Claude Code / Codex SDK 用（两边格式一样，复用同一个函数）

- [ ] **Step 1: 写测试**

Create `tests/group-adapters.test.js`:
```js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  buildHermesGroupHeader,
  injectGroupContextForSdk,
} = require("../src/main/group-adapters.js");

test("buildHermesGroupHeader returns base64-encoded JSON", () => {
  const header = buildHermesGroupHeader("[群上下文]\n群名：测试\n[/群上下文]");
  const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  assert.equal(decoded.contextBlock, "[群上下文]\n群名：测试\n[/群上下文]");
  assert.equal(decoded.v, 1);
});

test("buildHermesGroupHeader empty block returns empty string", () => {
  assert.equal(buildHermesGroupHeader(""), "");
  assert.equal(buildHermesGroupHeader(null), "");
});

test("injectGroupContextForSdk prepends context block", () => {
  const out = injectGroupContextForSdk("帮我看下", "[群上下文]\n群名：x\n[/群上下文]");
  assert.match(out, /^\[群上下文\]/);
  assert.match(out, /帮我看下$/);
});

test("injectGroupContextForSdk no block returns original", () => {
  assert.equal(injectGroupContextForSdk("hello", ""), "hello");
  assert.equal(injectGroupContextForSdk("hello", null), "hello");
});
```

- [ ] **Step 2: 跑测试 FAIL**

Run: `npm test`
Expected: `Cannot find module`

- [ ] **Step 3: 实现**

Create `src/main/group-adapters.js`:
```js
function buildHermesGroupHeader(contextBlock) {
  if (!contextBlock) return "";
  const payload = JSON.stringify({ v: 1, contextBlock });
  return Buffer.from(payload, "utf8").toString("base64");
}

function injectGroupContextForSdk(userMessage, contextBlock) {
  if (!contextBlock) return userMessage;
  return contextBlock + "\n\n" + userMessage;
}

module.exports = { buildHermesGroupHeader, injectGroupContextForSdk };
```

- [ ] **Step 4: 跑测试 PASS**

Run: `npm test`
Expected: 全 PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/group-adapters.js tests/group-adapters.test.js
git commit -m "feat(group): add cross-engine group context adapters"
```

---

## Task 7: 扩展 fellow_overlay.py 识别 X-Aimashi-Group-Context

**Files:**
- Modify: `runtime/hermes-engine/aimashi_plugins/fellow_overlay.py`（在用户机器上是 `~/Library/Application Support/Aimashi/runtime/hermes-engine/aimashi_plugins/fellow_overlay.py`；源在 vendor 或 build script，需先确认）

- [ ] **Step 1: 定位 fellow_overlay.py 源**

Run: `find . -name "fellow_overlay.py" -not -path "*/node_modules/*" 2>/dev/null`
Expected: 至少一条命中路径

如果找到的是 runtime 产物路径（不在 repo），翻 `scripts/build-hermes-runtime.sh` 看模板从哪儿拷贝。把模板路径记下来（设为 `<OVERLAY_SOURCE>`）。

- [ ] **Step 2: 读取现有 fellow_overlay.py 行为**

Run: `cat <OVERLAY_SOURCE>`
确认它如何读 `X-Aimashi-Fellow` header 并注入 system prompt。新逻辑要在同一处加。

- [ ] **Step 3: 加 group context 注入**

Edit `<OVERLAY_SOURCE>`：

在现有 `X-Aimashi-Fellow` header 处理之后，加入：
```python
import base64
import json

def _read_group_context(headers):
    raw = headers.get("X-Aimashi-Group-Context") or headers.get("x-aimashi-group-context")
    if not raw:
        return None
    try:
        decoded = base64.b64decode(raw).decode("utf-8")
        payload = json.loads(decoded)
        if payload.get("v") != 1:
            return None
        return payload.get("contextBlock")
    except Exception:
        return None

# 在 fellow overlay 拼 system prompt 的地方追加：
group_ctx = _read_group_context(request_headers)
if group_ctx:
    system_prompt = system_prompt + "\n\n" + group_ctx
```

具体融入位置由步骤 2 的阅读结果决定——把 `group_ctx` 追加到现有 `system_prompt` 拼装的最后。

- [ ] **Step 4: 手动 sanity check**

Run（在 Python 环境里）：
```bash
python3 -c "
import base64, json
header = base64.b64encode(json.dumps({'v':1,'contextBlock':'hello'}).encode()).decode()
print('header value:', header)
"
```

记下 header 输出，准备集成测试时用。

- [ ] **Step 5: Commit**

```bash
git add <OVERLAY_SOURCE>
git commit -m "feat(hermes-overlay): inject X-Aimashi-Group-Context into system prompt"
```

如果 `<OVERLAY_SOURCE>` 不在 aimashi repo（属于 vendor 的 hermes runtime 子项目），按那个 repo 的提交规范单独提交，并记录 commit hash 以备 aimashi 升级 Hermes 版本时引用。

---

## Task 8: Main 进程 IPC handlers

**Files:**
- Modify: `src/main.js`
- Create: 注意 `src/main/group-store.js` 已存在，需要 `src/main/` 目录引入 main.js

阅读 `src/main.js` 中 `chat:` / `fellow:` 系列 IPC handler 的注册位置，按相同风格加 `group:` 系列。

- [ ] **Step 1: 定位 chat IPC handler 注册块**

Run: `grep -n 'ipcMain.handle.*chat:' src/main.js | head`

记录起止行号，新 handler 放在同一段后面。

- [ ] **Step 2: 加 group-store 初始化**

在 `src/main.js` 头部 imports 区找到现有 `engine-home` path 解析逻辑，复用它定位 groups root：

```js
const { createGroupStore } = require("./main/group-store.js");
const { buildHermesGroupHeader, injectGroupContextForSdk } = require("./main/group-adapters.js");

let groupStore = null;
function ensureGroupStore() {
  if (groupStore) return groupStore;
  const root = path.join(getEngineHomeDir(), "groups");
  groupStore = createGroupStore(root);
  return groupStore;
}
```

（`getEngineHomeDir` 是现有函数，名字可能不同——按你在 main.js 里看到的解析 engine-home 的工具函数命名。）

- [ ] **Step 3: 注册 group IPC handlers**

在 chat handler 注册块之后追加：
```js
ipcMain.handle("group:create", (_e, payload) => {
  return ensureGroupStore().create(payload);
});
ipcMain.handle("group:list", () => {
  return ensureGroupStore().list();
});
ipcMain.handle("group:get", (_e, id) => {
  return ensureGroupStore().get(id);
});
ipcMain.handle("group:update", (_e, { id, patch }) => {
  return ensureGroupStore().updateGroup(id, patch);
});
ipcMain.handle("group:append-message", (_e, { id, message }) => {
  ensureGroupStore().appendMessage(id, message);
  return true;
});
ipcMain.handle("group:list-messages", (_e, id) => {
  return ensureGroupStore().listMessages(id);
});
ipcMain.handle("group:save-context-card", (_e, { id, card }) => {
  ensureGroupStore().saveContextCard(id, card);
  return true;
});
```

注意：群里**发送消息触发引擎调用**这一条不走 store 写入 + IPC 直接搞定，而是复用现有 `chat:send` handler 加 group 上下文参数——见 Task 9。

- [ ] **Step 4: Smoke test**

Run: `npm run check`
Expected: PASS（仅做文件存在 + 语法检查）

启动一次确认无运行时错误：
Run: `npm start`
打开 DevTools 验证 `window.aimashi.groups` 即将存在（Task 9 之后）。先关掉。

- [ ] **Step 5: Commit**

```bash
git add src/main.js
git commit -m "feat(group): register group IPC handlers in main process"
```

---

## Task 9: Preload 暴露 aimashi.groups.* API

**Files:**
- Modify: `src/preload.js`
- Modify: `src/check.js`（把 main/group-store.js、main/group-adapters.js 等加入 required 列表）

- [ ] **Step 1: 扩展 preload**

Edit `src/preload.js`，在 `contextBridge.exposeInMainWorld("aimashi", { ... })` 的对象里，紧邻现有 `fellow*` API 之后添加：
```js
groups: {
  create: (payload) => ipcRenderer.invoke("group:create", payload),
  list: () => ipcRenderer.invoke("group:list"),
  get: (id) => ipcRenderer.invoke("group:get", id),
  update: (id, patch) => ipcRenderer.invoke("group:update", { id, patch }),
  appendMessage: (id, message) => ipcRenderer.invoke("group:append-message", { id, message }),
  listMessages: (id) => ipcRenderer.invoke("group:list-messages", id),
  saveContextCard: (id, card) => ipcRenderer.invoke("group:save-context-card", { id, card }),
},
```

- [ ] **Step 2: 把新文件加入 check.js**

Edit `src/check.js`，扩展 `required` 数组：
```js
"src/main/group-store.js",
"src/main/group-adapters.js",
"src/renderer/group.js",
"src/renderer/conductor.js",
"src/renderer/group-prompts.js",
"resources/conductor/default-prompts/dispatch.md",
"resources/conductor/default-prompts/summarize.md",
"resources/conductor/default-prompts/nudge.md",
```

（注：`src/renderer/group.js` 在 Task 12 才创建，可暂时先不加，等到 Task 12 再补；这里只加已存在的）

- [ ] **Step 3: 跑 check**

Run: `npm run check`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/preload.js src/check.js
git commit -m "feat(group): expose aimashi.groups API via preload"
```

---

## Task 10: chat:send 扩展支持 group context

**Files:**
- Modify: `src/main.js`（chat:send handler）

`chat:send` 现有签名（按现有 payload 结构推断，需先读源代码确认）接受 `{ fellowKey, messages, ... }`。要加可选的 `group: { id, contextBlock }` 字段。当存在时：
- Hermes engine：注入 `X-Aimashi-Group-Context` header
- Claude Code / Codex engine：把 `contextBlock` 前置到最后一条 user message

- [ ] **Step 1: 阅读现有 chat:send 实现**

Run: `grep -nA 5 'ipcMain.handle("chat:send"' src/main.js`

读完这个 handler 全部内容（一般会调用 fellow → engine 派发函数），定位三条引擎分支：Hermes、Claude Code、Codex。

- [ ] **Step 2: 扩展 payload 解构**

在 handler 最开始，从 payload 解出 `group`：
```js
const { fellowKey, messages, group, ...rest } = payload;
```

- [ ] **Step 3: 注入 Hermes header**

在 Hermes 分支拼请求 headers 的地方加：
```js
if (group && group.contextBlock) {
  headers["X-Aimashi-Group-Context"] = buildHermesGroupHeader(group.contextBlock);
}
```

- [ ] **Step 4: 注入 SDK prefix**

在 Claude Code 和 Codex 分支调用 SDK 前，对 user message 做前置：
```js
const lastIdx = messages.length - 1;
if (group && group.contextBlock && lastIdx >= 0 && messages[lastIdx].role === "user") {
  messages[lastIdx] = {
    ...messages[lastIdx],
    content: injectGroupContextForSdk(messages[lastIdx].content, group.contextBlock),
  };
}
```

- [ ] **Step 5: Smoke test**

Run: `npm run check && npm test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/main.js
git commit -m "feat(group): chat:send accepts optional group context for all engines"
```

---

## Task 11: 加载 prompt templates 的工具函数

**Files:**
- Modify: `src/main.js`（加 IPC `group:prompts` 返回模板字符串）
- Modify: `src/preload.js`（加 `aimashi.groups.loadPrompts`）

- [ ] **Step 1: 加 IPC handler**

Edit `src/main.js`，在 group handler 块加：
```js
ipcMain.handle("group:load-prompts", () => {
  const dir = path.join(__dirname, "..", "resources", "conductor", "default-prompts");
  return {
    dispatch: fs.readFileSync(path.join(dir, "dispatch.md"), "utf8"),
    summarize: fs.readFileSync(path.join(dir, "summarize.md"), "utf8"),
    nudge: fs.readFileSync(path.join(dir, "nudge.md"), "utf8"),
  };
});
```

（`__dirname` 在 main.js 里是 `src/`，所以 `..` 回到 repo root。如果 main.js 已经有 path resolver helper，用它。）

- [ ] **Step 2: 扩展 preload**

Edit `src/preload.js`，在 `groups: { ... }` 块里加：
```js
loadPrompts: () => ipcRenderer.invoke("group:load-prompts"),
```

- [ ] **Step 3: Smoke test**

Run: `npm run check`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/main.js src/preload.js
git commit -m "feat(group): expose default conductor prompts via IPC"
```

---

## Task 12: Renderer 入口 group.js + 侧边栏渲染

**Files:**
- Create: `src/renderer/group.js`
- Modify: `src/renderer/app.js`
- Modify: `src/renderer/index.html`
- Modify: `src/renderer/styles.css`
- Modify: `src/check.js`（把 group.js 加入 required）

`group.js` 是 renderer 侧群聊总模块。**不引入新框架**——按 `pet.js` 风格写：导出 `initGroupModule(state, els, deps)`，在 `app.js` 启动时调用一次，模块内部维护自己的 substate。

由于 app.js 已经 6681 行，新群逻辑放 group.js 比塞进 app.js 更可维护。

- [ ] **Step 1: 创建 group.js 骨架**

Create `src/renderer/group.js`:
```js
// Renderer-side group chat module.
// Loaded by app.js after preload is ready; mounts on DOM elements created in index.html.

(function (global) {
  const { parseMentions, filterRecentTurnsForFellow, buildFellowGroupContext, shouldSummarize } =
    typeof require !== "undefined"
      ? require("./group-prompts.js")
      : global.aimashiGroupPrompts;

  const { createConductor } =
    typeof require !== "undefined"
      ? require("./conductor.js")
      : global.aimashiConductor;

  const moduleState = {
    groups: [],
    activeGroupId: null,
    messagesByGroup: new Map(),
    fellows: [],
    fellowNamesById: {},
    promptTemplates: null,
    conductor: null,
  };

  async function initGroupModule(deps) {
    moduleState.fellows = deps.getFellows();
    moduleState.fellowNamesById = Object.fromEntries(
      moduleState.fellows.map((f) => [f.id, f.name])
    );
    moduleState.promptTemplates = await window.aimashi.groups.loadPrompts();
    moduleState.groups = await window.aimashi.groups.list();
    moduleState.conductor = createConductor({
      engineCall: deps.engineCall,
      dispatchTemplate: moduleState.promptTemplates.dispatch,
      summarizeTemplate: moduleState.promptTemplates.summarize,
    });
    renderGroupSidebarEntries();
  }

  function renderGroupSidebarEntries() {
    // To be implemented in this task: render group items in sidebar.
    // Each group is shown with composite avatar of its members.
  }

  function openGroup(groupId) {
    // To be implemented in Task 13.
  }

  global.aimashiGroup = {
    initGroupModule,
    renderGroupSidebarEntries,
    openGroup,
    moduleState,
  };
})(window);
```

- [ ] **Step 2: 写 sidebar 渲染**

在 `group.js` 里实现 `renderGroupSidebarEntries`：
```js
function renderGroupSidebarEntries() {
  const container = document.getElementById("group-sidebar-list");
  if (!container) return;
  container.innerHTML = "";
  for (const group of moduleState.groups) {
    const item = document.createElement("div");
    item.className = "sidebar-item group-item";
    item.dataset.groupId = group.id;
    item.addEventListener("click", () => openGroup(group.id));

    const avatar = document.createElement("div");
    avatar.className = "group-avatar composite";
    const memberAvatars = group.members.slice(0, 4);
    for (const memberId of memberAvatars) {
      const sub = document.createElement("div");
      sub.className = "group-avatar-sub";
      sub.textContent = (moduleState.fellowNamesById[memberId] || "?")[0];
      avatar.appendChild(sub);
    }
    item.appendChild(avatar);

    const meta = document.createElement("div");
    meta.className = "sidebar-item-meta";
    const title = document.createElement("div");
    title.className = "sidebar-item-title";
    title.textContent = group.name;
    meta.appendChild(title);
    const memberLine = document.createElement("div");
    memberLine.className = "sidebar-item-subtitle";
    memberLine.textContent = group.members
      .map((id) => moduleState.fellowNamesById[id] || id)
      .join(", ");
    meta.appendChild(memberLine);
    item.appendChild(meta);

    container.appendChild(item);
  }
}
```

- [ ] **Step 3: 加 DOM 锚点和样式**

Edit `src/renderer/index.html`，在现有侧边栏 fellow 列表附近加一个 container（具体位置由现有 sidebar 结构决定，参考 fellow 列表）：
```html
<div class="sidebar-section">
  <div class="sidebar-section-title">群聊</div>
  <div id="group-sidebar-list"></div>
  <button id="group-create-button" class="sidebar-action">+ 新建群聊</button>
</div>
```

Edit `src/renderer/styles.css`，追加：
```css
.group-avatar.composite {
  display: grid;
  grid-template-columns: 1fr 1fr;
  grid-template-rows: 1fr 1fr;
  width: 32px; height: 32px;
  border-radius: 8px;
  overflow: hidden;
  background: var(--bg-soft, #eee);
}
.group-avatar-sub {
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  color: #555;
  background: var(--bg-elevated, #fff);
}
.sidebar-section { margin-top: 16px; }
.sidebar-section-title {
  font-size: 11px;
  text-transform: uppercase;
  color: var(--text-muted, #888);
  padding: 0 12px 4px;
}
.sidebar-action {
  width: 100%;
  text-align: left;
  padding: 6px 12px;
  background: transparent;
  border: 0;
  color: var(--text-muted, #888);
  cursor: pointer;
}
.sidebar-action:hover { color: var(--text, #222); }
```

- [ ] **Step 4: 在 app.js 启动时挂载**

Edit `src/renderer/app.js`，找到现有"启动 / 初始化"块（搜 `await window.aimashi.runtimeStatus` 或类似入口），在初始化 fellow 列表之后加：
```js
if (window.aimashiGroup) {
  await window.aimashiGroup.initGroupModule({
    getFellows: () => state.fellows || [],
    engineCall: async ({ kind, prompt, group }) => {
      // Route via existing chat:send IPC using host fellow's engine
      // Implemented in Task 14
      throw new Error("engineCall not wired yet (Task 14)");
    },
  });
}
```

Edit `src/renderer/index.html`，在加载 `app.js` 之前先加载 `group-prompts.js`、`conductor.js`、`group.js`：
```html
<script src="./group-prompts.js"></script>
<script src="./conductor.js"></script>
<script src="./group.js"></script>
<script src="./app.js"></script>
```

但 group-prompts.js 和 conductor.js 都用了 `require`——在 renderer 直接 `<script>` 加载会报错。需要让它们既能 require 又能在 browser 模式下挂全局。把这两个文件的导出改为：
```js
// group-prompts.js 末尾改：
if (typeof module !== "undefined" && module.exports) {
  module.exports = { parseMentions, filterRecentTurnsForFellow, buildDispatchPrompt, buildSummarizePrompt, buildFellowGroupContext, shouldSummarize };
}
if (typeof window !== "undefined") {
  window.aimashiGroupPrompts = { parseMentions, filterRecentTurnsForFellow, buildDispatchPrompt, buildSummarizePrompt, buildFellowGroupContext, shouldSummarize };
}
```

同样改 `conductor.js`：
```js
if (typeof module !== "undefined" && module.exports) {
  module.exports = { createConductor };
}
if (typeof window !== "undefined") {
  window.aimashiConductor = { createConductor };
}
```

并把每个文件顶部的 require 包成可选：
```js
// group-prompts.js 顶部不需要 require，是叶子模块。
// conductor.js 顶部改：
const promptsModule =
  typeof require !== "undefined"
    ? require("./group-prompts.js")
    : window.aimashiGroupPrompts;
const { buildDispatchPrompt, buildSummarizePrompt } = promptsModule;
```

注意：Electron renderer 在 preload + contextIsolation 下，renderer 本身不能 `require` Node 模块。所以**这三个文件在 renderer 里**走 `<script>` + window globals 模式；**在 tests 和 main 进程里**走 CommonJS require。

把 `group.js` 顶部也对应改：
```js
const promptsModule =
  typeof require !== "undefined"
    ? require("./group-prompts.js")
    : window.aimashiGroupPrompts;
const conductorModule =
  typeof require !== "undefined"
    ? require("./conductor.js")
    : window.aimashiConductor;
const { parseMentions, filterRecentTurnsForFellow, buildFellowGroupContext, shouldSummarize } = promptsModule;
const { createConductor } = conductorModule;
```

- [ ] **Step 5: 把 group.js 加入 check.js required**

Edit `src/check.js` required 数组加：
```js
"src/renderer/group.js",
```

- [ ] **Step 6: Smoke test**

Run: `npm run check && npm test && npm start`
Expected:
- check PASS
- tests PASS（之前所有测试不应回归）
- npm start 启动，DevTools console 无 require/未定义错误，侧边栏出现"群聊"段（暂时是空列表 + 创建按钮）

关掉 app。

- [ ] **Step 7: Commit**

```bash
git add src/renderer/group.js src/renderer/group-prompts.js src/renderer/conductor.js src/renderer/index.html src/renderer/app.js src/renderer/styles.css src/check.js
git commit -m "feat(group): mount group module and render sidebar entries"
```

---

## Task 13: 创建群对话框

**Files:**
- Modify: `src/renderer/group.js`
- Modify: `src/renderer/index.html`
- Modify: `src/renderer/styles.css`

- [ ] **Step 1: 加 dialog DOM**

Edit `src/renderer/index.html`，在 `<body>` 末尾加：
```html
<div id="group-create-dialog" class="modal hidden">
  <div class="modal-backdrop"></div>
  <div class="modal-panel">
    <div class="modal-title">新建群聊</div>
    <div class="modal-section">
      <div class="modal-section-title">选择成员（2-5 个）</div>
      <div id="group-create-members"></div>
    </div>
    <div class="modal-section">
      <div class="modal-section-title">群主（默认第一个）</div>
      <select id="group-create-host"></select>
    </div>
    <div class="modal-section">
      <div class="modal-section-title">群名</div>
      <input id="group-create-name" type="text" maxlength="40" />
    </div>
    <div class="modal-actions">
      <button id="group-create-cancel">取消</button>
      <button id="group-create-confirm" class="primary">创建</button>
    </div>
  </div>
</div>
```

Edit `src/renderer/styles.css` 加最小 modal 样式（如果 styles.css 已经有 `.modal` 复用，跳过；否则补一段最小可用样式）。

- [ ] **Step 2: 实现对话框逻辑**

Add to `src/renderer/group.js`:
```js
function openCreateDialog() {
  const dialog = document.getElementById("group-create-dialog");
  const membersBox = document.getElementById("group-create-members");
  const hostSelect = document.getElementById("group-create-host");
  const nameInput = document.getElementById("group-create-name");
  const confirmBtn = document.getElementById("group-create-confirm");
  const cancelBtn = document.getElementById("group-create-cancel");

  const selected = new Set();
  membersBox.innerHTML = "";
  for (const fellow of moduleState.fellows) {
    const row = document.createElement("label");
    row.className = "checkbox-row";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.value = fellow.id;
    cb.addEventListener("change", () => {
      if (cb.checked) selected.add(fellow.id);
      else selected.delete(fellow.id);
      refreshHostOptions();
    });
    row.appendChild(cb);
    const label = document.createElement("span");
    label.textContent = fellow.name;
    row.appendChild(label);
    membersBox.appendChild(row);
  }

  function refreshHostOptions() {
    hostSelect.innerHTML = "";
    for (const id of selected) {
      const opt = document.createElement("option");
      opt.value = id;
      opt.textContent = moduleState.fellowNamesById[id] || id;
      hostSelect.appendChild(opt);
    }
  }

  nameInput.value = "";
  dialog.classList.remove("hidden");

  function close() {
    dialog.classList.add("hidden");
    confirmBtn.removeEventListener("click", onConfirm);
    cancelBtn.removeEventListener("click", close);
  }

  async function onConfirm() {
    const members = [...selected];
    if (members.length < 2 || members.length > 5) {
      alert("成员数必须在 2 到 5 之间");
      return;
    }
    const hostFellowId = hostSelect.value || members[0];
    const name = nameInput.value.trim() || members
      .map((id) => moduleState.fellowNamesById[id] || id)
      .join(" · ");
    try {
      const group = await window.aimashi.groups.create({ name, members, hostFellowId });
      moduleState.groups.push(group);
      renderGroupSidebarEntries();
      close();
      openGroup(group.id);
    } catch (e) {
      alert("建群失败：" + e.message);
    }
  }

  confirmBtn.addEventListener("click", onConfirm);
  cancelBtn.addEventListener("click", close);
}

// At the end of init, bind button:
function bindCreateButton() {
  const btn = document.getElementById("group-create-button");
  if (btn) btn.addEventListener("click", openCreateDialog);
}
```

修改 `initGroupModule` 末尾调用 `bindCreateButton()`。

- [ ] **Step 3: Smoke test**

Run: `npm start`，点"+ 新建群聊"，验证 dialog 弹出、勾选 → host 下拉填充、点创建 → 侧边栏出现新条目。

- [ ] **Step 4: Commit**

```bash
git add src/renderer/group.js src/renderer/index.html src/renderer/styles.css
git commit -m "feat(group): add create group dialog"
```

---

## Task 14: 群聊视图 + @ composer + 发送流（含 conductor.engineCall 接线）

**Files:**
- Modify: `src/renderer/group.js`
- Modify: `src/renderer/index.html`
- Modify: `src/renderer/styles.css`

这是最关键的一 task：把侧边栏点击 → 打开群 → 渲染消息 → 用户发送 → conductor 决定 → dispatch 到 fellow → 流式响应 → 写回 → 触发摘要，整条链路跑通。

- [ ] **Step 1: 加群视图 DOM**

Edit `src/renderer/index.html`，在主内容区加：
```html
<div id="group-view" class="chat-view hidden">
  <div id="group-view-header">
    <div id="group-view-title"></div>
    <button id="group-view-info">i</button>
  </div>
  <div id="group-message-list"></div>
  <div id="group-composer">
    <textarea id="group-input" placeholder="输入消息，@ 选择 Fellow"></textarea>
    <button id="group-send">发送</button>
  </div>
  <div id="group-mention-picker" class="mention-picker hidden"></div>
</div>
```

- [ ] **Step 2: 实现 openGroup**

Add to `src/renderer/group.js`:
```js
async function openGroup(groupId) {
  const group = moduleState.groups.find((g) => g.id === groupId);
  if (!group) return;
  moduleState.activeGroupId = groupId;

  // Hide 1v1 view; show group view
  document.querySelectorAll(".chat-view").forEach((v) => v.classList.add("hidden"));
  const view = document.getElementById("group-view");
  view.classList.remove("hidden");

  document.getElementById("group-view-title").textContent = group.name;

  const messages = await window.aimashi.groups.listMessages(groupId);
  moduleState.messagesByGroup.set(groupId, messages);
  renderGroupMessages(group, messages);
  bindComposer(group);
}

function renderGroupMessages(group, messages) {
  const list = document.getElementById("group-message-list");
  list.innerHTML = "";
  for (const msg of messages) {
    const row = document.createElement("div");
    row.className = "group-msg group-msg-" + msg.role;
    if (msg.role === "fellow") {
      const name = moduleState.fellowNamesById[msg.senderFellowId] || msg.senderFellowId;
      const isHost = msg.senderFellowId === group.hostFellowId;
      const header = document.createElement("div");
      header.className = "group-msg-sender";
      header.textContent = name + (isHost ? " 👑" : "");
      row.appendChild(header);
    }
    const body = document.createElement("div");
    body.className = "group-msg-body";
    body.textContent = msg.content;
    if (msg.status === "error") body.classList.add("error");
    row.appendChild(body);
    list.appendChild(row);
  }
  list.scrollTop = list.scrollHeight;
}
```

- [ ] **Step 3: 实现 composer 和 send**

Add to `src/renderer/group.js`:
```js
function bindComposer(group) {
  const input = document.getElementById("group-input");
  const sendBtn = document.getElementById("group-send");
  const fresh = sendBtn.cloneNode(true);
  sendBtn.parentNode.replaceChild(fresh, sendBtn);
  const newSendBtn = document.getElementById("group-send");

  newSendBtn.addEventListener("click", () => sendInGroup(group));

  const freshInput = input.cloneNode(true);
  input.parentNode.replaceChild(freshInput, input);
  document.getElementById("group-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      sendInGroup(group);
    }
    if (e.key === "@") {
      showMentionPicker(group);
    }
  });
}

function showMentionPicker(group) {
  const picker = document.getElementById("group-mention-picker");
  picker.innerHTML = "";
  for (const memberId of group.members) {
    const item = document.createElement("div");
    item.className = "mention-item";
    item.textContent = "@" + (moduleState.fellowNamesById[memberId] || memberId);
    item.addEventListener("click", () => {
      const input = document.getElementById("group-input");
      input.value = input.value + (moduleState.fellowNamesById[memberId] || memberId) + " ";
      picker.classList.add("hidden");
      input.focus();
    });
    picker.appendChild(item);
  }
  picker.classList.remove("hidden");
}

async function sendInGroup(group) {
  const input = document.getElementById("group-input");
  const text = input.value.trim();
  if (!text) return;
  input.value = "";

  const turnId = "t-" + Date.now();
  const userMsg = {
    id: "m-" + Date.now(),
    groupId: group.id,
    role: "user",
    content: text,
    mentions: parseMentions(text, moduleState.fellows.filter((f) => group.members.includes(f.id))),
    turnId,
    createdAt: Date.now(),
    status: "complete",
  };
  await window.aimashi.groups.appendMessage(group.id, userMsg);
  const msgs = moduleState.messagesByGroup.get(group.id) || [];
  msgs.push(userMsg);
  renderGroupMessages(group, msgs);

  const members = moduleState.fellows.filter((f) => group.members.includes(f.id));
  const dispatch = await moduleState.conductor.decideDispatch({
    group,
    members,
    fellowNamesById: moduleState.fellowNamesById,
    userMessage: userMsg,
    messages: msgs,
  });

  if (dispatch.degraded) {
    const sysMsg = {
      id: "m-" + Date.now() + "-sys",
      groupId: group.id,
      role: "system",
      content: "群助手暂时不在线，没 @ 到的消息暂不会被回应",
      mentions: [],
      turnId,
      createdAt: Date.now(),
      status: "complete",
    };
    await window.aimashi.groups.appendMessage(group.id, sysMsg);
    msgs.push(sysMsg);
    renderGroupMessages(group, msgs);
    return;
  }

  await Promise.all(dispatch.speak.map((fellowId) =>
    dispatchToFellow(group, fellowId, userMsg, turnId)
  ));

  await maybeUpdateSummary(group);
}

async function dispatchToFellow(group, fellowId, userMsg, turnId) {
  const msgs = moduleState.messagesByGroup.get(group.id) || [];
  const recent = filterRecentTurnsForFellow(msgs, fellowId, 3);
  const contextBlock = buildFellowGroupContext({
    groupName: group.name,
    summary: group.contextCard ? group.contextCard.summary : null,
    recentForFellow: recent,
    fellowNamesById: moduleState.fellowNamesById,
  });

  const placeholderMsg = {
    id: "m-" + Date.now() + "-" + fellowId,
    groupId: group.id,
    role: "fellow",
    senderFellowId: fellowId,
    content: "",
    mentions: [],
    turnId,
    createdAt: Date.now(),
    status: "streaming",
  };
  msgs.push(placeholderMsg);
  renderGroupMessages(group, msgs);

  try {
    const result = await window.aimashi.sendChat({
      fellowKey: fellowId,
      messages: [{ role: "user", content: userMsg.content }],
      group: { id: group.id, contextBlock },
    });
    placeholderMsg.content = result.content || result.text || "";
    placeholderMsg.status = "complete";
  } catch (e) {
    placeholderMsg.content = "（响应失败：" + e.message + "）";
    placeholderMsg.status = "error";
  }
  await window.aimashi.groups.appendMessage(group.id, placeholderMsg);
  renderGroupMessages(group, msgs);
}

async function maybeUpdateSummary(group) {
  const msgs = moduleState.messagesByGroup.get(group.id) || [];
  if (!shouldSummarize(group, msgs)) return;
  const card = await moduleState.conductor.summarize({
    group,
    fellowNamesById: moduleState.fellowNamesById,
    messages: msgs,
  });
  if (!card) return;
  group.contextCard = card;
  await window.aimashi.groups.saveContextCard(group.id, card);
}
```

- [ ] **Step 4: 接 conductor.engineCall**

修改 Task 12 留下的 `engineCall` 占位。在 `app.js` 启动初始化里：
```js
await window.aimashiGroup.initGroupModule({
  getFellows: () => state.fellows || [],
  engineCall: async ({ kind, prompt, group }) => {
    const hostFellowId = group.hostFellowId;
    const result = await window.aimashi.sendChat({
      fellowKey: hostFellowId,
      messages: [{ role: "user", content: prompt }],
      systemOverride: "（系统：你是群聊辅助器，无人设，按指令输出）",
    });
    return result.content || result.text || "";
  },
});
```

**注意**：`systemOverride` 字段需要 main 进程 `chat:send` handler 支持——如果尚不支持，加一个简单分支：当 payload 有 `systemOverride` 时，把它作为单次调用的 system prompt 顶替 Fellow 人设（但**不**写入 Fellow session 历史，必须是无状态调用）。

如果现有 `chat:send` 强写 session，新增一个独立 IPC `chat:send-stateless`，接受 `{ fellowKey, messages, systemPrompt }` → 临时调用引擎不入 session。preload 暴露为 `aimashi.sendChatStateless`。

- [ ] **Step 5: Smoke test**

Run: `npm start`
- 建群
- 进群，输入 "@<某 Fellow> 你好"，发送
- 验证：该 Fellow 出现响应 bubble，状态从 streaming → complete
- 输入不带 @ 的消息，验证 conductor 调用 + 选出 Fellow 响应
- 连发 5 条用户消息，看 console / log 摘要触发（这一步先 console.log 验证 `saveContextCard` 被调用即可）

- [ ] **Step 6: Commit**

```bash
git add src/renderer/group.js src/renderer/app.js src/renderer/index.html src/renderer/styles.css src/main.js src/preload.js
git commit -m "feat(group): wire group send flow, dispatch, and summary trigger"
```

---

## Task 15: 群信息抽屉（成员、群主切换、pinnedGoal、重置上下文）

**Files:**
- Modify: `src/renderer/group.js`
- Modify: `src/renderer/index.html`
- Modify: `src/renderer/styles.css`

- [ ] **Step 1: 加 drawer DOM**

Edit `src/renderer/index.html`：
```html
<div id="group-info-drawer" class="drawer hidden">
  <div class="drawer-header">
    <div class="drawer-title">群信息</div>
    <button id="group-info-close">×</button>
  </div>
  <div class="drawer-section">
    <div class="drawer-section-title">成员</div>
    <div id="group-info-members"></div>
  </div>
  <div class="drawer-section">
    <div class="drawer-section-title">群主</div>
    <select id="group-info-host"></select>
  </div>
  <div class="drawer-section">
    <div class="drawer-section-title">目标（可选）</div>
    <textarea id="group-info-goal" placeholder="比如：今天把这个 PR 写完"></textarea>
    <button id="group-info-goal-save">保存目标</button>
  </div>
  <div class="drawer-section">
    <div class="drawer-section-title">维护</div>
    <button id="group-info-reset-ctx">重置群上下文</button>
  </div>
</div>
```

- [ ] **Step 2: 实现 drawer 逻辑**

Add to `src/renderer/group.js`:
```js
function openInfoDrawer(group) {
  const drawer = document.getElementById("group-info-drawer");
  const membersBox = document.getElementById("group-info-members");
  const hostSelect = document.getElementById("group-info-host");
  const goalInput = document.getElementById("group-info-goal");

  membersBox.innerHTML = "";
  for (const memberId of group.members) {
    const row = document.createElement("div");
    row.className = "member-row";
    const name = document.createElement("span");
    name.textContent = moduleState.fellowNamesById[memberId] || memberId;
    if (memberId === group.hostFellowId) name.textContent += " 👑";
    row.appendChild(name);
    if (group.members.length > 1) {
      const removeBtn = document.createElement("button");
      removeBtn.textContent = "移除";
      removeBtn.addEventListener("click", () => removeMember(group, memberId));
      row.appendChild(removeBtn);
    }
    membersBox.appendChild(row);
  }

  hostSelect.innerHTML = "";
  for (const memberId of group.members) {
    const opt = document.createElement("option");
    opt.value = memberId;
    opt.textContent = moduleState.fellowNamesById[memberId] || memberId;
    if (memberId === group.hostFellowId) opt.selected = true;
    hostSelect.appendChild(opt);
  }
  hostSelect.onchange = async () => {
    group.hostFellowId = hostSelect.value;
    await window.aimashi.groups.update(group.id, { hostFellowId: hostSelect.value });
    renderGroupMessages(group, moduleState.messagesByGroup.get(group.id) || []);
  };

  goalInput.value = (group.decorations && group.decorations.pinnedGoal) || "";
  document.getElementById("group-info-goal-save").onclick = async () => {
    const goal = goalInput.value.trim();
    const decorations = { ...(group.decorations || {}), pinnedGoal: goal || null };
    group.decorations = decorations;
    await window.aimashi.groups.update(group.id, { decorations });
  };

  document.getElementById("group-info-reset-ctx").onclick = async () => {
    if (!confirm("重置群上下文摘要？后续 Fellow 看不到旧摘要，得重新攒一遍。")) return;
    group.contextCard = null;
    await window.aimashi.groups.update(group.id, { contextCard: null });
    alert("已重置。");
  };

  drawer.classList.remove("hidden");
  document.getElementById("group-info-close").onclick = () => {
    drawer.classList.add("hidden");
  };
}

async function removeMember(group, memberId) {
  if (group.members.length <= 1) {
    alert("群里至少需要一个 Fellow");
    return;
  }
  const newMembers = group.members.filter((id) => id !== memberId);
  let newHost = group.hostFellowId;
  if (memberId === group.hostFellowId) {
    newHost = newMembers[0];
  }
  group.members = newMembers;
  group.hostFellowId = newHost;
  await window.aimashi.groups.update(group.id, { members: newMembers, hostFellowId: newHost });

  const msgs = moduleState.messagesByGroup.get(group.id) || [];
  const sysMsg = {
    id: "m-" + Date.now() + "-leave",
    groupId: group.id,
    role: "system",
    content: (moduleState.fellowNamesById[memberId] || memberId) + " 离开了群" +
      (memberId === group.hostFellowId
        ? "，" + (moduleState.fellowNamesById[newHost] || newHost) + " 成为群主"
        : ""),
    mentions: [],
    turnId: "t-sys-" + Date.now(),
    createdAt: Date.now(),
    status: "complete",
  };
  await window.aimashi.groups.appendMessage(group.id, sysMsg);
  msgs.push(sysMsg);
  renderGroupMessages(group, msgs);

  if (newMembers.length === 1) {
    if (confirm("群里只剩 1 个 Fellow 了，转为单聊？")) {
      // v1: 不实现自动迁移，仅提示用户手动开单聊
      alert("请直接打开单聊和该 Fellow 对话。");
    }
  }
  openInfoDrawer(group); // refresh
}

// Bind in openGroup:
function bindInfoButton(group) {
  const btn = document.getElementById("group-view-info");
  const fresh = btn.cloneNode(true);
  btn.parentNode.replaceChild(fresh, btn);
  document.getElementById("group-view-info").addEventListener("click", () => openInfoDrawer(group));
}
```

把 `bindInfoButton(group)` 调用加到 `openGroup` 末尾。

- [ ] **Step 3: Smoke test**

Run: `npm start`
- 进群 → 点 ℹ️ → 验证 drawer 弹出
- 改群主 → 重新看消息列表，皇冠迁移
- 写目标 → 保存 → 关闭 drawer 重新打开，目标保留
- 移除一个非群主 Fellow → system bubble 出现
- 移除群主 → 自动指派新群主 + system bubble

- [ ] **Step 4: Commit**

```bash
git add src/renderer/group.js src/renderer/index.html src/renderer/styles.css
git commit -m "feat(group): add group info drawer with host switch and goal"
```

---

## Task 16: 集成测试 — mock 引擎跑 3 Fellow 群

**Files:**
- Create: `tests/group-integration.test.js`

不走 Electron / DOM，直接组装 store + conductor，用 mock engine 模拟一个完整 3-Fellow 黄金路径。

- [ ] **Step 1: 写集成测试**

Create `tests/group-integration.test.js`:
```js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createGroupStore } = require("../src/main/group-store.js");
const { createConductor } = require("../src/renderer/conductor.js");
const {
  parseMentions,
  filterRecentTurnsForFellow,
  buildFellowGroupContext,
  shouldSummarize,
} = require("../src/renderer/group-prompts.js");

function makeTmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "aimashi-it-"));
}

const fellows = [
  { id: "alice", name: "Alice" },
  { id: "bob", name: "Bob" },
  { id: "coder", name: "Coder" },
];
const fellowNamesById = Object.fromEntries(fellows.map((f) => [f.id, f.name]));

const dispatchTpl = "members:{{members}} summary:{{summary}} recent:{{recent}} user:{{userMessage}}";
const summarizeTpl = "old:{{oldSummary}} new:{{newMessages}}";

test("3-fellow group: user @ alice → only alice speaks", async () => {
  const root = makeTmpRoot();
  const store = createGroupStore(root);
  const group = store.create({
    name: "T",
    members: ["alice", "bob", "coder"],
    hostFellowId: "alice",
  });

  const engine = {
    call: async ({ kind, prompt }) => {
      if (kind === "dispatch") return '{"speak":["coder"]}';
      if (kind === "summarize") return "current summary";
      if (kind === "fellow-reply") return "fellow says hi";
      throw new Error("unexpected kind " + kind);
    },
  };

  const conductor = createConductor({
    engineCall: engine.call,
    dispatchTemplate: dispatchTpl,
    summarizeTemplate: summarizeTpl,
  });

  const userMsg = {
    id: "m1",
    role: "user",
    turnId: "t1",
    content: "@Alice 你看下",
    mentions: parseMentions("@Alice 你看下", fellows),
  };
  store.appendMessage(group.id, userMsg);

  const dispatch = await conductor.decideDispatch({
    group: store.get(group.id),
    members: fellows.filter((f) => group.members.includes(f.id)),
    fellowNamesById,
    userMessage: userMsg,
    messages: store.listMessages(group.id),
  });

  assert.deepEqual(dispatch.speak, ["alice"]);
});

test("3-fellow group: no @ triggers dispatch LLM", async () => {
  const root = makeTmpRoot();
  const store = createGroupStore(root);
  const group = store.create({
    name: "T",
    members: ["alice", "bob", "coder"],
    hostFellowId: "alice",
  });

  let dispatchCalls = 0;
  const engine = {
    call: async ({ kind }) => {
      if (kind === "dispatch") {
        dispatchCalls++;
        return '{"speak":["bob","coder"]}';
      }
      throw new Error("unexpected kind");
    },
  };
  const conductor = createConductor({
    engineCall: engine.call,
    dispatchTemplate: dispatchTpl,
    summarizeTemplate: summarizeTpl,
  });

  const userMsg = {
    id: "m1",
    role: "user",
    turnId: "t1",
    content: "随便说",
    mentions: [],
  };
  const result = await conductor.decideDispatch({
    group: store.get(group.id),
    members: fellows,
    fellowNamesById,
    userMessage: userMsg,
    messages: [userMsg],
  });
  assert.equal(dispatchCalls, 1);
  assert.deepEqual(result.speak, ["bob", "coder"]);
});

test("summary triggers after 4 user turns and persists", async () => {
  const root = makeTmpRoot();
  const store = createGroupStore(root);
  const group = store.create({
    name: "T",
    members: ["alice", "bob"],
    hostFellowId: "alice",
  });

  let summarizeCalls = 0;
  const engine = {
    call: async ({ kind }) => {
      if (kind === "summarize") {
        summarizeCalls++;
        return "they're chatting about X";
      }
      throw new Error("unexpected");
    },
  };
  const conductor = createConductor({
    engineCall: engine.call,
    dispatchTemplate: dispatchTpl,
    summarizeTemplate: summarizeTpl,
  });

  const msgs = [];
  for (let i = 1; i <= 4; i++) {
    msgs.push({
      id: "m" + i, role: "user", turnId: "t" + i, content: "x" + i, mentions: [],
    });
    store.appendMessage(group.id, msgs[msgs.length - 1]);
  }

  assert.equal(shouldSummarize(store.get(group.id), msgs), true);
  const card = await conductor.summarize({
    group: store.get(group.id),
    fellowNamesById,
    messages: msgs,
  });
  store.saveContextCard(group.id, card);
  assert.equal(summarizeCalls, 1);
  const fresh = store.get(group.id);
  assert.equal(fresh.contextCard.summary, "they're chatting about X");
  assert.equal(fresh.contextCard.summaryUpToMsgId, "m4");
});

test("dispatch failure does not crash flow, no fellow speaks", async () => {
  const root = makeTmpRoot();
  const store = createGroupStore(root);
  const group = store.create({
    name: "T",
    members: ["alice", "bob"],
    hostFellowId: "alice",
  });
  const engine = {
    call: async ({ kind }) => {
      if (kind === "dispatch") throw new Error("offline");
      throw new Error("unexpected");
    },
  };
  const conductor = createConductor({
    engineCall: engine.call,
    dispatchTemplate: dispatchTpl,
    summarizeTemplate: summarizeTpl,
  });
  const result = await conductor.decideDispatch({
    group: store.get(group.id),
    members: fellows,
    fellowNamesById,
    userMessage: { content: "hi", mentions: [], turnId: "t1" },
    messages: [],
  });
  assert.deepEqual(result, { speak: [], degraded: true });
});

test("host switch persists across reload", () => {
  const root = makeTmpRoot();
  const store = createGroupStore(root);
  const group = store.create({
    name: "T",
    members: ["alice", "bob"],
    hostFellowId: "alice",
  });
  store.updateGroup(group.id, { hostFellowId: "bob" });

  const store2 = createGroupStore(root);
  const fresh = store2.get(group.id);
  assert.equal(fresh.hostFellowId, "bob");
});
```

- [ ] **Step 2: 跑集成测试 PASS**

Run: `npm test`
Expected: 全 PASS（包括之前所有单元测试）

- [ ] **Step 3: Commit**

```bash
git add tests/group-integration.test.js
git commit -m "test(group): integration test for 3-fellow group golden path"
```

---

## Task 17: 手动 UX 验收清单

**Files:**
- Create: `docs/superpowers/specs/2026-05-14-group-chat-uat.md`

写一个 UAT 清单，让你（或下一个执行人）按顺序手测，全过才算 MVP 完成。

- [ ] **Step 1: 写 UAT checklist**

Create `docs/superpowers/specs/2026-05-14-group-chat-uat.md`:
```markdown
# Group Chat v1 UAT Checklist

按顺序跑完。任一项失败 → 记录现象 → 修 → 重跑该项及后续。

## 创建

- [ ] 至少有 2 个本地 Fellow 已配置（不行先建）
- [ ] 点侧边栏"+ 新建群聊" → dialog 弹出
- [ ] 勾 1 个 Fellow → 创建按钮无反应 / 提示成员不足
- [ ] 勾 6 个 Fellow → 提示成员超限
- [ ] 勾 2-5 个 Fellow → host 下拉填充正确
- [ ] 留空群名 → 创建成功，默认名为成员名拼接
- [ ] 创建后侧边栏出现该群，自动打开

## 群聊基础

- [ ] 用户发"@<X> 你好"（X 为成员之一）→ 只有 X 响应
- [ ] 用户发不带 @ 的消息 → conductor 选出 0-3 个 Fellow 响应
- [ ] 群里出现群主皇冠 👑 标记在群主 Fellow 发言旁
- [ ] 长消息 Fellow 响应能滚动到底部

## 跨引擎

- [ ] 群里同时包含 Hermes Fellow 和 Claude Code Fellow（或 Codex Fellow），两者都能响应
- [ ] Hermes Fellow 响应里能看出它"知道"群上下文（例如它能复述群里前面发生的事）
- [ ] Claude Code Fellow 响应里能看出它"知道"群上下文

## 摘要

- [ ] 发 4 条用户消息后 → DevTools console log 出现摘要触发
- [ ] 验证 `engine-home/groups/<id>/context-card.json` 写入
- [ ] 第 5、6、7、8 条之后再次触发新摘要

## 错误降级

- [ ] 关掉 Hermes 引擎，群主 Fellow 用 Hermes → 用户发不带 @ 的消息 → 群里出现 system bubble "群助手暂时不在线"
- [ ] 把单 Fellow 的引擎搞坏 → 该 Fellow 气泡显示错误，其他 Fellow 正常
- [ ] 在 drawer 里点"重置群上下文" → 确认弹窗 → context-card.json 清空

## 群成员管理

- [ ] Drawer 改群主 → 群里下条 Fellow 响应使用新群主的引擎
- [ ] Drawer 移除非群主成员 → system bubble "X 离开了群"
- [ ] Drawer 移除群主 → system bubble "X 离开了群, Y 成为群主"
- [ ] 移除到只剩 1 Fellow → 提示"转为单聊？"，点取消保留群

## 持久化

- [ ] 重启 app → 所有群仍在侧边栏
- [ ] 打开群 → 历史消息加载
- [ ] 群信息（成员、群主、目标）正确保留

## 目标 / pinnedGoal

- [ ] Drawer 写"今天把 X 做完" → 保存 → 重开 drawer 仍保留
- [ ] (v2 才有完整 nudge 机制；v1 仅验证保存)

## 边界

- [ ] 创建一个仅 2 Fellow 的群，运行 1 小时，无明显内存膨胀（粗略观察）
- [ ] 在群和 1v1 之间切换，状态不串
- [ ] 群主 Fellow 在群里"接话"后，去单聊找他，单聊历史不包含群里的话（验证 stateless 调用没污染 session）

## 已知 v2 范围（不测）

- 桌宠同屏
- Todos / 完整 decorations
- 大群 (>5 Fellow)
- 跨设备实时同步
```

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/specs/2026-05-14-group-chat-uat.md
git commit -m "docs: add group chat v1 UAT checklist"
```

- [ ] **Step 3: 跑一遍 UAT**

按 checklist 顺序手测。失败的项目记录现象，修完重跑该项 + 后续。

- [ ] **Step 4: MVP 完成确认**

UAT 全过 → 在本 plan 末尾追加一行：
```
MVP signed off: <YYYY-MM-DD HH:MM> by <user>
```
然后 commit：
```bash
git add docs/superpowers/plans/2026-05-14-group-chat.md
git commit -m "chore(group): sign off group chat v1 MVP"
```

---

## 自审 checklist（plan 写完后人工跑一次）

- ✅ Spec §2 Group 实体 → Task 2 落地
- ✅ Spec §2 群主三种行为 → Task 5 conductor + Task 14 sendInGroup
- ✅ Spec §3 存储布局 → Task 2 group-store
- ✅ Spec §4 创群限制 (2-5) → Task 2 校验 + Task 13 UI
- ✅ Spec §5 数据流（@ skip / dispatch / fellow context / summarize） → Tasks 3, 4, 5, 14
- ✅ Spec §5 摘要按 turn → Task 4 shouldSummarize
- ✅ Spec §5 nudge → v1 仅保存 pinnedGoal（Task 15），真 nudge 推迟到 v2（明确在 §10 标记）
- ✅ Spec §6 跨引擎 → Task 6 adapters + Task 7 fellow_overlay + Task 10 chat:send 扩展
- ✅ Spec §7 错误降级 → Tasks 5 (conductor degraded), 14 (system bubble), 15 (host leave, reset ctx)
- ✅ Spec §8 文件清单 → 本 plan "文件清单" 节
- ✅ Spec §9 测试策略 → Tasks 2-6 单元 + Task 16 集成 + Task 17 UAT

无 placeholder、无 TBD。类型 / 函数命名跨 task 一致（`createGroupStore` / `createConductor` / `decideDispatch` / `shouldSummarize` 等命名 task 间引用一致）。

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-14-group-chat.md`. 两种执行方式：

1. **Subagent-Driven (推荐)** — 每 task 派一个 fresh subagent，task 间审一次，快迭代
2. **Inline Execution** — 在当前会话里按 task 顺序跑，间歇 checkpoint

哪种？
