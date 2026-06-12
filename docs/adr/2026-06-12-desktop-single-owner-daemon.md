# ADR: 桌面端唯一大脑 —— daemon 拥有云会话与执行权，窗口是纯视图

**Date:** 2026-06-12
**Status:** Accepted
**Related:** [2026-05-22 Conversation state canonical owner](./2026-05-22-conversation-state-canonical-owner.md)

## Context

桌面端目前有两个长命进程：前台窗口进程（`electron .`）和后台守护进程
（`--daemon`，launchd 拉起）。它们是**对等的**：各自维护到 Mia Cloud 的
WebSocket（events + bridge），各自有完整的 bot 执行栈（local-bot-responder
→ chatEngine adapters），并**共享同一个 engine-home 下的可变文件**
（`mia-cloud.json` 登录态+事件游标、`conversation-cache.db`、各设置文件）。

没有 owner 的代价在 2026-06-12 一天内集中爆发，五个线上问题里四个同源：

| 问题 | 直接根源 |
|---|---|
| 日常使用随机退出登录 | 两进程并发读改写 `mia-cloud.json`，半截读 + `!token` 分支落盘清空凭据 |
| 同一提问出现两条不同回答 | 两进程都执行同一 invocation（`shouldHandleLocalCloudConversationAi` 注释自认：游标共享，只好"都跑，云端 clientOpId 去重"），双倍 token |
| 必须重启 App 才能看到回复 | 前台、daemon 各连各的云 events socket，前台的僵死后无人接管 |
| 瞬时 401 误销毁凭据 | 任一进程都有权清除共享凭据 |

已打的补丁（events 心跳、settings 原子写+凭据保护、401 复核）都是症状层
的创可贴：**共享所有权不消除，补丁会无穷增殖**（下一个本来要打的是
"跨进程执行抢锁"）。本 ADR 选择消除病因。

## Decision

**daemon 是桌面端唯一的本地大脑；前台窗口是连接到 daemon 的纯视图。**

所有权矩阵（"写"含创建/更新/删除；违反矩阵的 PR 不应合入）：

| 资源 | 唯一 owner | 窗口进程的访问方式 |
|---|---|---|
| 云 WebSocket（/api/events、/api/bridge） | daemon | 不直连；经 daemon 本地通道接收转发事件 |
| bot invocation 执行（所有 engine run） | daemon | 不执行；只渲染 run 事件流 |
| `mia-cloud.json`（凭据 + 事件游标） | daemon | 只读，或经 daemon 控制 API 读写 |
| `conversation-cache.db` | daemon 写 | 只读（SQLite WAL 支持并发读） |
| 其余 engine-home 设置文件 | daemon | 经 daemon 控制 API |
| 窗口几何、外观等纯 UI 偏好 | 窗口进程 | （与 daemon 无关，留在窗口侧） |

模式规则（互斥，永不并存）：

- **daemon 启用（默认）**：上表生效。窗口进程的云连接栈、执行栈不启动。
- **daemon 被用户关闭**（设置里的开关）：窗口进程接管全部 owner 角色——
  仍然是"单 owner"，只是 owner 换人。切换时序由开关动作驱动：先停一方，
  再启另一方，不允许重叠窗口期。

登录流程：扫码 UI 留在窗口，拿到的 token **经 daemon 控制 API 交给 daemon
落盘**，窗口自己不写凭据文件。

崩溃语义：daemon 由 launchd `KeepAlive` 自动复活；窗口经本地通道断线检测
daemon 死亡，等待复活期间 UI 显示降级状态，不抢角色。

本地通道：复用既有 daemon 控制服务器（127.0.0.1:27861，token 鉴权）。事件
转发在其上加一条本地 WS/长连接（daemon → 窗口单向推送云事件 + run 事件）。

## Consequences

- 双跑、写竞态、僵尸前台连接、凭据误清这四类缺陷**在定义上消失**，对应的
  防御补丁可在迁移完成后删除（clientOpId 幂等保留——它同时服务多设备语义）。
