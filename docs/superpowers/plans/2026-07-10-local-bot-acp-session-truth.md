# 本地 Bot ACP 会话真值实施计划

> 设计依据：`docs/superpowers/specs/2026-07-10-local-bot-acp-session-truth-design.md`
>
> 状态：已实施并完成三引擎桌面实测（2026-07-10）。

## 1. 建立真实 ACP 控制项领域模型

- 在 API types 增加会话控制项快照、选项、设置请求/响应 contract。
- 在 runtime 增加 advertised/observed snapshot，只接受 ACP 返回的数据。
- 先写 serialization 与 snapshot 派生失败测试，再实现。

## 2. 捕获 session/new/load/update 真值

- Native ACP 保存完整 new/load response。
- 合并 `ConfigOptionUpdate`、`CurrentModeUpdate` 和 model/mode 状态。
- legacy models/modes 只在对应 config option 缺失时生成控制项。
- 测试 Hermes 没有 thought_level 时不生成 effort。

## 3. 实现会话 prepare 与 reconcile

- RuntimeSessionManager 增加 prepare、snapshot、set_control。
- RuntimeTurnPlan 带明确 desired model/effort/permission。
- prompt 前使用真实 config/model/mode RPC reconcile。
- 对不在 advertised options 中的值返回错误。

## 4. 接通真实权限决定

- NativeAcpPermissionBroker 为 pending request 保存一次性 waiter 和引擎原始 permission options。
- native ACP request_permission 根据真实 mode 自动选择或等待用户决定。
- response route 唤醒对应 ACP 请求。
- 覆盖 allow once、allow always、deny、cancel 测试。

## 4.1 接入 Mia Auto

- 未显式选择模型的 Hermes、Claude Code、Codex 都默认路由到 `mia-auto`。
- Hermes 使用带路径令牌的本机 OpenAI-compatible 代理，兼容 Hermes 对回环地址密钥的安全过滤。
- Claude Code 使用 Anthropic-compatible 本机代理。
- Codex 使用 Responses-compatible 本机代理，并在 app-server 启动前注入 Mia 模型元数据目录。
- Renderer 将 `mia_provider` 映射到既有 Mia model profile，沿用既有 Mia Logo。

## 5. 暴露会话控制接口

- ConversationService 构建不落消息的 runtime plan。
- Router 增加会话 runtime prepare/read/set routes。
- Preload 暴露窄接口。
- 保持旧 bot runtime-control-options 仅用于非活跃/云端场景；本地活跃会话不再依赖它合成值。

## 6. 修复 Bot engine 回退

- 缺少 binding 时从 Bot identity 建立正确 engine binding。
- 调用方统一使用规范化 runtime kind。
- 增加 Claude Code、Codex 保存和重开不变 Hermes 的回归测试。

## 7. Renderer 改用会话快照

- 对话打开时 prepare，发送前等待 ready。
- model/effort/permission 只从真实 controls 渲染。
- 删除“使用 CLI 模型”“CLI 默认”和选项首项兜底。
- 设置成功后以 Core 返回的 observed snapshot 更新。

## 8. 验证

- 定向 Rust/Node 测试。
- `npm run check` 与相关完整测试。
- 重启 Mia。
- Hermes、Claude Code、Codex 逐一完成真实发送、回复、控制项和重开验证。
