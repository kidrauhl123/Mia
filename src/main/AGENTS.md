# src/main 工作指南

这里是 Electron 主进程和桌面本地能力层。写法要像操作手册：清楚谁拥有状态、谁注册 IPC、谁起进程、谁落盘。

## 目录职责

- `src/main.js` 只做启动、窗口、模块装配和少量全局生命周期。不要继续把业务逻辑塞进来。
- `src/main/ipc/` 放 IPC 注册模块。新增 channel 时优先建或扩同领域 IPC 文件。
- Bot 对话和 utility turn 的 Agent 引擎入口统一走 Rust Core conversation/runtime routes；不要把 Claude/Codex/Hermes 的 prompt 直连路径重新接回 Electron main。
- 已删除的 Node utility runtime 直连文件不要恢复。临时 renderer 方法只能做 Core HTTP adapter。
- `src/main/*service*.js` 这类模块负责本地系统、runtime、缓存、设置和云同步。保持单一 owner。
- `src/shared/` 放 main/preload/renderer/cloud/mobile 共用 contract。

## 验证命令

按改动范围选最窄命令：

```bash
node -c src/main/<changed-file>.js
node --test tests/main-*.test.js
node --test tests/project-structure-check.test.js tests/mia-core-ui-adapter.test.js
npm run check
```

不要为了普通 main 变更跑桌面打包。涉及启动链路时，用 `npm start` 手动验证即可。

## IPC 模式

新增 IPC 必须按这个顺序做：

1. 在 `src/shared/ipc-channels.js` 或所属 shared contract 增加 channel 常量。
2. 在 `src/main/ipc/<feature>-ipc.js` 或现有同领域模块注册 handler。
3. 在 `src/preload.js` 暴露窄方法，不暴露裸 `ipcRenderer.invoke`。
4. Renderer 只调用 `window.mia...` / `window.miaXxx...` 方法。
5. 测试覆盖 channel 常量、preload bridge 和 main handler 路由。

Handler 返回值要是可序列化对象。不要把 `BrowserWindow`、Node stream、Error 实例、class 实例直接跨 IPC 返回。

## Agent 引擎和 CLI

- Claude Code、Codex、Hermes 先从用户系统探测；缺失或不可用时，仅在用户明确点击后从 Mia 备份源下载固定版本到 Mia 私有目录。下载必须校验版本和 SHA-256，失败不得写启用标记；私有版本不写全局 PATH、不覆盖系统 CLI，也不进入桌面安装包。
- 探测路径走已有 `shellCommandPath` / 本地引擎服务；不要在业务代码里手写多个 `which`。
- 起进程时传入受控 env；如果用户选定了某个 CLI 绝对路径，PATH 要优先包含该可执行文件目录，避免拿错 node/runtime。
- 每个 adapter 只负责把 Mia 消息、工具、权限、取消信号映射到该引擎。共享状态放 registry 或 shared contract。
- 引擎 runtime 策略集中在 `src/shared/agent-engine-policy.js`。新增引擎时先补 policy 和测试，再接 settings / renderer / adapter。
- 外部 Agent 的用户级配置是正常集成入口。Codex 固定使用用户 `~/.codex`；Hermes 使用用户原生 `~/.hermes`；Claude Code 使用原生默认用户环境。伙伴级模型、推理强度由 adapter 每次运行显式传入，权限按引擎级设置保存。用户修改权限时，只对需要用户级配置的引擎做一次 apply；不要做每次运行前的配置 sync。
- Hermes 行为以实际安装版本或云端镜像 pin 为准，不要假设上游源码就是用户正在跑的二进制。

## Runtime 生命周期

- 起子进程的模块必须负责停止、错误处理、退出码记录和 app quit 清理。
- 不要在 main 里吞掉 runtime 启动失败。给 renderer 返回可展示的错误摘要，同时在 main log 里保留原 error。
- 端口占用时先确认 owner；不要直接 kill 未确认进程。
- 长轮询、heartbeat、streaming token 不打 info 日志。

## 桌面 Daemon 单 Owner

启用 desktop daemon 时，它是桌面端唯一大脑：

- 云 WebSocket、bot 执行、`mia-cloud.json` 写权归 daemon。
- 窗口进程是视图和控制面，经 `127.0.0.1` daemon control API 对接。
- 只有 daemon 被用户关闭，或探活失败/不可达时，窗口才接管执行与凭据写兜底。
- 任一时刻 owner 只能有一个，不能让窗口和 daemon 同时写同一份 durable state。
- 例外：`conversation-cache.db` 的低频 REST 镜像写保留在窗口。

新增直连云、直写共享文件、runtime 执行路径前，先看 `docs/adr/2026-06-12-desktop-single-owner-daemon.md`。

## 持久化和设置

- SQLite、JSON 设置、runtime cache 的新字段必须有默认值。
- migration 要可重复运行，不能依赖“只执行一次”的隐含状态。
- 写真实用户目录的代码不能被测试直接调用；测试必须注入临时目录。
- Cloud settings、daemon control、desktop sync 这类单 owner 数据，不要再开第二条写路径。

## 禁止事项

- Main 不写 DOM。
- Main 不直接拼 renderer HTML。
- 不在 main 里硬编码 UI 尺寸、颜色、文案展示结构。
- 不把 secret、token、cookie 打进日志。
- 不用全局 mutable singleton 偷放和当前窗口/账号强相关的状态；先找 canonical owner。
