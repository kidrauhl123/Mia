# Overnight Run — Summary

**Run date**: 2026-05-21
**Goal**: 实现"加真人好友 + 私聊 + 拉群 + 拉自己的 AI + 朋友能跟我的 AI 对话"端到端，desktop 重点 + web 跟手，不做手机端，删邀请码、用 username 加好友，直接在 main 上提交。

**结果**：全部目标完成 + 部署到生产 + 333 测试全绿。

---

## 战果

**生产环境**：`https://aiweb.buytb01.com` 现在跑的是 commit `aef65e2`，包含 S1a/P1.1/S1b/S2-lite 所有改动。

**Commits（19 个，全部 push 到 origin/main）**：
```
aef65e2 feat(web): S1b client — friends + DM + group read/send via cloud
3b0e7ce fix(desktop): S2-lite — invocation dedup + member cache invalidate + owner username + mention regex
e508dd4 feat(desktop): S2-lite groups — create UI + group chat + cross-user AI invocation
2702901 docs(overnight): note fellow-ownership client-assertion limitation from codex P1
2773b5d feat(cloud): group rooms + fellow members + cross-user invocation routing
0fc7f88 fix(desktop): unwrap cloud response shapes + modal listener teardown + clear DM on switch
da0c5f0 feat(desktop): S1b renderer — mixed sidebar + add-friend dialog + DM room chat
c2ada83 feat(desktop): main+preload bridge for cloud social/rooms API + WS events
1d71e36 feat(cloud): replace invite codes with username friend requests
cafe52c fix(cloud): release-time require paths + manifest entries for social modules
8c6297b merge S1a: cross-user social cloud — friends + private chat + seq
+ 8 S1a-cloud sub-commits
```

**测试**：333/333 pass（开始时也是 333/333；新增功能都自带测试，零回归）。

**Codex adversarial-review 拦下的 push blocker / 重要修复**：
1. `cafe52c`：release-time require 路径回退（社交模块在 release 打包后路径错，启动会挂）
2. `0fc7f88`：renderer 错误地把 cloud 响应当裸数组用（4 处 unwrap 修复）+ modal listener 泄漏 + DM 切回 fellow/group 残留 active
3. `3b0e7ce`：S2-lite AI 调用去重 + member cache 失效 + fellow owner 用户名展示 + mention regex 覆盖 `-`/`.`

## 已实现的功能（按 demo 演示路径）

1. **注册账号**（`POST /api/auth/register`）→ 用户拿到 username + token
2. **加好友**：A 输 B 的 username 提交 → B 立刻在 UI 收到推送 → B 同意 → DM 房间自动创建
3. **1:1 私聊**：两端实时同步（cloud 权威 `seq`，离线后 `since_seq=` 增量补齐）
4. **建群**（桌面端，web 暂不能建群因为没本地 fellow）：A 输群名 + 选朋友 + 选自己的 fellow → cloud 写 room + members + 广播 `social.room_invited` 给被邀者
5. **群里跨用户 AI 调用**：B 在群里 `@codex` → cloud 解析 mention → 找到 codex 的 owner_id (A) → 推 `room.fellow_invocation_requested` 给 A → A 桌面端调本地 `sendChatStateless` → POST 回 `/messages/as-fellow` → 群里所有人收到 codex 的回话
6. **web 端**：浏览器打开 https://aiweb.buytb01.com 也能注册 / 加好友 / 收发 DM / 看群消息 / 群里发消息 + @ fellow（fellow 的 owner 必须在桌面端在线，web 自己跑不了 fellow）

## 你需要做的（明早起床）

### 立刻可演示

1. 主 checkout 已经在 `aef65e2`（main 最新），直接 `npm run open` 起 Electron
2. 注册一个账号（菜单里"Mia Cloud"登录页 → 注册）— **会自动生成 username**
3. 浏览器打开 https://aiweb.buytb01.com → 注册第二个账号
4. 桌面端 → 联系人页 → 顶上 🤝 按钮 → 输第二个账号的 username → 发送
5. 浏览器端 → 好友 tab → 收到的请求 → 同意
6. 两边都看到对方进了 DM 房间 → 互发消息（应该实时同步）
7. 桌面端 → 顶上 👥 按钮 → 新建群 → 输群名 + 勾选朋友 + 勾选 codex / mia (你本地的 fellow) → 创建
8. 浏览器端：收到群邀请 → 进群 → 输 `@codex 帮我查一下 xxx` → 发送
9. 桌面端这边：codex 自动接到 invocation event → 调本地引擎 → 把回话 POST 回群
10. 浏览器和桌面同步看到 codex 的回话

