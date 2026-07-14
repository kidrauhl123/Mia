# Mia Hermes 式有界记忆设计

日期：2026-07-14
状态：已获用户确认
范围：桌面端主产品、Cloud runtime，以及 Hermes、Codex、Claude Code 三套原生 Agent 引擎

## 背景

Mia 是运行在 Hermes、Codex、Claude Code 等原生 Agent 引擎之上的 Bot GUI。原生引擎负责推理、工具调用、项目规则和会话恢复；Mia 额外拥有引擎不知道的产品概念：稳定 Bot 身份、Bot 名字与头像、用户账号，以及同一 Bot 跨引擎持续存在的关系。

当前 Mia 记忆实现包含按条目持久化、搜索、列表、多个作用域、优先级、置信度、近似去重、外部 provider 和五个 MCP 工具。它比产品需要的伙伴记忆更重，也与 Hermes 内置 bounded memory 的简单心智模型不一致。

同时，三套原生引擎都可能加载自己的长期记忆。若 Mia 记忆与原生记忆并存，会出现重复注入、矛盾事实、写错存储和跨 Bot 串记忆。原生记忆的作用域是引擎 home、profile 或项目，而不是 Mia 的 bot_id，因此不能作为 Mia Bot 关系记忆的 owner。

## 目标

Mia 记忆采用 Hermes 内置 bounded memory 的核心可观察行为：

1. 记忆内容是少量、可读的纯文本条目。
2. 一份用户公共记忆供所有 Bot 使用。
3. 每个 Bot 按不可变 bot_id 拥有自己的专属记忆。
4. 新原生 session 启动时完整注入一次冻结快照。
5. 当前 Bot 在对话中主动使用一个 memory 工具维护记忆。
6. 不依赖用户手动编辑，不使用后台审查 Agent。
7. 不做语义搜索、向量检索、自动历史提取或冷热分层。
8. 在 Hermes、Codex、Claude Code 间切换引擎时，Bot 记忆保持不变。
9. 设置开关允许新对话在 Mia 记忆与原生 Agent 记忆之间选择，但同一对话始终只有一个记忆 owner。

## 非目标

- 不同步、导入或合并原生引擎的长期记忆。
- 不让 Mia 写入 Hermes、Codex、Claude Code 的原生记忆文件。
- 不提供 memory read、list 或 search 工具。
- 不保留 session 级长期记忆作用域。
- 不运行回合后 reviewer、session reset flush 或后台总结任务。
- 不新增用户手动编辑记忆的产品入口。
- 不用 LLM 自动解决迁移、同步或并发冲突。
- 不把对话历史当作长期记忆；原生 session history 仍由原生引擎负责。
- 不在 Mia 与原生 Agent 记忆之间同步、复制或自动切换已有内容。

## 核心决策

### 对话级单一记忆 Owner

每个 Mia 对话创建时固定一个 memory mode。Mia 模式由 Mia 作为长期关系记忆 owner；Native 模式完全交给当前原生 Agent。两种模式互斥，不能在同一个原生 session 中同时读取或写入两套长期记忆。

| 内容 | Mia 模式 | Native 模式 |
| --- | --- | --- |
| 当前对话历史、上下文压缩、原生 session resume | 原生引擎 | 原生引擎 |
| AGENTS.md、CLAUDE.md、SOUL.md、项目规则和技能 | 原生引擎 | 原生引擎 |
| 用户公共画像、Bot 专属关系记忆 | Mia | Mia 不提供；由原生引擎自定 |
| 原生引擎 auto memory | 在该 Mia runtime 内关闭 | 按用户原生配置运行 |

Mia 模式关闭原生长期记忆时，只作用于 Mia 启动的进程或 session。Mia 不修改用户的全局配置，也不维护私有 Codex/Hermes home。用户离开 Mia 后直接运行原生引擎时，原生记忆保持原样。

### 记忆模式开关

设置页开关选择新建对话的默认 memory mode：

| 开关 | memory mode | 行为 |
| --- | --- | --- |
| 开启 | mia | 使用 Mia Hermes 式有界记忆，并隔离当前原生引擎的长期记忆 |
| 关闭 | native | 不注入、不暴露、不读写 Mia 记忆，由原生 Agent 按自身设置处理 |

内部持久设置使用枚举 memory.mode = mia 或 native，而不是继续让 enabled 同时表示“是否有任何记忆”。读取旧设置时保持向后兼容：