- 桌面只剩一条云连接对（events + bridge），云端连接数减半。
- 窗口进程变薄，符合 CLAUDE.md "入口变薄" 方向；`main.js` 中云/执行栈的装配
  代码最终全部走 `IS_DAEMON_PROCESS` 分支或删除。
- 新功能规则：**任何新的云交互或本地执行能力，先问 owner 是谁**。给窗口进程
  加直连云、直写共享文件的代码一律拒绝。
- 代价：daemon 成为单点；由 launchd KeepAlive + 窗口侧健康提示兜底。本地通道
  多一跳延迟（局域回环，可忽略）。

## Migration plan（分阶段，每阶段独立可发布）

**P0 通道加固（前置）**
控制服务器加 `/events` 本地推送通道（daemon → 窗口）与版本/健康握手。
窗口侧建一个薄客户端模块（`src/main/daemon/local-channel-client.js`）。
验收：窗口能经本地通道收到 daemon 转发的心跳事件。

**P1 执行权收归 daemon（先杀双跑）**
`shouldHandleLocalCloudConversationAi` 改为：daemon 进程 → 是；窗口进程 →
仅当 daemon 设置关闭。删除"都跑靠云端去重"注释与依赖。
验收：发消息只产生一次 engine run；daemon 关闭时窗口兜底仍能回复。

**P2 云事件流收归 daemon（杀僵尸连接与游标共享）**
窗口进程不再创建 cloud-events-client；改为订阅 P0 本地通道，daemon 把云事件
原样转发（含 renderer 需要的全部类型）。`lastEventSeq` 从此只有 daemon 写。
验收：拔掉窗口直连后，消息实时性不退化；杀掉 daemon，窗口显示降级提示，
daemon 复活后自动续传（游标在 daemon 手里，不丢段）。

**P3 凭据与设置单写者**
`writeCloudSettings` 等共享文件写入在窗口进程内改为调用 daemon 控制 API；
登录流程的 token 落盘改走同一路径。窗口对 engine-home 只读。
验收：并发压测（高频事件 + 登录/登出）下凭据文件内容始终合法。

**P4 消息缓存单写者**
`conversation-cache.db` 写入移到 daemon（它本来就在收事件）；窗口只读。
验收：窗口冷启动从缓存渲染正常；无 `SQLITE_BUSY`。
*实施备注（2026-06-12）：高频写（消息事件流）随 P2 已归事件流 owner；
窗口保留的唯一写入是低频 REST 镜像（social bootstrap 快照——daemon 侧
没有对应数据源，强行经 API 中转属过度设计）。以 WAL + busy_timeout
保证两进程罕见重叠时退化为短等待而非 SQLITE_BUSY，验收语义不变。*

**P5 减法清理**
删除：窗口进程的 cloud-events/bridge 装配、双跑防御（执行抢锁不再需要）、
游标共享注释；保留：clientOpId 幂等（多设备）、settings 原子写（防御纵深）。
更新 CLAUDE.md 指向本 ADR。

每阶段配套：单元测试随阶段交付；P1/P2 各加一条端到端冒烟（发消息→单次
run→单条回复→窗口实时可见）。

## 对并行贡献者（含其他 AI 会话）的约束

迁移期间：不要给窗口进程新增任何直连云或直写 engine-home 的代码路径；
新的云交互一律按所有权矩阵落位。与本 ADR 冲突的在途改动，合入前先对齐。

## Alternatives considered

- **跨进程原子锁（按 dedupKey 抢锁执行）**：能 100% 杀双跑，但只医一个症状，
  写竞态、僵尸连接、凭据误清依旧；且给系统再加一个活动部件。否决。
- **去掉 daemon，只留窗口进程**：最简单，但放弃"关窗口仍在线/定时任务"这一
  产品承诺。否决。
- **窗口与 daemon 各连各的云但选主执行（ping 探测）**：~99% 单跑，TOCTOU
  窗口仍在，且不解决另外三类问题。否决。
