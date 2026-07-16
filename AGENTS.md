# Mia Agent 工作指南

这份文件只写全仓库通用规则。具体目录的写法、命令、边界和项目内模式，放到最近的子目录 `AGENTS.md`。

## 项目形态

Mia 是 Electron 桌面应用，带 Cloud、Web 和 Expo/React Native 移动端。桌面端是主产品面。

- 主进程：`src/main.js`、`src/main/`、`src/shared/` 负责系统能力、IPC 注册、运行时进程、持久化、云同步和引擎适配。
- 渲染进程：`src/renderer/` 负责 DOM、视图状态、界面模块和 CSS。
- Preload：`src/preload.js` 是 renderer 调用 Electron/main 能力的唯一桥。
- Cloud：`scripts/serve-cloud.js` 和 `src/cloud/` 负责 HTTP API、SQLite store、云端设置、社交数据和技能市场接口。
- Mobile：`apps/mobile-rn/` 是 Expo/React Native，必须把桌面/云端共享 contract 当成外部 API 使用。

Mia 对 Claude Code、Codex、Hermes 采用“系统优先、私有稳定版兜底”：先探测并复用用户系统 CLI；用户明确点击启用后，才从 Mia 备份源按需下载固定版本到私有目录。私有版本不得写全局 PATH 或覆盖用户 CLI，桌面安装包不得携带三引擎资源。

外部 Agent 集成以稳定可用和成熟上游方案优先。引擎差异集中在 `src/shared/agent-engine-policy.js`；不要把同一套权限/home/model 规则散落到 adapter、settings 和 renderer。无论实际运行系统版还是 Mia 稳定版，都复用原生用户数据：Codex 使用 `~/.codex`，Hermes 使用 `~/.hermes`，Claude Code 使用原生默认用户环境。伙伴级模型、推理强度由 Mia 在每次运行时显式传入，权限是引擎级设置。用户在 Mia 中修改权限时，只对需要用户级配置的引擎做一次 apply；不要做每次运行前的配置 sync，也不要为了形式上的隔离维护私有用户 home。

## 常用命令

选择能证明改动的最小命令：

```bash
npm run check
npm test
npm start
npm run web
npm run cloud
```

Cloud 发布和部署脚本都在 `package.json` 的 `cloud:*` 下。用户没有明确要求时，不要运行部署、签名、公证、发布或打包命令。

桌面打包命令：

```bash
npm run dist:mac
npm run dist:mac:intel
npm run dist:win
```

普通源码改动不要为了验证去打正式包。优先跑定向 `node --test ...` 和 `npm run check`。

## 验证与用户实测

自动化测试和真实用户实测回答不同的问题：测试证明代码与 contract 没有明显回归；从前端按正常用户方式操作并看到正确结果，才算用户体验真正验收。

- 涉及聊天、Agent、任务、设置、持久化或其他用户可见行为时，在自动化测试通过后，条件允许应再走一次真实前端链路。
- 实测使用用户会自然输入的话术和界面入口，不用测试暗号、后台伪造消息或直接调用内部接口代替用户操作。
- 按功能核对完整可见结果，例如用户消息、流式回复、Trace、模型/effort/permission、任务列表、未读状态，以及刷新或重启后的持久化。
- 后端、CLI、IPC 或数据库检查可以帮助定位问题和证明底层状态，但不能单独证明前端体验已经正常。
- 纯内部重构、无界面影响的 contract 调整或当前环境无法启动完整链路时，可以不做前端实测；交付时要明确已验证范围和尚未实测的部分。

## 必须停下来的情况

遇到环境阻塞时停下来问用户，不要反复重试：

- Electron app 正在运行，导致 app bundle、更新文件、签名输出或 release 产物被锁。
- `web`、`cloud`、`bridge` 或本地 agent runtime 端口被未知进程占用。
- 命令会写真实用户数据目录，例如 `~/Library/Application Support/Mia`；测试必须用临时目录或 fixture。
- Hermes 或其他 CLI 行为和源码预期不一致；先确认 `PATH` 上实际二进制版本，或查看云端镜像 pin。
- 脚本需要生产凭据、签名 secret、Apple 公证凭据、Expo token 或部署 SSH 权限，而当前任务没有明确要求。

