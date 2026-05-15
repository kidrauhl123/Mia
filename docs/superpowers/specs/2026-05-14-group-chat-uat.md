# Group Chat v1 UAT Checklist

按顺序跑完。任一项失败 → 记录现象 → 修 → 重跑该项及后续。

## 创建

- [ ] 至少有 2 个本地 Fellow 已配置（不行先建）
- [ ] 点侧边栏"+ 新建群聊" → dialog 弹出
- [ ] 勾 1 个 Fellow → 创建按钮无反应 / 提示成员不足
- [ ] 勾 6 个 Fellow → 提示成员超限
- [ ] 勾 2-5 个 Fellow → host 下拉填充正确
- [ ] 留空群名 → 创建成功，默认名为成员名拼接
- [ ] 创建后侧边栏出现该群，自动打开

## 群聊基础

- [ ] 用户发"@<X> 你好"（X 为成员之一）→ 只有 X 响应
- [ ] 用户发不带 @ 的消息 → conductor 选出 0-3 个 Fellow 响应
- [ ] 群里出现群主皇冠 👑 标记在群主 Fellow 发言旁
- [ ] 长消息 Fellow 响应能滚动到底部

## 跨引擎

- [ ] 群里同时包含 Hermes Fellow 和 Claude Code Fellow（或 Codex Fellow），两者都能响应
- [ ] Hermes Fellow 响应里能看出它"知道"群上下文（例如它能复述群里前面发生的事）
- [ ] Claude Code Fellow 响应里能看出它"知道"群上下文

## 摘要

- [ ] 发 4 条用户消息后 → DevTools console log 出现摘要触发
- [ ] 验证 `engine-home/groups/<id>/context-card.json` 写入
- [ ] 第 5、6、7、8 条之后再次触发新摘要

## 错误降级

- [ ] 关掉 Hermes 引擎，群主 Fellow 用 Hermes → 用户发不带 @ 的消息 → 群里出现 system bubble "群助手暂时不在线"
- [ ] 把单 Fellow 的引擎搞坏 → 该 Fellow 气泡显示错误，其他 Fellow 正常
- [ ] 在 drawer 里点"重置群上下文" → 确认弹窗 → context-card.json 清空

## 群成员管理

- [ ] Drawer 改群主 → 群里下条 Fellow 响应使用新群主的引擎
- [ ] Drawer 移除非群主成员 → system bubble "X 离开了群"
- [ ] Drawer 移除群主 → system bubble "X 离开了群, Y 成为群主"
- [ ] 移除到只剩 1 Fellow → 提示"转为单聊？"，点取消保留群

## 持久化

- [ ] 重启 app → 所有群仍在侧边栏
- [ ] 打开群 → 历史消息加载
- [ ] 群信息（成员、群主、目标）正确保留

## 目标 / pinnedGoal

- [ ] Drawer 写"今天把 X 做完" → 保存 → 重开 drawer 仍保留
- [ ] (v2 才有完整 nudge 机制；v1 仅验证保存)

## 边界

- [ ] 创建一个仅 2 Fellow 的群，运行 1 小时，无明显内存膨胀（粗略观察）
- [ ] 在群和 1v1 之间切换，状态不串
- [ ] 群主 Fellow 在群里"接话"后，去单聊找他，单聊历史不包含群里的话（验证 stateless 调用没污染 session）

## 已知 v2 范围（不测）

- 桌宠同屏
- Todos / 完整 decorations
- 大群 (>5 Fellow)
- 跨设备实时同步