- enabled 缺失或 true 映射为 mia。
- enabled = false 映射为 native。

默认值是 mia。切换设置不删除或修改任何 Mia 记忆，也不修改任何原生记忆。

memory mode 在创建 Mia conversation 时写入 conversation metadata，之后不可随全局开关变化。原生 session 丢失并在同一 conversation 内重建时，继续使用 conversation 已固定的模式。这样用户切换设置时不会偷偷重启已有对话、清空上下文或改变已经注入的记忆。

### 作用域

Mia 暴露两个记忆 target：

- user：当前用户的公共画像，所有 Bot 可读写。
- memory：当前 Bot 的专属关系记忆，只对当前 bot_id 可见。

bot_id 是记忆归属键。Bot 改名、换头像或更换底层引擎不改变记忆归属。工具调用不能传任意 bot_id，只能操作当前 runtime 已绑定的 Bot。删除 Bot 时删除或同步 tombstone 其专属记忆；用户公共记忆保留。

### Hermes 有意差异

Mia 对齐 Hermes 核心行为，但保留以下产品差异：

1. Hermes profile 各自拥有 USER 与 MEMORY；Mia 的 USER 在同一用户的所有 Bot 间共享，MEMORY 按 bot_id 隔离。
2. Hermes 某些 gateway 流程会在 session reset 前执行 memory flush；Mia 不运行后台 flush。
3. Hermes 使用本地 Markdown 文件；Mia 可继续使用 Core SQLite 和 Cloud sync，但存储元数据不得进入 Agent 可见的记忆语义。
4. Mia 模式在自身 runtime 内关闭原生引擎记忆；Native 模式不干预原生记忆。

## 文本模型

### 文档与容量

每个作用域表现为一个有序纯文本文档：

| Target | 用途 | 上限 |
| --- | --- | --- |
| user | 用户身份、偏好、沟通方式和稳定习惯 | 1,375 字符 |
| memory | 当前 Bot 的个人笔记和双方关系事实 | 2,200 字符 |

条目支持多行，以单独一行的 § 分隔。持久化与容量计算使用规范化序列化：条目去除首尾空白后，以换行、§、换行连接。字符数按 Unicode code point 计算，并包含分隔符。条目保持插入顺序；replace 保持原位置，remove 删除目标条目及相邻多余分隔符。

记忆内容不包含 ID、标签、优先级、置信度、访问次数、来源引擎或时间戳。数据库和 Cloud sync 可以内部保存 revision、updated_at、tombstone 等一致性字段，但这些字段不进入注入块和 memory 工具语义。

### 注入格式

Mia 模式的新原生 session 创建时，Mia 读取 user 与当前 Bot memory，渲染两个有明确边界的冻结块。每块显示名称、使用比例和字符数，条目以 § 分隔。空文档可以省略条目正文，但仍允许工具工作。Native 模式不读取或渲染这些块。

示意：

    USER PROFILE [40% — 550/1,375 chars]
    用户喜欢简洁、直接的中文回答
    §
    用户位于 Asia/Shanghai

    MEMORY [18% — 396/2,200 chars]
    我们把 Mia 的长期记忆确定为 Hermes 式有界文本

注入内容必须被标记为 Mia 持久事实，不得把记忆正文解释为可覆盖 system、developer、项目规则或当前用户明确指令的新指令。

## Session 生命周期

### 新 session

conversation 的 memory mode 在创建时固定。Mia 模式的冻结快照在原生 session 创建后、第一条用户消息交给 Agent 前装配一次。运输层优先使用引擎支持的 session 初始 instruction；统一 ACP 路径无法提供独立 system/developer 槽位时，使用现有 initialPromptPrefix 在第一条 prompt 前追加一次。Native 模式不装配 Mia 记忆前缀。

### 继续与恢复

- 同一原生 session 的后续回合不重新读取、不重复注入。
- App 重启后成功 load 或 resume 同一原生 session 时不重新注入。
- 原生 session 不存在并创建 fresh session 时，读取并注入最新记忆。
- 当前 session 内的 memory 写入立即持久化，但不改变冻结快照。
- 调用 memory 的 Agent 通过工具响应知道最新 live state；未来新 session 才从启动快照看到新内容。
- 同一 Bot 的另一个已打开旧 session 不实时刷新，直到它创建新原生 session。
- 修改设置开关不影响已经存在的 conversation；只影响切换后创建的新 conversation。

