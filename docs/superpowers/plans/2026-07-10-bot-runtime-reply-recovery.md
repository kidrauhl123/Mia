# 伙伴运行时回复恢复实施计划

> **供执行者使用：** 必须使用 `superpowers:executing-plans` 逐项执行；每个行为改动都按红—绿测试循环完成。

**目标：** 修复伙伴绑定被 intent 覆盖、Cloud 伙伴读取错误绑定、Native ACP 空成功，以及空控件列表阻止发送的问题。

**架构：** Cloud 新增一个纯函数模块，把运行时 intent 合并成待清洗配置；Cloud 路由仍负责鉴权、默认值和持久化。Electron 只调整绑定读取优先级，Core 只调整 Native ACP 缺命令分支，Renderer 只调整控件兜底和发送门禁。

**技术栈：** Node.js、Electron preload/renderer、Rust/Axum、Node test runner、Cargo test。

## 全局约束

- 不推断已经丢失的 engine，也不修改生产数据。
- 不恢复 `npx`、`codex exec` 或其他 ACP fallback。
- 不完整移植 AION 生命周期，不做无关重构。
- 保留当前工作区已有 Rust/ACP 改动。
- 因目标文件包含用户已有未提交改动，不创建包含这些文件的提交，避免把无关改动带入历史。

---

### 任务一：Cloud 运行时 intent 合并

**文件：**

- 新建：`src/cloud/runtime-binding-intents.js`
- 修改：`scripts/serve-cloud.js`
- 测试：`tests/bots-api.test.js`

**接口：**

- 输入：`runtimeConfigInputForRequest({ body, existingConfig })`
- 输出：交给现有 `sanitizeRuntimeConfig` 的普通配置对象。

- [ ] **步骤 1：添加失败的 API 回归测试**

在 `tests/bots-api.test.js` 中先保存完整 desktop-local 绑定，再发送：

```js
{
  runtimeKind: "desktop-local",
  enabled: true,
  controlIntent: { field: "effortLevel", value: "medium", modelEntries: [] }
}
```

断言保存后仍是 `agentEngine: "codex"`、`deviceId: "device-1"`、
`model: "gpt-5.4"`，仅 `effortLevel` 变为 `medium`。再发送旧式完整
`config`，断言它仍然整体替换旧配置。

- [ ] **步骤 2：运行测试并确认正确失败**

运行：

```bash
node --test tests/bots-api.test.js --test-name-pattern="runtime intent"
```

预期：intent 用例失败，结果只剩空 model 和默认 effort；旧式 config 用例通过。

- [ ] **步骤 3：实现最小纯函数合并模块**

模块导出：

```js
function runtimeConfigInputForRequest({ body = {}, existingConfig = {} } = {}) {
  const hasIntent = [body.targetIntent, body.syncIntent, body.controlIntent]
    .some((value) => value && typeof value === "object");
  if (!hasIntent) return body.config && typeof body.config === "object" ? body.config : {};
  const config = { ...existingConfig, ...(body.config || {}) };
  applyTargetIntent(config, body.targetIntent);
  applySyncIntent(config, body.syncIntent);
  applyControlIntent(config, body.controlIntent);
  return config;
}
```

target intent 只改 engine/device；engine 改变时删除模型选择字段。control intent
只改指定字段，模型 intent 同时带入经过现有 sanitizer 允许的 model entries。

- [ ] **步骤 4：让 Cloud 路由读取旧绑定后应用 intent**

在 `PUT /api/me/bots/:id/runtime` 中，仅当请求带 intent 时读取：

```js
const existingBinding = context.runtimeBindingsStore.getBinding(
  auth.user.id,
  botId,
  runtimeKind
);
const configInput = runtimeConfigInputForRequest({
  body,
  existingConfig: existingBinding?.config || {}
});
const config = sanitizeRuntimeConfig(configInput, sanitizeOptions);
```

- [ ] **步骤 5：运行定向测试并确认通过**

运行：

```bash
node --test tests/bots-api.test.js --test-name-pattern="runtime"
```

预期：所有 runtime API 用例通过。

---

### 任务二：Electron 使用 Cloud 伙伴的权威绑定

**文件：**

- 修改：`src/preload.js`
- 测试：`tests/mia-core-ui-adapter.test.js`

**接口：**

- `desktopLocalRuntimeConfig(input)` 继续返回普通 runtime config。
- Cloud 查询失败时仍由 `getBotRuntimeCompat` 回退 Core。

- [ ] **步骤 1：添加失败的源码契约测试**

提取 `desktopLocalRuntimeConfig`，断言它调用：

```js
getBotRuntimeCompat(botId, "desktop-local")
```

并断言函数体不再直接调用 `getCoreBotRuntime`。

- [ ] **步骤 2：运行测试并确认失败**

运行：

```bash
node --test tests/mia-core-ui-adapter.test.js
```

预期：测试显示函数仍直接读取 Core 绑定。

- [ ] **步骤 3：实现最小读取顺序修复**

仅把 `desktopLocalRuntimeConfig` 中的绑定读取替换为：

```js
const response = await getBotRuntimeCompat(botId, "desktop-local");
```

保留 config、binding top-level fields 和单次发送 overrides 的原合并顺序。

