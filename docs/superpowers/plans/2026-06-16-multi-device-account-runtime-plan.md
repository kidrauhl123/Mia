# Mia 同账号多设备运行改造计划

日期：2026-06-16

## 背景

这里的“多设备”不只指桌面、Web、移动端互通，也包括同一个 Mia 账号在多台电脑同时运行桌面端。目标是让用户清楚知道某个 Bot 当前运行在哪里，并保证设备离线、过期、冲突时不会发生多个桌面同时执行、错误设备执行或状态被悄悄覆盖。

## 产品原则

- Bot 是账号级对象，一个 Bot 当前只有一个运行位置。
- 运行位置可以是 Mia Cloud，也可以是某台桌面设备。
- 用户标签只用于用户整理内容，不承载运行位置。运行位置用系统状态 chip 或说明文案展示。
- 远程控制是允许的：B 设备可以使用运行在 A 设备上的 Bot。
- 改运行位置时只允许改成本机或 Mia Cloud，避免在当前设备上随意指定第三台设备。
- 任何目标设备缺失、过期、离线或超时，都必须显示明确错误，不允许 fallback 到其他设备执行。
- 任务必须云端同步，不能继续以某台电脑的本地 JSON 作为主存储。

## 范围

1. Bot 运行位置展示和状态说明。
2. Desktop-local Bot 调用的目标设备校验和错误处理。
3. Bot 创建、编辑运行位置的多设备交互收敛。
4. 桌面设备 ID 冲突检测和自动修复。
5. Profile 实时同步广播。
6. 定时任务云端化。

## 现状摘要

- `bot_runtime_bindings` 当前是账号级单份绑定，符合产品方向；`desktop-local` 的目标设备存于 `config.deviceId`。
- Cloud dispatcher 和旧群聊 @bot 路径仍可能在缺少 `targetDeviceId` 时广播执行事件。
- 桌面端 dispatcher 在 `targetDeviceId` 为空时会执行 invocation，这是同账号多电脑乱跑的主要风险。
- Bot 创建和编辑入口目前会展示所有设备，不符合“创建只选本机或 Mia Cloud”的交互。
- 同一个 `deviceId` 的新 bridge 连接会关闭旧 socket，正常重连可用，但复制数据目录到另一台电脑时会互相挤掉。
- `PATCH /api/me/profile` 没有广播事件，其他设备不能实时更新用户信息。
- 任务链路仍是本机 daemon `/api/tasks` + `mia-tasks.json` + 本机 scheduler。

## 实施计划

### 1. Bot 运行位置展示

- 保留账号级 runtime binding。
- 在 runtime summary 中输出稳定状态字段：
  - `cloud`
  - `current_device`
  - `remote_online`
  - `remote_offline`
  - `stale_device`
  - `invalid_config`
- Bot 列表、联系人详情、聊天 header 使用系统 chip 或二级说明展示运行位置。
- 不使用用户标签表达运行位置。

### 2. 执行保护和错误处理

- Cloud 侧在广播 `conversation.bot_invocation_requested` 前校验 desktop-local binding。
- `desktop-local` 必须有 `targetDeviceId`。
- 目标设备不存在时，向当前对话追加可见错误消息。
- 目标设备离线时，向当前对话追加可见错误消息。
- 目标设备在线但执行超时时，保留现有超时错误并明确设备名。
- 桌面端收到无目标 desktop-local invocation 时直接拒绝，作为最后一道保险。
- 旧的群聊 @bot 路径必须和 cloud-agent dispatcher 走同一套校验，不能裸广播 `ai_perms_json`。

### 3. 创建和编辑运行位置

- 创建 Bot 只展示：
  - 本机
  - Mia Cloud
- 已有 Bot 详情仍展示当前运行位置，包括远程设备在线/离线状态。
- 在当前设备 B 编辑一个运行在设备 A 的 Bot 时，只能改成设备 B 或 Mia Cloud。
- 如果当前绑定的设备 A 已失效，详情展示“运行设备已失效”，编辑入口仍只提供本机和 Mia Cloud。

### 4. 设备 ID 冲突处理

- 桌面 bridge 连接上报设备指纹，不包含敏感明文。
- 服务端遇到同账号同 `deviceId`：
  - 指纹一致：按正常重连处理。
  - 指纹不一致：拒绝新连接并返回 `device_identity_conflict`。
- 客户端收到冲突后重新生成 `mia-device.json`，再自动重连。
- 保留稳定重连行为，新增复制数据目录冲突测试。

### 5. Profile 实时广播

- 新增 `user.profile_updated` 持久事件。
- `PATCH /api/me/profile` 成功后广播该事件。
- main Cloud events client 收到后写入 `mia-cloud.json` 的 `user`。
- renderer 收到后更新 `state.runtime.cloud.user`，刷新设置页、头像、名字和 UID。
- Web 端复用同一事件。

### 6. 任务云端化

- 新增 Cloud 表：
  - `scheduled_tasks`
  - `scheduled_task_runs`
- 任务字段至少包含：
  - `user_id`
  - `bot_id`
  - `conversation_id`
  - `title`
  - `prompt`
  - `trigger_json`
  - `timezone`
  - `runtime_kind`
  - `target_device_id`
  - `next_fire_at`
  - `status`
  - `version`
  - `created_at`
  - `updated_at`
- Cloud server 成为任务调度 owner。
- UI、preload、main IPC 和 scheduler MCP 改为 Cloud API 优先。
- desktop-local 任务到点后只投递目标设备。
- 目标设备离线时任务进入等待或失败状态，不由其他设备代跑。
- 旧 `mia-tasks.json` 只作为迁移来源，迁移后不再作为主存储。

## 验证清单

- 同账号两台电脑同时在线，desktop-local Bot 只在目标设备执行。
- 缺失 `targetDeviceId` 的 invocation 被拒绝。
- 目标设备离线时不会在当前设备执行，并在对话中出现明确错误。
- 创建 Bot 只显示本机和 Mia Cloud。
- 已有 Bot 详情能展示远程设备的在线/离线状态。
- 复制数据目录造成 deviceId 冲突时，新设备能自动重建设备 ID。
- 修改昵称、头像、状态徽章后，另一台设备实时更新。
- A 设备创建任务，B 设备能看到同一任务。
- desktop-local 云端任务只由目标设备执行。
- 目标设备离线时任务不会被其他设备执行。