现有 ACP 会话层已经区分 fresh 与 restored session。实现不得把记忆放进每回合的 refreshMcpContext，也不得通过 per-turn search 模拟读取。

策略上线前已经创建的原生 session 可能同时含有 Mia 与原生引擎记忆，无法从现有上下文中安全移除。不得静默重置正在使用的旧 session。用户创建新对话后获得互斥 owner 的完整新语义。

## Memory 工具

Mia 模式只向 Agent 暴露一个 memory 工具。MCP 运输层可以按引擎规则给工具加 server namespace，但工具 schema 和行为保持一致。Native 模式不向 Agent 暴露任何 Mia memory 工具；不能保留工具定义再在调用时返回 disabled。

### add

输入：

- action = add
- target = user 或 memory
- content = 新条目

行为：

- 空内容失败。
- 完全相同的条目返回成功但不重复写入。
- 安全扫描通过且加入后不超限时，追加到文档末尾。

### replace

输入：

- action = replace
- target = user 或 memory
- old_text = 唯一子串
- content = 新条目内容

行为：

- old_text 只匹配一个条目时替换该条目。
- 零匹配或多匹配失败，不修改状态。
- 替换后超限失败，不修改状态。

### remove

输入：

- action = remove
- target = user 或 memory
- old_text = 唯一子串

行为：

- old_text 只匹配一个条目时删除。
- 零匹配或多匹配失败，不修改状态。

### 响应

每次工具响应返回：

- success
- action 与 target
- current_entries
- used_chars、limit_chars 和 usage_percent
- no-op、错误原因或下一步清理建议

工具没有 read、list、search、memoryId、scope、confidence、priority 或 reason 参数。

## 主动记忆规则

Agent 应主动保存未来 session 仍有价值的稳定信息，不等待用户进入编辑界面：

- 保存用户明确偏好、身份、沟通方式和稳定习惯到 user。
- 保存当前 Bot 与用户的关系事实、共同约定和该 Bot 以后需要知道的个人笔记到 memory。
- 用户明确要求记住时应调用工具，但仍需通过安全扫描。
- 不保存一次性任务细节、临时路径、原始日志、代码块、可重新搜索的公共知识、凭据或已经存在于项目规则中的内容。
- 记忆接近容量时，Agent 先 replace 合并或 remove 清理，再 add。

## 原生引擎隔离

### Hermes

Mia 模式创建 Hermes Agent 时使用上游运行级 skip_memory=true，使 Hermes 不读取或写入原生 MEMORY.md、USER.md，也不暴露原生 memory 工具。保留 AGENTS.md、SOUL.md、技能、工具和原生 session。

Native 模式不传 skip_memory，由 Hermes 按用户 ~/.hermes 配置读取和维护原生记忆。

本地 Hermes 必须先探测实际版本或能力；云端镜像必须 pin 到支持该参数的版本。Mia 模式下，如果当前 Hermes runtime 不能安全关闭原生记忆，启动新 session 应返回明确的不兼容错误，不能静默回退到双记忆，也不能修改用户全局 config.yaml。Native 模式不依赖该隔离能力。

### Codex

Mia 模式启动 Codex runtime 时使用单次运行配置覆盖：

- memories.use_memories=false
- memories.generate_memories=false

继续复用用户真实 ~/.codex。不得修改用户 config.toml，不改变 AGENTS.md、skills、MCP、权限、模型或原生 session 行为。

Native 模式不传这两项覆盖，由 Codex 按用户自己的 memories feature 和 task 配置运行。原生记忆未启用时，Native 模式不承诺自动提供记忆。

### Claude Code

Mia 模式启动 Claude Code runtime 时设置：

- CLAUDE_CODE_DISABLE_AUTO_MEMORY=1

不得设置 CLAUDE_CODE_DISABLE_CLAUDE_MDS，因为 CLAUDE.md 和项目 rules 属于原生项目上下文，必须保留。

Native 模式不设置 CLAUDE_CODE_DISABLE_AUTO_MEMORY，由 Claude Code 按用户自己的 auto memory 设置运行。

### Native 模式边界

Native 模式采用 AION 式边界：Mia 只负责 GUI、conversation 与原生 session 绑定，不拥有长期记忆。

