# OfficeCLI 原生接入实施计划

> **执行方式：** 在当前 `rust` 工作区按任务顺序实施。每项功能先运行定向失败测试，再写最小实现，随后运行定向回归。最终必须通过三种本地引擎的真实前端用户链路验收。

**目标：** 把 iOfficeAI/OfficeCLI 作为 Mia 的原生默认技能接入 Claude Code、Codex、Hermes 和 Cloud，使默认技能、安装、工具调用、Trace、Office 文件结果都来自真实运行时。

**架构：** 一份受版本控制的默认技能 manifest 同时供 Node、Rust Core、Cloud 和 renderer 读取。四份上游技能按固定版本原样 vendoring；Rust Core 只把有效技能链接到各引擎原生目录，不把技能正文拼进 prompt。桌面端由上游技能在首次需要时安装外部 OfficeCLI，Cloud release 在共享运行时目录预装并验证。

**技术栈：** Electron/CommonJS、Rust workspace/Serde、Node test runner、Shell/PowerShell、Claude Code/Codex/Hermes 原生技能目录。

---

## 任务 1：固定上游技能原文、许可证和同步证据

**文件：**

- 新建：`skills/_builtin/officecli/SKILL.md`
- 新建：`skills/_builtin/officecli-docx/SKILL.md`
- 新建：`skills/_builtin/officecli-xlsx/SKILL.md`
- 新建：`skills/_builtin/officecli-pptx/SKILL.md`
- 新建：`skills/_builtin/officecli/THIRD_PARTY_NOTICES.md`
- 新建：`skills/_builtin/officecli/LICENSE`
- 新建：`skills/_builtin/officecli-sources.json`
- 新建：`scripts/sync-officecli-skills.js`
- 修改：`package.json`
- 修改：`src/check.js`
- 修改：`scripts/build-cloud-release.js`
- 新建测试：`tests/officecli-skills-source.test.js`
- 修改测试：`tests/skill-packages.test.js`
- 修改测试：`tests/cloud-release-handoff.test.js`

### 1.1 先写失败测试

测试必须断言：

- 四个 `SKILL.md`、Apache-2.0 `LICENSE`、归属说明和 source manifest 都存在。
- manifest 固定 `OfficeCLI v1.0.135 / d2d9c60...` 与 `AionCore abbcd782...`。
- 四个正文 SHA-256 与 manifest 完全一致。
- `scripts/sync-officecli-skills.js --check` 只校验本地 vendored 内容，不联网且不会改文件。
- Cloud release 必需文件清单包含四个技能、许可证、归属和 manifest。

运行：

```bash
node --test tests/officecli-skills-source.test.js tests/skill-packages.test.js tests/cloud-release-handoff.test.js
```

预期：因 vendored 文件和同步脚本尚不存在而失败。

### 1.2 导入固定上游原文

- 通用 `officecli` 从 OfficeCLI tag `v1.0.135` 获取。
- `docx/xlsx/pptx` 从 AionCore commit `abbcd7823d4165781c2d9f6bacadc6bdbe17aef2` 获取。
- 逐字节落盘，不改正文、frontmatter、安装指令或示例。
- 把每份正文的 URL、commit、SHA-256 写入 `officecli-sources.json`。
- 保存 Apache License 2.0 正文，并在 `THIRD_PARTY_NOTICES.md` 明确 Mia vendoring 来源和未修改声明。

### 1.3 实现可审计同步脚本

脚本支持：

```bash
node scripts/sync-officecli-skills.js --check
node scripts/sync-officecli-skills.js --update
```

- `--check` 只对本地文件算摘要并与 manifest 比较。
- `--update` 才访问固定 raw URL，下载到临时文件，验证后原子替换正文并更新摘要。
- 不把联网同步放进构建、启动或普通 `npm run check`。

在 `package.json` 增加：

```json
"officecli:skills:check": "node scripts/sync-officecli-skills.js --check",
"officecli:skills:sync": "node scripts/sync-officecli-skills.js --update"
```

### 1.4 跑绿并提交

```bash
node --test tests/officecli-skills-source.test.js tests/skill-packages.test.js tests/cloud-release-handoff.test.js
npm run officecli:skills:check
git add skills/_builtin/officecli skills/_builtin/officecli-docx skills/_builtin/officecli-xlsx skills/_builtin/officecli-pptx skills/_builtin/officecli-sources.json scripts/sync-officecli-skills.js package.json src/check.js scripts/build-cloud-release.js tests/officecli-skills-source.test.js tests/skill-packages.test.js tests/cloud-release-handoff.test.js
git commit -m "feat(skills): 引入 OfficeCLI 上游技能"
```

