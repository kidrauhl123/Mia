# Mia Aion 原生 Agent 注入与定时任务实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Hermes、Claude Code、Codex 的本地 Bot 都通过真实 Native ACP 会话获得按会话作用域的 Mia MCP、原生技能和记忆工具，并用 Aion 的文本控制协议管理真实定时任务。

**Architecture:** Rust Core 是 Agent session、MCP、技能、记忆作用域、定时任务和对话持久化的唯一 owner。`mia-core mcp-mia-stdio` 作为内置 MCP 由 Core 在 `session/new`/`session/load` 时注入，每个实例通过环境变量绑定真实 bot/conversation；定时任务不再作为 MCP 工具，而由原生 cron 技能指导 Agent 输出受限 CRON 协议，Core 在完整 assistant turn 后解析、执行并隐藏协议。Claude/Codex 使用工作区原生技能目录，Hermes 使用其原生 `skills.external_dirs`，任何引擎都不得回退为技能正文 prompt 拼接。

**Tech Stack:** Rust 2024、Axum、SQLx/SQLite、ACP SDK、Electron preload/renderer、Node `node:test`

## Global Constraints

- 不把技能正文、记忆正文或 MCP 说明拼进普通用户输入；不存在 prompt fallback。
- 定时任务 Agent 接口对齐 Aion：原生 cron Skill、`[CRON_LIST]`/`[CRON_CREATE]`/`[CRON_UPDATE]`/`[CRON_DELETE]`、隐藏 continuation、Rust Core durable state。
- 定时任务从 `mia-app` MCP、独立 `mia-scheduler` MCP、Codex 用户配置和 Cloud MCP 中全部移除。
- `mia-app` MCP 上下文必须来自当前 RuntimeTurnPlan，不得再用全局 context JSON 文件。
- 每个定时任务只作用于创建它的 conversation/bot；list/update/delete 必须校验作用域。
- 所有调度执行继续走 `ConversationService` + `RuntimeSessionManager`，使用该 Bot 的真实 engine/model/effort/permission。
- Hermes 没有真实 ACP control 时前端可以隐藏；禁止合成 CLI 默认值或占位值。
- 默认 Mia 平台模型保持 `auto`/Mia logo，不改变现有产品映射。
- 测试不得写真实 `~/Library/Application Support/Mia`；Hermes 配置测试使用临时 HOME/config fixture。

---

## File Structure

- Create: `crates/mia-core-app/src/builtin_mcp.rs`
  - 实现 `mia-core mcp-mia-stdio` JSON-RPC stdio server，暴露 context/memory/current-skill 工具，不含 scheduler。
- Create: `crates/mia-core-conversation/src/cron_protocol.rs`
  - 纯解析、剥离和格式化 Aion CRON 控制协议。
- Create: `crates/mia-core-app/src/cron_middleware.rs`
  - 将解析结果映射到 `TaskService`，执行 conversation-scoped CRUD，生成隐藏 system continuation。
- Modify: `crates/mia-core-app/src/main.rs`
  - 注册 `mcp-mia-stdio` 子命令。
- Modify: `crates/mia-core-conversation/src/lib.rs`
  - 按当前 conversation/bot 生成内置 MCP spec；用 `CurrentSkillService` 生成真实技能记录、原生链接和 turn-selected 路径；移除 prompt fallback。
- Modify: `crates/mia-core-runtime/src/lib.rs`
  - 将技能指纹纳入 Native ACP task key；允许 Core 注入短 selected-skill path control，不注入技能正文。
- Modify: `crates/mia-core-runtime/src/native_acp.rs`
  - `session/new` 和 resume 都携带 Core 生成的 MCP；为 CRON continuation 复用同一 native session。
- Modify: `crates/mia-core-app/src/cloud_bridge.rs`
  - 本地 Bot 主链路运行 CRON middleware/continuation，并保留真实 trace/content blocks。
- Modify: `crates/mia-core-app/src/router/conversation.rs`
  - 普通 Core conversation 主链路复用相同 middleware。
- Modify: `crates/mia-core-app/src/scheduler.rs`, `crates/mia-core-app/src/router/tasks.rs`
  - 定时触发消息标记 hidden/scheduled，仍走真实 RuntimeSessionManager；任务完成后再推进 next run。
- Modify: `crates/mia-core-tasks/src/lib.rs`, `crates/mia-core-api-types/src/lib.rs`
  - 增加 conversation-scoped list 与任务标题/描述兼容字段，保持现有 SQLite 向后兼容。
- Modify: `skills/_builtin/mia-scheduler/SKILL.md`
  - 改为 Aion 两阶段 CRON 协议，不再描述 MCP tools。
