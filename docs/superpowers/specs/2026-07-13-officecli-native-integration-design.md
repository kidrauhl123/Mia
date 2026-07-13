# OfficeCLI 原生接入设计

## 目标

Mia 原生接入 iOfficeAI/OfficeCLI，让普通用户无需手动配置技能即可让 Mia、Claude Code、Codex 和 Hermes 创建、读取、修改并验证 `.docx`、`.xlsx`、`.pptx` 文件。

本次范围包括上游技能原文、系统默认能力、本机按需安装、云端预装、真实 Trace、设置页有效技能展示，以及本地三引擎和云端发布链路的自动化与真实文件验证。本次不实现 Office 文档内嵌预览；当前接入完成后立即为 `officecli watch`、自动刷新和元素选择编写下一阶段设计。

## 不可妥协的约束

- 不通过 system prompt、用户消息或其他 prompt 拼接注入技能，也不保留这种 fallback。
- Claude Code、Codex、Hermes 必须通过各自原生技能目录发现 OfficeCLI 技能。
- 技能正文逐字节保留固定上游版本，Mia 只维护独立的接入元数据和适配文件，避免自行缩写造成质量下降。
- OfficeCLI 继续作为用户系统或云端运行环境中的外部 CLI，不进入 Electron `extraResources`，不随桌面安装包捆绑。
- 本机缺少 OfficeCLI 时允许按需自动安装；安装命令、工具输出和失败必须进入真实 Agent Trace，不生成伪造的安装事件或占位回复。
- 云端主机在 release 安装阶段预装 OfficeCLI，短生命周期 Agent 工作区不重复下载安装。
- 安装失败直接暴露真实工具错误，不静默切换到 Python、旧 Office 技能或纯文本模拟。
- Mia 默认模型和模型 Logo 规则不因本功能改变。
- Cloud 部署代码和验证必须随仓库准备好，但没有单独部署授权时不修改生产服务器。

## 上游来源与归属

接入以下四份技能：

- `officecli`
- `officecli-docx`
- `officecli-xlsx`
- `officecli-pptx`

`officecli` 通用技能逐字节取自 OfficeCLI 官方 tag；三个专项技能逐字节取自 AionCore 的固定提交。首次导入记录：

- OfficeCLI tag：`v1.0.135`
- OfficeCLI tag commit：`d2d9c60f44537004c3e1f46680c24ea38d9659c2`
- AionCore reference commit：`abbcd7823d4165781c2d9f6bacadc6bdbe17aef2`
- OfficeCLI repository：`https://github.com/iOfficeAI/OfficeCLI`
- AionCore repository：`https://github.com/iOfficeAI/AionCore`

仓库保存 Apache License 2.0 正文和第三方归属说明。同步脚本以固定上游版本更新 vendored 技能并输出内容摘要；构建和应用启动不联网同步。对正文的任何 Mia 专有改动必须进入独立适配文件，不能混进 vendored 原文。

## 能力分层

Mia 采用 AION 的两层默认模型：

1. `officecli` 是系统自动技能。所有 `inheritEngineDefaults !== false` 的 Bot 都能原生发现它，用户可明确禁用。
2. `officecli-docx`、`officecli-xlsx`、`officecli-pptx` 是通用助手角色预设。Mia 云端初始 Bot、本地三个初始 Bot 和手动创建的通用 Bot 默认拥有它们；专业模板可在此基础上增加角色技能。

Bot 保存的仍是用户或模板的增量选择。运行时有效技能按以下公式解析：

```text
(系统自动技能 - disabledSkills) + 模板/角色技能 + enabledSkills + 当前消息 skill chip
```

解析结果必须由一个共享 manifest 定义。Rust Core、本机 Node 兼容读取器、Cloud runtime assembly 和 renderer 投影读取同一份 manifest，不分别硬编码默认列表。

设置页展示有效结果的来源，例如“系统默认”“助手预设”“手动添加”，而不是只读取原始 `enabledSkills`。已有 Bot 在保留用户显式禁用项的前提下自动获得新的系统默认技能，不批量重写数据库记录。

## 原生技能数据流

会话启动时，Rust Core 根据 Bot、模板、禁用项和当前 skill chip 解析有效技能。它把技能目录链接到引擎原生位置：

- Claude Code：工作区 `.claude/skills/`
- Codex：工作区 `.codex/skills/`
- Hermes：Hermes 当前安装版本实际支持的原生技能目录；实施前用 PATH 上真实二进制确认，不假设上游路径。

Cloud Claude Code 使用每个用户/会话现有隔离工作区中的 `.claude/skills/`。技能正文不进入消息 body；用户消息缓存、云端消息存储和 Trace 中都不得出现由 Mia 拼接的技能正文或技能索引。

Agent 在遇到 Office 文件任务时通过原生技能加载 OfficeCLI 指令，然后真实运行 `officecli`。创建、修改、`view`、`validate` 等命令作为普通 Agent 工具调用进入现有 Trace，不新增第二套伪 Trace。

## 本机安装策略

本机不在应用启动或普通聊天时预装 OfficeCLI。只有 Agent 实际处理 Office 文件且 `officecli --version` 不可用时，才依据上游技能原文运行官方安装器。

国内网络策略为硬要求：