---

## 任务 2：建立 Node 与 Rust 共用的默认技能策略

**文件：**

- 新建：`packages/shared/skill-defaults.json`
- 新建：`packages/shared/skill-defaults.js`
- 新建：`packages/shared/skill-defaults.d.ts`
- 修改：`packages/shared/package.json`
- 修改：`packages/shared/index.js`
- 修改：`packages/shared/index.d.ts`
- 修改：`packages/shared/bot-identity.js`
- 修改：`packages/shared/bot-identity.d.ts`
- 修改：`Cargo.toml`
- 修改：`crates/mia-core-common/Cargo.toml`
- 新建：`crates/mia-core-common/src/skill_defaults.rs`
- 修改：`crates/mia-core-common/src/lib.rs`
- 修改测试：`tests/shared-identity.test.js`
- 修改测试：`tests/packages-shared-contract.test.js`
- 新建 Rust 单元测试：`crates/mia-core-common/src/skill_defaults.rs`

### 2.1 先写解析规则的失败测试

Node 与 Rust 都覆盖同一组真值表：

| 情况 | 有效技能 |
| --- | --- |
| 默认继承 | `mia-scheduler`、`mia-official:officecli` |
| `inheritEngineDefaults=false` | 不包含系统自动技能 |
| `disabledSkills=[officecli]` | 保留 scheduler，去掉 officecli |
| 模板技能 + 手动技能 | 与系统自动技能去重合并 |
| 当前消息 chip | 最后追加且不写回 Bot |

先在 `tests/shared-identity.test.js` 断言：

```js
assert.deepEqual(
  resolveEffectiveSkillIds({ inheritEngineDefaults: true }),
  ["mia-scheduler", "mia-official:officecli"]
);
```

并断言 `botCapabilitiesWithPresetDefaults` 不再为了套用模板把 `inheritEngineDefaults` 改成 `false`。

运行：

```bash
node --test tests/shared-identity.test.js tests/packages-shared-contract.test.js
cargo test -p mia-core-common skill_defaults
```

预期：缺少模块或结果仍是旧语义而失败。

### 2.2 实现唯一 manifest 和两端解析器

`skill-defaults.json` 固定：

```json
{
  "version": 1,
  "systemAutoSkillIds": ["mia-scheduler", "mia-official:officecli"],
  "genericAssistantSkillIds": [
    "mia-official:officecli-docx",
    "mia-official:officecli-xlsx",
    "mia-official:officecli-pptx"
  ]
}
```

Node `resolveEffectiveSkillIds` 和 Rust `resolve_effective_skill_ids` 必须按以下顺序稳定去重：

```text
(继承的 systemAutoSkillIds + presetSkills + enabledSkills - disabledSkills) + selectedSkillIds
```

专项三技能不作为所有 Bot 的系统继承项；它们只由通用 Bot 创建策略显式写入 `enabledSkills`。

### 2.3 修正模板继承语义

`botCapabilitiesWithPresetDefaults`：

- 保留 Bot 原有 `inheritEngineDefaults`。
- 模板技能与手动技能合并。
- `disabledSkills` 始终胜过系统、模板和 enabled。
- 老 Bot 不需要批量改数据库即可获得 `officecli`。

### 2.4 跑绿并提交

```bash
node --test tests/shared-identity.test.js tests/packages-shared-contract.test.js
cargo test -p mia-core-common skill_defaults
git add packages/shared Cargo.toml crates/mia-core-common tests/shared-identity.test.js tests/packages-shared-contract.test.js
git commit -m "feat(skills): 统一默认技能解析策略"
```

---

## 任务 3：让 Rust 会话只走三引擎原生技能目录

**文件：**

- 修改：`crates/mia-core-conversation/Cargo.toml`
- 修改：`crates/mia-core-conversation/src/lib.rs`
- 修改测试：`crates/mia-core-conversation/tests/conversation_service.rs`
- 修改测试：`tests/native-skill-context.test.js`
- 修改测试：`tests/native-turn-helpers.test.js`
- 修改测试：`tests/selected-skill-routing-prompt.test.js`
- 修改测试：`tests/hermes-skills-source.test.js`

### 3.1 先写原生目录与无 prompt 拼接测试

Rust 测试覆盖同一 Bot 的有效技能在三个引擎下分别链接到：