- Modify: `src/preload.js`, `src/renderer/app.js`, `src/renderer/skills/*`
  - desktop-local send 传递 `selectedSkillIds`；slash 技能命令转成现有 chip 而不是直接执行旧 `/` 命令。
- Delete: `src/main/scheduler-mcp-server.js`, `src/main/scheduler-mcp-bridge.js`, `tests/scheduler-mcp-server.test.js`, `tests/scheduler-mcp-bridge.test.js`
  - 删除独立 scheduler MCP。
- Delete: `src/main/mia-app-mcp-server.js`, `src/main/mia-app-mcp-bridge.js`, `tests/mia-app-mcp-server.test.js`, `tests/mia-app-mcp-bridge.test.js`
  - 删除 Node 内置 MCP；由 Rust 子命令替代。
- Modify: `src/main.js`, `src/main/mcp-reserved-servers.js`, Cloud runtime assembly/tests, project structure tests
  - 删除旧 bridge 装配、reserved scheduler、Codex config 污染与 cloud scheduler MCP。

### Task 1: 固化 Rust CRON 协议与作用域

**Interfaces:**
- Produces: `detect_cron_commands(text: &str) -> Vec<CronCommand>`
- Produces: `strip_cron_commands(text: &str) -> String`
- Produces: `execute_cron_commands(tasks, bot_id, conversation_id, commands) -> Vec<String>`

- [ ] **Step 1: 写失败测试**

在 `crates/mia-core-conversation/tests/cron_protocol.rs` 覆盖完整/缺失 closing tag、多行 `message`、剥离可见文本；在 `crates/mia-core-app` 测试 conversation scope，确保一个对话看不到或修改另一个对话的任务。

- [ ] **Step 2: 验证 RED**

Run: `cargo test -p mia-core-conversation --test cron_protocol && cargo test -p mia-core-app cron_middleware`

Expected: FAIL，因为 parser/module 尚不存在。

- [ ] **Step 3: 最小实现**

实现 Aion 四种命令；create/update body 使用逐字段状态机而不是单行 regex，使 `message:` 后续缩进行可以安全保留。所有 TaskService 调用必须用 `target.conversationId` 和 `target.botId` 校验。

- [ ] **Step 4: 验证 GREEN**

Run: `cargo test -p mia-core-conversation --test cron_protocol && cargo test -p mia-core-app cron_middleware`

Expected: PASS。

### Task 2: 将 CRON middleware 接入真实 Agent turn

**Interfaces:**
- Consumes: Task 1 parser/executor
- Produces: 最多 4 次 continuation 的同 session turn loop

- [ ] **Step 1: 写失败测试**

为 runtime backend 录制三段输出：`[CRON_LIST]`、`[CRON_CREATE]...`、最终中文确认。断言前两段不持久化为可见 assistant message，TaskService 只创建一次任务，最终确认保留；超过 4 次时停止。

- [ ] **Step 2: 验证 RED**

Run: `cargo test -p mia-core-app cron_continuation`

Expected: FAIL，当前只执行一次 prompt 且会原样持久化标签。

- [ ] **Step 3: 最小实现**

在 Core 运行完成后处理中识别命令，调用 TaskService，将小型 `[System: ...]` 结果作为 hidden continuation 送回同一 `RuntimeSessionManager`；普通 assistant 输出保持现有 streaming/trace，CRON-only 输出在确认不是普通消息前暂存。

- [ ] **Step 4: 验证 GREEN**

Run: `cargo test -p mia-core-app cron_continuation scheduler`

Expected: PASS。

### Task 3: Rust 内置 mia-app MCP 与真实作用域

**Interfaces:**
- Produces: `mia-core mcp-mia-stdio`
- Produces tools: `context_snapshot`, `memory_search`, `memory_list`, `memory_remember`, `memory_update`, `memory_forget`, `skill_list_current`, `skill_read_current`
- Explicitly omits: every `schedule_*` tool

- [ ] **Step 1: 写失败测试**

启动 stdio 子命令 fixture，发送 `initialize`、`tools/list`、`tools/call`；断言 tool list 不含 scheduler，context/memory 请求自动带环境中的真实 bot/conversation，两个并发实例互不污染。

- [ ] **Step 2: 验证 RED**

Run: `cargo test -p mia-core-app builtin_mcp`

Expected: FAIL，因为子命令和 server 尚不存在。

- [ ] **Step 3: 最小实现**

实现 MCP line-delimited JSON-RPC；工具通过当前 Core HTTP API 调用已有 Rust services。ConversationService 每轮构造：

```json
{
  "name": "mia-app",
  "command": "<current mia-core executable>",
  "args": ["mcp-mia-stdio"],
  "env": {
    "MIA_CORE_URL": "http://127.0.0.1:<port>",
    "MIA_BOT_ID": "<real bot id>",
    "MIA_CONVERSATION_ID": "<real core conversation id>",
    "MIA_ORIGIN_MESSAGE_ID": "<real message id>"
  }
}
```