- Native 模式不保证记忆按 Mia bot_id 隔离。
- Native 模式不保证在 Hermes、Codex、Claude Code 间共享。
- Native 模式不保证引擎已经开启原生记忆。
- 若既有 Native conversation 支持切换引擎，记忆 owner 随当前引擎改变，Mia 不迁移旧引擎的原生记忆；固定不变的是 conversation 的 native 模式。
- 从 Mia 模式切换为 Native 模式不会把已有 Mia 记忆复制给原生引擎。
- 从 Native 模式切换为 Mia 模式不会导入原生引擎记忆。
- 已有 Mia 记忆保持休眠；以后创建新的 Mia 模式 conversation 时重新可用。

## 安全与失败处理

- 写入前扫描 prompt injection、凭据外传、SSH 后门、危险持久命令和不可见 Unicode；命中时拒绝写入。
- 容量超限不截断、不自动删除、不后台压缩；返回 current_entries 和 usage，要求当前 Agent 在同一回合清理后重试。
- 数据库修改必须原子完成。
- 持久化失败时工具明确失败，不能让 Agent 误以为已经记住。
- 存储记录不存在时视为空文档并按正常写入创建。
- session 启动读取失败时不中断聊天，记录稳定英文模块 tag 的诊断警告，并以空 Mia 记忆启动；损坏内容不得注入模型。
- 用户消息中伪造的 Mia memory 标题或分隔符必须经过现有 runtime context spoof neutralization。
- Cloud sync 只是 Mia owner 的传输层，不生成、总结或改变记忆正文。冲突必须沿用单 owner revision/tombstone contract。

## 旧数据迁移

旧布尔设置先迁移为 memory.mode。数据库为 conversation metadata 增加 memoryMode；升级前已有 conversation 按升级时的全局 memory mode 回填，但不重启其活跃原生 session。升级后的设置切换只影响随后创建的新 conversation。

当前 memory_entries 数据不直接删除。首次迁移按 user 与 bot 两个长期作用域分组：

1. 忽略已删除条目和 session 作用域条目，不把会话临时状态提升为长期关系记忆。
2. 对完全相同文本去重。
3. 每个分组按 updated_at 降序选择能装入目标容量的最近条目，再恢复为从旧到新的展示顺序。
4. 未进入有界文档的旧条目保留在 legacy migration 存储中，不参与注入、搜索或日常写入，也不形成新的产品级 archive。
5. 迁移过程不调用 LLM，不修改原生引擎记忆，不丢弃旧数据库内容。

迁移后新的 memory 工具只操作有界文档。旧五工具 contract 退出 Agent runtime；需要兼容 Cloud 或旧客户端时，只能在边界 adapter 内转换，不得重新进入模型可见工具集合。

## UI 边界

- 用户通过自然对话形成和改变记忆。
- 不新增手动新增、编辑、搜索或删除记忆的主产品入口。
- 设置开关标题表达为“新对话使用 Mia 记忆”，避免让用户误以为关闭代表没有任何记忆。
- 开启说明 Mia 按 Bot 身份提供跨引擎记忆；关闭说明完全交给原生 Agent，不保证跨 Bot 或跨引擎共享。
- 文案明确“仅对新建对话生效”和“已有 Mia 记忆不会删除”。
- 建议说明文案：“开启后，Mia 按 Bot 身份管理跨引擎记忆。关闭后，Mia 不读取、写入或注入记忆，由当前原生 Agent 按自身设置处理；不同 Bot 和引擎之间不保证共享。仅对新建对话生效，已有 Mia 记忆不会删除。”
- 诊断场景可以显示只读容量和模式状态，但不能形成第二个写 owner。
- Trace 应显示 memory 工具调用、target、动作、成功或失败；默认不展开完整敏感记忆正文。

## 测试

### 文本与工具单元测试

- § 序列化、多行条目、Unicode 字符计数和使用率。
- add 成功、完全重复 no-op、空内容失败。
- replace/remove 的零匹配、唯一匹配和多匹配。
- user 1,375 与 memory 2,200 字符边界。
- 超限不变更、current_entries 和 usage 响应。
- 安全扫描和不可见 Unicode 拒绝。
- 写入失败无部分状态。

### 作用域与持久化

- user 在同一用户所有 Bot 间共享。
- memory 严格按 bot_id 隔离。
- Bot 改名、换头像和更换引擎后仍读取同一 memory。
- 删除 Bot 只删除其 memory，保留 user。
- App 重启和 Cloud sync 后文本与顺序不变。
- 所有测试使用临时目录或测试数据库，不触碰真实用户数据。