- Claude Code：`<workspace>/.claude/skills/<skill>`
- Codex：`<workspace>/.codex/skills/<skill>`
- Hermes：`<session-runtime>/skills/<skill>`，并通过现有 `${MIA_HERMES_SKILLS_DIR}` 配置交给 Hermes `skills.external_dirs`

同时断言：

- `officecli` 会因默认继承进入 session plan。
- 显式禁用后不建立链接。
- skill chip 只增加本轮原生链接/路径选择，不把正文塞进 user/system message。
- `selected_skill_prompt` 初始值为空，消息 body 不含 `SKILL.md` 正文。

运行：

```bash
cargo test -p mia-core-conversation
node --test tests/native-skill-context.test.js tests/native-turn-helpers.test.js tests/selected-skill-routing-prompt.test.js tests/hermes-skills-source.test.js
```

预期：Rust 仍硬编码 scheduler 且没有从 shared manifest 解析 officecli，因此失败。

### 3.2 接入 Rust shared resolver

- `mia-core-conversation` 依赖 `mia-core-common`。
- 删除 `current_skill_ids` 内对 `mia-scheduler` 的硬编码追加。
- `runtime_skill_records` 使用 common resolver 得出 session 默认技能，再追加 turn-local chip。
- 缺少系统默认 vendored 目录时返回明确错误，不能静默跳过。
- 保留现有 Claude/Codex 链接实现；Hermes 使用已经验证过的 v0.16.0 `skills.external_dirs` 契约，不自创新路径。

### 3.3 跑绿并提交

```bash
cargo test -p mia-core-conversation
node --test tests/native-skill-context.test.js tests/native-turn-helpers.test.js tests/selected-skill-routing-prompt.test.js tests/hermes-skills-source.test.js
git add crates/mia-core-conversation tests/native-skill-context.test.js tests/native-turn-helpers.test.js tests/selected-skill-routing-prompt.test.js tests/hermes-skills-source.test.js
git commit -m "feat(core): 原生注入 OfficeCLI 技能"
```

---

## 任务 4：修正通用 Bot 创建、已有 Bot 展示和禁用行为

**文件：**

- 修改：`crates/mia-core-bot/Cargo.toml`
- 修改：`crates/mia-core-bot/src/lib.rs`
- 修改：`crates/mia-core-api-types/src/lib.rs`
- 修改：`scripts/serve-cloud.js`
- 修改：`src/renderer/bot/bot-manager.js`
- 修改：`src/renderer/bot/bot-store.js`
- 修改：`src/renderer/skills/skill-helpers.js`
- 修改测试：`tests/starter-engine-bots.test.js`
- 修改测试：`tests/bot-store-ui.test.js`
- 修改测试：`tests/bot-manager-contact-sort.test.js`
- 修改测试：`tests/skill-catalog-zh.test.js`
- 修改 Rust 测试：`crates/mia-core-bot/tests/bot_service.rs`

### 4.1 先写失败测试

断言：

- 本地三个 starter Bot 与 Cloud starter Bot 都显式启用三个 Office 专项技能并继续继承系统默认。
- 手动创建的通用 Bot 默认同样拥有三个专项技能。
- 已有 `capabilities={inheritEngineDefaults:true}` 的 Bot 设置页显示 OfficeCLI 为“系统默认”，不再显示“未设置默认技能”。
- 继承项取消勾选时写入 `disabledSkills`，不会粗暴关闭所有继承。
- 重新勾选时移除对应 disabled 项。
- option contract 能表达 `system-default`、`assistant-preset`、`manual` 来源。
- 中文显示名分别为“Office 文件”“Word 文档”“Excel 表格”“PowerPoint 演示文稿”。

运行：

```bash
cargo test -p mia-core-bot
node --test tests/starter-engine-bots.test.js tests/bot-store-ui.test.js tests/bot-manager-contact-sort.test.js tests/skill-catalog-zh.test.js
```

预期：starter 只有空 enabledSkills，Core UI 只看 raw enabled，因此失败。

### 4.2 实现通用 Bot 默认值

- Rust `upsert_starter_bot` 与 Cloud starter 写入：

```json
{
  "inheritEngineDefaults": true,
  "enabledSkills": [
    "mia-official:officecli-docx",
    "mia-official:officecli-xlsx",
    "mia-official:officecli-pptx"
  ]
}
```

- `manualBotDefaultCapabilities()` 从 shared manifest 追加同一组三项，不复制字符串。
- 现有用户明确的 `disabledSkills` 保持不变。

### 4.3 实现有效技能投影和单项禁用