- [ ] **Step 4: 验证 GREEN**

Run: `cargo test -p mia-core-app builtin_mcp && cargo test -p mia-core-runtime mcp`

Expected: PASS，new/resume 都带同一 spec。

### Task 4: 原生技能与 slash-to-chip

**Interfaces:**
- Produces: `CurrentSkillService::runtime_skill_records(bot, selected_ids)`
- Produces delivery: Claude `.claude/skills`, Codex `.codex/skills`, Hermes native `skills.external_dirs`
- Produces selected control: only concrete `SKILL.md` paths; no body/index fallback

- [ ] **Step 1: 写失败测试**

Rust 测试断言三引擎均无 `prompt-fallback`/`loaded_block`，Claude/Codex 创建受管链接，Hermes 生成原生 external-dir 状态；JS 测试断言输入 `/meeting-notes` 选择 skill chip、保留后续正文，并在 desktop-local `/api/cloud/bridge/run` body 中出现 `selectedSkillIds`。

- [ ] **Step 2: 验证 RED**

Run: `cargo test -p mia-core-conversation agent_session_skill && node --test tests/renderer-skill-chip.test.js tests/preload-core-conversations.test.js`

Expected: FAIL，当前 Hermes/turn 选择未进入实际 Native ACP，preload 丢失 selected IDs。

- [ ] **Step 3: 最小实现**

Core 从 bot capability + CurrentSkillService 解析真实源目录；session-level skills 原生挂载；turn chip 只发送受管 `SKILL.md` 路径。删除 `[LOAD_SKILL]` 重试和所有技能正文 prompt fallback。Renderer 的 slash matcher 调用现有 composer chip owner，不再走旧 agent command。

- [ ] **Step 4: 验证 GREEN**

Run: `cargo test -p mia-core-conversation && node --test tests/renderer-skill-chip.test.js tests/preload-core-conversations.test.js`

Expected: PASS。

### Task 5: 删除旧 MCP 链路并更新架构守卫

- [ ] **Step 1: 写失败结构测试**

更新 `tests/scheduler-aion-architecture.test.js` 和 `tests/project-structure-check.test.js`：断言 Node MCP server/bridge 文件不存在；main/Cloud/Codex config 不含 `mia-scheduler`；Rust Core 包含 `mcp-mia-stdio` 和 CRON parser。

- [ ] **Step 2: 验证 RED**

Run: `node --test tests/scheduler-aion-architecture.test.js tests/project-structure-check.test.js`

Expected: FAIL，旧文件和装配仍存在。

- [ ] **Step 3: 删除实现与引用**

删除两个 Node MCP server/bridge 及其测试；从 `src/main.js`、reserved config、cloud runtime assembly、engine plugin、Codex sync 和 packaging expectations 删除 scheduler/Mia Node MCP；保留用户自定义 MCP 的 Rust Core 管理链路。

- [ ] **Step 4: 验证 GREEN**

Run: `node --test tests/scheduler-aion-architecture.test.js tests/project-structure-check.test.js tests/mcp-service.test.js tests/renderer-mcp-library.test.js`

Expected: PASS。

### Task 6: 自动化与真实前端验收

- [ ] **Step 1: 定向验证**

Run: `cargo test -p mia-core-api-types -p mia-core-conversation -p mia-core-tasks -p mia-core-runtime -p mia-core-app`

Run: `cargo clippy -p mia-core-api-types -p mia-core-conversation -p mia-core-tasks -p mia-core-runtime -p mia-core-app --all-targets -- -D warnings`

Run: `node --test tests/scheduler-aion-architecture.test.js tests/project-structure-check.test.js tests/preload-core-conversations.test.js tests/renderer-skill-chip.test.js tests/mcp-service.test.js`

- [ ] **Step 2: 全仓验证**

Run: `cargo fmt --all --check && npm run check && npm test`

- [ ] **Step 3: 真实前端逐引擎验收**

在当前 3333 前端完成 Hermes、Claude Code、Codex 各一轮：普通消息有真实回复；模型/effort/permission 只显示 ACP 真实值；Trace 可见；选择技能 chip 后 Agent 能读取对应 SKILL.md；memory remember/search 命中当前 bot/conversation；自然语言创建定时任务后第 4 栏出现真实任务并可手动运行。Hermes 未广告的控件必须隐藏。

- [ ] **Step 4: 提交与 push**

只 stage 本计划涉及文件，提交标题使用中文摘要，例如：

```text
feat(agent): 对齐 Aion 原生注入与定时任务
```

Run: `git push origin rust`