1. 首选 `https://d.officecli.ai/install.sh` 或 `https://d.officecli.ai/install.ps1`。
2. 镜像连接失败后回退 `raw.githubusercontent.com/iOfficeAI/OfficeCLI`。
3. 安装脚本先下载到临时文件，下载完整后再执行；禁止 `curl ... | bash` 与 fallback 输出拼接。
4. 上游安装器继续以版本化、不可变的 release URL 下载二进制，并用 `SHA256SUMS` 验证。
5. 镜像连接采用短连接超时，完整二进制下载采用合理总超时，避免国内用户在坏镜像上长时间卡住。

2026-07-13 的设计验证结果：镜像与 GitHub 返回的 Unix/PowerShell 安装脚本大小和 SHA-256 完全一致；镜像可解析 `v1.0.135`，版本化 `SHA256SUMS` 和 `SKILL.md` 均返回 HTTP 200。自动化测试验证安装命令的来源顺序、临时文件执行和 checksum 约束；网络可用性属于发布前 smoke，不作为离线单元测试依赖。

测试安装不得写真实用户目录。测试使用临时 `HOME`/`LOCALAPPDATA` 或只读探测已经安装的 OfficeCLI。真实前端测试若触发首次安装，必须沿用户已授权的正常产品链路执行并保留真实 Trace。

## 云端安装策略

Mia Cloud 当前是共享主机运行时加短生命周期用户工作区，不是一用户一容器。因此 OfficeCLI 在 `deploy-cloud-release.sh` 和 `install-cloud-release-local.sh` 的运行时准备阶段安装一次：

- 先探测 `officecli --version`。
- 缺失或版本不满足最低要求时，镜像优先、GitHub 回退地安装。
- 安装结果必须位于 `mia-cloud` 服务用户可执行的共享 PATH。
- systemd 环境显式包含 OfficeCLI 所在目录。
- doctor 验证程序存在、可执行、版本可读取；release dry-run 验证脚本结构但不访问生产服务器。
- 安装失败中止 release 安装并触发现有回滚，不以缺少 OfficeCLI 的状态启动新版本。

Cloud release 继续携带 vendored 技能和 shared manifest。云端 Agent 只链接技能目录，不复制正文进消息。

## 错误处理与可观察性

- 技能解析不到 vendored 目录：会话启动失败并指出缺失技能 ID，不能静默跳过系统默认技能。
- OfficeCLI 未安装：Agent 真实执行官方安装流程。
- 国内镜像失败：工具输出显示回退 GitHub；两个来源都失败时返回真实失败原因。
- checksum 不匹配：删除临时文件并终止安装。
- CLI 命令失败：保留 exit code、stderr 摘要和对应 Trace，不声称文件已完成。
- 生成文件必须在回复前经过 OfficeCLI `validate`，并按格式执行至少一次 `view` 或结构读取。

日志只记录低频生命周期边界和非敏感版本信息，不记录文档内容、用户提示、工具完整输入或文件正文。

## 测试与验收

### 自动化测试

- vendored 四份技能存在、frontmatter 可解析、来源版本与内容摘要匹配。
- Apache 2.0 许可证和第三方归属文件进入桌面与 Cloud release。
- 默认能力解析覆盖继承、明确禁用、模板预设、手动启用和 turn-local skill chip。
- 设置页投影显示有效技能及来源，不把继承状态显示为“没有默认技能”。
- Claude Code、Codex、Hermes 为相同有效技能建立各自原生链接；消息 body 不包含技能正文。
- Cloud runtime assembly 使用相同有效技能，不只读取原始 `enabledSkills`。
- Unix 和 PowerShell 安装策略均为镜像优先、GitHub 回退、临时文件执行。
- Cloud release、install、doctor 和 dry-run 覆盖 OfficeCLI 安装与 PATH。

### 真实文件验证

分别通过 Claude Code、Codex、Hermes 的前端用户链路完成：

- 创建并修改一份 `.docx`，验证文字和格式结构。
- 创建并修改一份 `.xlsx`，验证单元格、公式和 OfficeCLI 校验结果。
- 创建并修改一份 `.pptx`，验证幻灯片、文本元素和渲染输出。

每个任务都必须满足：用户消息可见、助手正常回复、Trace 有真实技能/工具调用、文件存在且是有效 OpenXML、OfficeCLI `validate` 成功。若某引擎不支持预期原生技能目录，先查实际安装版本并修复适配，不用 prompt fallback 让测试通过。

Cloud 在未部署时完成 release 级测试和可重复安装验证；部署后再通过云端 Mia Bot 走同样用户话术完成一组真实文件 smoke。

## 下一阶段：内嵌 Office 预览

本次验收并提交后立即开始独立设计，范围包括：

- Core Office domain 对 OfficeCLI `watch`/`unwatch` 生命周期的单一所有权。
- Preload 窄 IPC 和 renderer 安全预览 URL。
- `.docx`、`.xlsx`、`.pptx` 自动刷新。
- PPT/Word 元素选择与 Agent 后续指令的真实路径传递。
- 端口分配、进程退出、文件锁、跨平台和安全边界。

预览阶段复用本次安装、探测、版本和 Trace 能力，不重新实现第二套 OfficeCLI 管理器。