- Core capability options 读取 common manifest 并返回 `checked`、`source/origin`、`inherited`。
- summary 按有效技能数量计算。
- 切换 inherited/preset 项时写增量 enabled/disabled，不切换全局继承开关。
- renderer 只渲染 Core 返回的真实来源，不制造占位“已启用”。

### 4.4 跑绿并提交

```bash
cargo test -p mia-core-bot
node --test tests/starter-engine-bots.test.js tests/bot-store-ui.test.js tests/bot-manager-contact-sort.test.js tests/skill-catalog-zh.test.js
git add crates/mia-core-bot crates/mia-core-api-types scripts/serve-cloud.js src/renderer/bot src/renderer/skills/skill-helpers.js tests/starter-engine-bots.test.js tests/bot-store-ui.test.js tests/bot-manager-contact-sort.test.js tests/skill-catalog-zh.test.js
git commit -m "fix(bot): 展示并管理真实默认技能"
```

---

## 任务 5：Cloud runtime 使用相同有效技能并预装 OfficeCLI

**文件：**

- 修改：`src/cloud-agent/runtime-assembly.js`
- 新建：`scripts/install-officecli-runtime.sh`
- 修改：`scripts/deploy-cloud-release.sh`
- 修改：`scripts/install-cloud-release-local.sh`
- 修改：`scripts/build-cloud-release.js`
- 修改：`scripts/doctor-cloud.js`
- 修改：`docs/cloud-deployment.md`
- 修改测试：`tests/cloud-agent-runtime-assembly.test.js`
- 修改测试：`tests/deploy-scripts.test.js`
- 修改测试：`tests/install-cloud-release-local.test.js`
- 修改测试：`tests/cloud-doctor.test.js`

### 5.1 先写 Cloud 有效技能失败测试

创建只有 `inheritEngineDefaults:true` 的 Cloud Bot，断言 materialization 包含 `mia-official:officecli`，明确禁用后不包含。断言消息 JSON/body 不含 OfficeCLI 技能正文。

```bash
node --test tests/cloud-agent-runtime-assembly.test.js
```

### 5.2 先写 Cloud 安装策略失败测试

Shell/Node 静态与 fixture 测试断言：

- 国内安装器 `https://d.officecli.ai/install.sh` 在 GitHub raw URL 之前。
- 安装器先写临时文件，再执行；不存在 `curl ... | bash`。
- 使用独立共享 HOME（默认 `/opt/mia-agent-runtime/officecli`），最终 binary 为 `$HOME/.local/bin/officecli`。
- 安装脚本验证 `officecli --version`，失败时退出非零。
- deploy 与 local install 都调用同一脚本。
- systemd PATH 包含 OfficeCLI binary 目录。
- doctor 报告 binary path 和可读取版本。
- Cloud release 携带安装脚本、shared manifest 和四个技能。

```bash
node --test tests/deploy-scripts.test.js tests/install-cloud-release-local.test.js tests/cloud-doctor.test.js tests/cloud-release-handoff.test.js
```

### 5.3 实现 Cloud runtime assembly

`runtime-assembly.js` 复用 `@mia/shared/skill-defaults` 的 resolver，不再只读 raw `enabledSkills`。active message chip 仍作为 turn-local 增量。

### 5.4 实现共享主机预装

`install-officecli-runtime.sh`：

1. 已有可执行版本则直接验证通过。
2. 建立专用 runtime HOME。
3. 以短连接超时下载国内安装器到临时文件。
4. 国内下载失败才取 GitHub raw 安装器。
5. 使用受控 `HOME`/`PATH` 执行上游脚本；由上游版本化 release + `SHA256SUMS` 机制校验 binary。
6. 再执行目标 binary `--version`，失败即中止。
7. cleanup trap 删除临时安装器。

deploy/local install 把路径写进 systemd 环境。不得在测试中访问生产主机，也不得实际部署。

### 5.5 跑绿并提交

```bash
node --test tests/cloud-agent-runtime-assembly.test.js tests/deploy-scripts.test.js tests/install-cloud-release-local.test.js tests/cloud-doctor.test.js tests/cloud-release-handoff.test.js
git add src/cloud-agent/runtime-assembly.js scripts/install-officecli-runtime.sh scripts/deploy-cloud-release.sh scripts/install-cloud-release-local.sh scripts/build-cloud-release.js scripts/doctor-cloud.js docs/cloud-deployment.md tests/cloud-agent-runtime-assembly.test.js tests/deploy-scripts.test.js tests/install-cloud-release-local.test.js tests/cloud-doctor.test.js tests/cloud-release-handoff.test.js
git commit -m "feat(cloud): 预装并验证 OfficeCLI"
```