- [ ] **步骤 4：运行测试并确认通过**

运行：

```bash
node --test tests/mia-core-ui-adapter.test.js
```

预期：全部通过。

---

### 任务三：Core 禁止 Native ACP 空成功

**文件：**

- 修改：`crates/mia-core-app/src/cloud_bridge.rs`
- 测试：`crates/mia-core-app/src/cloud_bridge.rs` 内部单元测试

**接口：**

- 新增私有判断 `runtime_plan_uses_session_manager(&RuntimeTurnPlan) -> bool`。
- Native ACP 即使缺少 command 也必须进入 `RuntimeSessionManager`，由其返回明确错误。

- [ ] **步骤 1：添加失败的 Rust 单元测试**

构造 `protocol: RuntimeProtocol::NativeAcp`、`command: None`、
`mock_response: None` 的计划，断言：

```rust
assert!(runtime_plan_uses_session_manager(&plan));
```

同时构造无命令 Mock 计划，断言它保持旧的直接 Mock 路径。

- [ ] **步骤 2：运行测试并确认失败**

运行：

```bash
CARGO_INCREMENTAL=0 CARGO_PROFILE_DEV_DEBUG=0 cargo test -p mia-core-app runtime_plan_uses_session_manager -j 1
```

预期：因判断函数尚不存在而编译失败。

- [ ] **步骤 3：实现最小分支修复**

导入 `RuntimeProtocol`，实现：

```rust
fn runtime_plan_uses_session_manager(plan: &RuntimeTurnPlan) -> bool {
    plan.command.is_some() || plan.protocol == RuntimeProtocol::NativeAcp
}
```

Cloud Bridge 使用该函数决定是否调用 `runtime_sessions.send_message`。执行错误时
显式释放 runtime claim 后返回 `CloudError::Runtime`，不生成空成功响应。

- [ ] **步骤 4：运行 Rust 定向测试**

运行：

```bash
CARGO_INCREMENTAL=0 CARGO_PROFILE_DEV_DEBUG=0 cargo test -p mia-core-app runtime_plan_uses_session_manager -j 1
CARGO_INCREMENTAL=0 CARGO_PROFILE_DEV_DEBUG=0 cargo test -p mia-core-app cloud_bridge -j 1
```

预期：全部通过。

---

### 任务四：Renderer 显示只读兜底并解除目录门禁

**文件：**

- 修改：`src/renderer/app.js`
- 修改：`src/renderer/social/contact-card.js`
- 测试：`tests/renderer-shell.test.js`
- 测试：`tests/contact-card-ownership.test.js`

**接口：**

- `activeBotRuntimeSendBlock()` 只响应明确的 `sendBlocked`。
- 空选项使用带 placeholder 的只读控件，不保存 placeholder 值。

- [ ] **步骤 1：把现有隐藏行为测试改成目标行为测试**

断言：

```js
activeBotRuntimeSendBlock() === null
```

适用于 options 未加载和 `modelOptions: []`；`sendBlocked: true` 仍返回原因。
同时断言 composer/contact card 在空列表时包含“使用 CLI 模型”“CLI 默认”，
但对应 select 为 disabled。

- [ ] **步骤 2：运行测试并确认失败**

运行：

```bash
node --test tests/renderer-shell.test.js tests/contact-card-ownership.test.js
```

预期：旧实现仍隐藏控件并以空 modelOptions 阻止发送。

- [ ] **步骤 3：实现最小 UI 修复**

`activeBotRuntimeSendBlock` 改为：

```js
function activeBotRuntimeSendBlock() {
  if (!activeConversationBotContext()) return null;
  const options = runtimeControlOptionsForContext(activeBotRuntimeControlContext());
  if (options?.sendBlocked) {
    return { reason: options.sendBlockReason || options.statusText || "Agent 不可用" };
  }
  return null;
}
```

同步控件时始终显示三个位置；有选项时可交互，没有选项时放入单个 placeholder
并禁用。contact card 使用相同的只读文案，不显示可点击保存行为。

- [ ] **步骤 4：运行 UI 定向测试并确认通过**

运行：

```bash
node --test tests/renderer-shell.test.js tests/contact-card-ownership.test.js tests/renderer-social.test.js
```

预期：全部通过。

---

### 任务五：整体验证与交付

**文件：**

- 检查所有上述修改文件
- 更新本计划中的完成状态

- [ ] **步骤 1：运行跨边界定向测试**

```bash
node --test tests/bots-api.test.js tests/mia-core-ui-adapter.test.js tests/renderer-shell.test.js tests/contact-card-ownership.test.js tests/renderer-social.test.js
CARGO_INCREMENTAL=0 CARGO_PROFILE_DEV_DEBUG=0 cargo test -p mia-core-runtime --tests -j 1
CARGO_INCREMENTAL=0 CARGO_PROFILE_DEV_DEBUG=0 cargo test -p mia-core-app cloud_bridge -j 1
```

- [ ] **步骤 2：运行仓库检查**

```bash
npm run check
```

- [ ] **步骤 3：检查差异边界**

```bash
git diff --check
git status --short
```

确认没有部署、生产数据写入、生成产物或无关清理。