### Session 注入

- conversation 创建时保存 mia 或 native 模式，设置切换不改变已有 conversation。
- Mia 模式 fresh session 恰好注入一份 user 与一份 memory。
- 同一 session 第二回合不注入。
- load/resume 成功时不注入。
- load/resume 找不到并 fresh rebuild 时注入最新快照。
- 当前 session 写入后冻结快照不变，新 session 读取最新版。
- 两个已打开 session 不做版本刷新。
- 不出现 per-turn memory search 或重复 memory block。
- Native 模式 fresh session 不读取、不注入 Mia 记忆，也不暴露 Mia memory 工具。
- Native 模式 session rebuild 继续使用 conversation 已固定的 native 模式。

### 三引擎隔离

- Mia 模式 Hermes Agent 以 skip_memory 启动，不加载原生 MEMORY.md/USER.md，不暴露原生 memory 工具。
- Mia 模式 Codex 进程获得两项单次 memories=false 覆盖，用户 ~/.codex 配置文件不改变。
- Mia 模式 Claude Code 进程设置 CLAUDE_CODE_DISABLE_AUTO_MEMORY=1，同时仍加载项目 CLAUDE.md。
- Native 模式 Hermes 不传 skip_memory，Codex 不传 memories 覆盖，Claude Code 不设置 auto memory 禁用变量。
- Native 模式不暴露 Mia memory 工具，不同步两套记忆。
- 三套引擎继续使用真实原生 session resume。
- Mia 的记忆模块和引擎 adapter 不直接写 ~/.codex、~/.hermes、~/.claude 的原生记忆；Native 模式允许原生引擎自行写入。
- Mia 模式遇到不支持隔离能力的 Hermes 版本明确失败，不静默形成双记忆；Native 模式仍可按原生行为运行。

### 真实前端验收

1. 创建 Bot A 与 Bot B。
2. 用自然话术告诉 Bot A 一个用户偏好和一个双方关系事实。
3. 在 Trace 中看到 Bot A 主动调用 Mia memory 工具。
4. 创建 Bot A 新对话，确认它记得两类信息。
5. 创建 Bot B 新对话，确认它知道公共用户偏好，但不知道 Bot A 的专属关系事实。
6. 修改 Bot A 名字或头像，再开新对话，确认记忆仍然存在。
7. 分别用 Hermes、Codex、Claude Code 创建新对话，确认同一 Bot 读到同一份 Mia 记忆，且 Trace 中只有一个记忆工具。
8. 连续多轮对话，确认上下文中记忆块只有一份。
9. 重启 Mia，再次确认持久化和原生 session resume。
10. 关闭开关后创建新对话，确认没有 Mia 记忆块和 Mia memory 工具，且原生 Agent 记忆按其自身设置工作。
11. 再次开启开关，确认已有对话模式不变，新建对话恢复使用未被删除的 Mia 记忆。

只有自动化和可用环境下的三引擎真实前端链路都通过，功能才算完成。若某个本地 CLI 版本不兼容，交付必须明确记录该版本和未实测范围，不能用模拟响应代替。

## 完成标准

- Mia 模式下，Agent 可见的 Mia 记忆模型只有两个有界文本 target 和一个 memory 工具；Native 模式下不暴露 Mia 记忆模型。
- 每个 conversation 固定一种 ownership mode，并在任一时刻只有一个记忆 owner：Mia 或当前原生 Agent。
- Mia 模式关闭该 runtime 的原生长期记忆；Native 模式完全不干预原生记忆。
- 用户全局原生环境不被修改，两种模式之间不复制或同步记忆。
- Mia 记忆只在 Mia 模式的 fresh 原生 session 注入一次。
- Mia 模式下，Bot 改名、换头像、切换引擎和 Cloud sync 不改变记忆归属；Native 模式明确遵循当前引擎自己的作用域。
- 设置切换只影响新建 conversation，不重启或改变已有 conversation。
- 当前重型搜索、provider extraction 和五工具模型不再参与 Agent runtime。
- 所有失败都明确、可诊断，且不产生静默截断或双写；Mia 模式不得跨 Bot 泄漏，Native 模式的隔离边界由原生引擎决定并明确告知用户。