---

## 任务 6：离线安装 smoke 与三个 CLI 的原生发现验证

**文件：**

- 新建：`tests/officecli-installer-policy.test.js`
- 新建：`tests/officecli-native-engine-smoke.test.js`
- 按失败结果修改：任务 1–5 的聚焦模块

### 6.1 安装策略 fixture 测试

使用临时 HTTP server 伪造镜像和 GitHub：

- 镜像成功时 GitHub 未被请求。
- 镜像失败时请求 GitHub。
- 两者都失败时退出非零且不留下目标 binary。
- 假上游安装器只在临时 HOME 写入 fake `officecli`，不会修改真实 `~/.local`、shell rc 或用户 Agent 目录。

### 6.2 三引擎运行时 smoke

在临时 workspace/session 中生成相同 session plan，检查：

- Claude Code 实际能列出 `.claude/skills/officecli`。
- Codex 实际能列出 `.codex/skills/officecli`。
- Hermes 真实 PATH 版本为可支持 `skills.external_dirs` 的版本；以临时 HOME/config 读取 `${MIA_HERMES_SKILLS_DIR}` 并发现技能。
- 所有消息输入均只包含自然用户话术，不包含由 Mia 拼接的技能正文。

如果本机缺少某个 CLI 或版本不符，按仓库规则停下并报告实际 PATH/version，不用 mock 宣称真实引擎通过。

### 6.3 安装 OfficeCLI 到临时 HOME 并验证真实命令

用国内镜像下载官方 installer 到临时文件，在临时 HOME 执行，然后运行：

```bash
officecli --version
officecli --help
```

保存命令结果作为验收证据，不把临时目录或日志提交。

### 6.4 跑绿并提交

```bash
node --test tests/officecli-installer-policy.test.js tests/officecli-native-engine-smoke.test.js
git add tests/officecli-installer-policy.test.js tests/officecli-native-engine-smoke.test.js
git commit -m "test(office): 覆盖安装与三引擎发现"
```

---

## 任务 7：完整自动化回归和真实前端用户链路验收

**文件：**

- 仅在真实失败暴露问题时修改相应聚焦模块和测试。
- 不提交生成的 `.docx/.xlsx/.pptx`、截图、Trace 日志或临时 HOME。

### 7.1 全量静态、Node 和 Rust 验证

```bash
npm run check
npm test
cargo test --workspace
npm run cloud:release
npm run cloud:install:verify
```

任何失败都先复现为最小定向测试，再修复；不得删除既有断言来换绿。

### 7.2 通过 Mia 前端分别测试 Claude Code、Codex、Hermes

使用真实用户话术，不使用测试 token、元指令或“只回复某字符串”：

1. “帮我做一份一页的周报 Word，标题是本周产品进展，包含完成事项、风险和下周计划；做好后帮我检查文件能不能正常打开。”
2. “把这份周报里的三类内容整理成 Excel，增加负责人和状态两列，再加一个完成率公式；请检查公式和文件格式。”
3. “根据周报做一份三页的汇报 PPT：首页、进展、风险与计划；完成后检查排版和文件有效性。”

每个引擎都必须实际完成至少一轮创建和一轮修改；检查：

- 用户发送的消息在前端可见。
- 助手主动正常回复。
- Trace 里是实际技能读取、installer/OfficeCLI 工具调用、validate/view，不是 Mia 伪造文字。
- 文件落盘且是有效 OpenXML。
- `officecli validate` 成功；`view` 或结构读取成功。
- 模型、effort、permission 继续显示引擎真实值，Mia Auto 模型仍使用 Mia Logo。

### 7.3 Cloud 发布级验证

- 检查生成 release 包含技能、manifest、许可证、installer。
- 用本地 verify/dry-run 验证安装顺序与 PATH。
- 不连接或部署生产服务器；真实云端对话留到发布授权后的 smoke。

### 7.4 最终差异审计、提交和推送

```bash
git status --short
git diff --check
git log --oneline --decorate -8
git push
```

只提交 OfficeCLI 本次范围内文件，不纳入用户或其他并行工作改动。最终报告精确列出：自动化结果、三个引擎真实前端结果、Cloud 未部署边界、commit 和 push 分支。

---

## 当前任务完成后的立即下一步

OfficeCLI 原生接入验收并推送后，立即新建 `officecli watch` 内嵌预览设计，涵盖 Core 进程所有权、Preload 窄 IPC、renderer 安全预览、自动刷新、元素选择、端口/退出/文件锁和跨平台边界。本计划不提前混入预览代码。