不要 kill 未确认的进程，不要删除被锁产物，不要改全局 Git/npm/系统设置来绕过这些问题。

## 仓库卫生

- 保持被修改文件原有换行风格，不要引入 UTF-8 BOM。
- commit 标题必须有中文摘要；可以保留 conventional commit 前缀，例如 `fix(agent): 清理失效会话映射`。
- 不要把无关工作区改动放进同一个提交。这个仓库经常有并行中的未提交改动。
- 不要提交生成日志、打包产物、本地缓存、临时凭据或用户数据。
- 根 `AGENTS.md` 不放 session memory、任务转录、临时状态快照和会过期的上下文。

## 代码组织

`src/main.js`、`src/renderer/app.js`、`src/renderer/styles.css` 已经是宽入口文件。新工作应该让它们变薄，或者只做外科手术式小改。

- 新主进程行为放到 `src/main/<feature>/` 或已有聚焦模块，再从入口装配。
- 新 renderer 行为放到 `src/renderer/<feature>/` 或聚焦 feature 文件，用明确的 `window.miaXxx.init...({ deps })` 边界接回入口。
- 跨进程共享字符串放到 `src/shared/` 或所属 feature contract。
- 新 CSS 放到 `src/renderer/styles/<feature>.css`，除非只是现有 selector 的极小调整。
- 不要新建 `utils.js`、`helpers.js`、`common.js` 这种语义桶文件；辅助模块也要按领域命名。
- 对已有成熟范式的交互、协议、渲染或状态机制，先查本仓库既有模式和参考项目的真实实现，理解其状态模型、命中边界和失败路径，再落地；不要用视觉近似或自创简化替代成熟机制。

往大入口文件加代码前先回答：

1. 这段能不能放进 feature 模块，再由入口装配？
2. 这个抽象是不是当前任务必须？
3. 相邻清理能不能不做，或拆成独立提交？

答不上就先继续读代码，不要急着改。

## 跨进程 Contract

- Renderer 不直接用 Node 或 Electron API。
- Main 不写 DOM 逻辑。
- Preload 只暴露窄接口，不暴露大对象或原始 IPC。
- IPC channel 名称集中在 `src/shared/ipc-channels.js` 或所属 shared contract。
- 测试尽量引用同一份 contract 常量，不复制旧字符串。
- 每个持久状态机只能有一个 owner。聊天、任务、runtime、cloud settings、social state 不要在 desktop/web/mobile 各写一套。

## 持久化

持久化格式必须向后兼容：

- SQLite schema 变更要有可重复运行的 migration 和旧数据升级测试。
- JSON settings、本地 cache 新字段要有默认值。
- 字段重命名要兼容旧字段读取。
- 二进制/位置相关序列化字段不要插入中间；只能追加，并用读边界保护。
- secret 只进 keychain、用户私有配置或环境机制，不进仓库文件和日志。

## 日志

日志要服务诊断，不制造噪音。

- 使用稳定英文模块 tag，例如 `[HermesRuntime] started runtime process`。
- `warn` 用于可恢复降级，`error` 用于需要调查的失败。
- caught error object 作为最后一个参数传给日志。
- 不加逐 token、逐 tick、heartbeat、polling、函数入口日志。
- 临时 instrumentation 完成后必须删掉。

## 子目录规则入口

- 主进程规则：`src/main/AGENTS.md`
- 渲染进程规则：`src/renderer/AGENTS.md`
- 技能规则：`src/renderer/skills/AGENTS.md`
- Cloud 规则：`src/cloud/AGENTS.md`
- Mobile 规则：`apps/mobile-rn/AGENTS.md`
- 参考项目和 UX 研究指针：`docs/agent-reference-projects.md`