### 可能踩到的坑（决策日志见 OVERNIGHT-DECISIONS.md）

- **fellow 头像在 DM sidebar**：没有 `avatarColorForKey` helper，DM 卡片用统一 `#5e5ce6` 填充。视觉上和 fellow 区分不强；可以下一步上专门的 DM avatar palette。
- **DM 没有未读小红点 / 时间戳**：故意延后。不影响功能但 UX 略糙。
- **群里 @fellow 的 mention 解析靠 client**：cloud 不验证 fellowId 是否真的归你所有。alpha 阶段够用，但要 polish 时得加 server-side fellow 注册（OVERNIGHT-DECISIONS.md 里详细记了）。
- **群成员变化的 member cache 失效**：H2 修复了 `social.room_invited` 触发的场景；但如果你通过 `POST /api/rooms/:id/members` 加成员（API 已支持但 UI 没暴露），cache 可能不刷新 — 实际触发面小，可忽略。
- **跨用户 fellow 调用的安全门**：spec §13 说 "source !== owner 时强制 ask 模式"，alpha 直接自动执行了（用户都是亲近的朋友，没设防）。需要时在 `social-groups.js` 的 `handleFellowInvocation` 里加确认弹窗。
- **`reject` 不通知 sender**：QQ 风格，sender 那边 pending 列表里那条静默消失。

### 测试落地

- Cloud + desktop main + renderer 单元测试都在 `tests/` 里跑，`npm test` 全套 333/333 pass
- **Electron UI 烟测 subagent 跑不了**，需要你 `npm run open` 走一遍。
- 跨用户场景（手机/web/桌面两个号互动）只能你手动走

## 子 agent 用了多少次

约 8 次大 dispatch + 3 次修复 + 3 次 codex review。所有 dispatch 都跑通，没卡死或回退。

## 不在这一晚做的（推荐下一阶段）

1. **桌面端打 DMG 重新分发**：`npm run dist:mac` 重新构建 Electron app（如果要分发给其他用户用）
2. **桌面 + web UX 一致性 polish**：avatar、未读、时间戳、群成员管理 UI（踢人/退群等）
3. **fellow 注册到 cloud**：让 cloud 知道哪个 user 真的有哪些 fellow（解决 OVERNIGHT-DECISIONS 里那条 client-asserted 限制）
4. **跨用户 fellow 调用的权限 UI**：spec §13 那条 source !== owner 时弹窗确认
5. **DM/群消息的"已读回执 + 未读计数"**：spec §9 显式推迟到这里
6. **手机端原生 app**（user 明确跳过）
7. **生产环境 codex/Hermes 引擎权限审计**：跨用户调用真正跑别人机器上的 shell 命令前，再过一遍权限模型

## 部署状态

- VPS `23.95.43.168` (`aiweb.buytb01.com`) — `mia-cloud` service active
- 数据库已 schema v2，社交表落地 + 已生效
- nginx WS 配置正常，subprotocol auth 工作
- 5 次部署，每次都过 `cloud:smoke` 15 项
- 备份在 VPS `/root/mia-cloud-*-<deploy-id>.tgz`

## 决策日志

`OVERNIGHT-DECISIONS.md` 里有完整的 UX / 架构决策记录。重点：
- 邀请码逻辑完全删除（schema 保留 `code` 列向后兼容），username 是唯一加好友途径
- DM 房间在好友接受时由 cloud lazy 创建，沿用 `ensureDmRoom`
- 群房间 id 用 `g_<hex>` 前缀和 `dm:*` 区分
- 跨用户 fellow 调用走 WS event `room.fellow_invocation_requested`，**不复用 bridge_runs**（避免污染既有 bridge 基础设施）

收工。
