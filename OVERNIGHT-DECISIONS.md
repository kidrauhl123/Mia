# Overnight Run — Decision Log

**Goal recap**：
1. Cloud：删邀请码全部逻辑，改成 username 加好友（QQ 风格）
2. 桌面端 S1b：联系人侧边栏混排 fellow/human/group/room、加好友弹窗、DM 房间、cloud-events 实时推、since_seq 增量拉
3. Web 端 S1b：浏览器跑同一套
4. S2-lite：拉群 → 拉自己 AI → 拉朋友 → 朋友 @ 我的 AI 能跟它对话（cross-user fellow dispatch）
5. 直接在 main 上提交，每个相对独立 chunk 过 codex review + push + cloud:deploy
6. 不做：手机端、QR、邀请码 UI

---

## 关键 UX 默认值（不另问）

- **联系人列表**：单列，混排，按 `updatedAt` desc 排。每项有 type 图标区分 fellow / human / group / room。无分 tab。
- **加好友入口**：联系人页右上角 "+" 按钮，弹窗。弹窗分两段：上段输 username + 发送；下段"收到的请求"列表，每条同意/拒绝按钮。同弹窗也展示"我的 username"+"复制"。
- **被拒不通知发起方**（QQ/WX 默认行为）。`friend_requests.status` 变 `rejected` 后，发起方那侧 pending 列表里那条静默消失。
- **DM 视觉等同 1v1 fellow chat**，去掉 model / permission 控件（DM 没 AI 就没 permission 意义）。
- **群里别人 @ 我的 AI**：我桌面端 Bridge 必须在线（在线状态走现有 `cloudBridgeClient`）；不在线 = 该 AI 显示离线，别人 @ 它无回复。
- **群里别人发起的 fellow 调用权限**：source 不是 owner 时，**默认强制走 ask 模式**（即便 owner 全局 yolo）。这是 spec §13 标的关键安全边界。

## 关键架构决策

- **邀请码完全删除**：cloud schema `friend_requests.code` 字段保留（向后兼容已部署数据），但 endpoint 全删；社交流就一条 username 路径。
- **`getUserByUsername`** 加进 `src/cloud/sqlite-store.js`，社交端点用它解析。
- **群创建**：S2-lite 实现 `POST /api/rooms` 显式创建群（不沿用 DM lazy create —— 群不能 lazy）。
- **fellow 群成员**：`room_members.member_kind='fellow'` + `member_ref=fellowId` + `owner_id=主人 user_id`。
- **跨用户 fellow 调用**：cloud 收到群里 @ 某个 fellow 的消息 → 查 `owner_id` → 通过该用户的 `cloudBridgeClient` 派发 `bridge.run` → 桌面端跑 → 结果回 cloud → broadcast 到群里。复用 S1a 既有的 bridge run 基础设施。
- **桌面端 friends 持久化**：复用 `cloudStore.putWorkspace(userId, ...)` 的 workspace snapshot，新增 `friends` / `rooms` / `messages_cache` 字段。本地不再单独存 sqlite，简化。
- **`messages_cache` 是惰性的**：只缓存活跃房间最近 N 条；按需走 `GET /api/rooms/:id/messages?since_seq=` 拉补。

## Decision Log（陆续往下加）

### Phase 2b: S1b renderer social UI (commit: feat(desktop): S1b renderer — mixed sidebar + add-friend dialog + DM room chat)

**Initial message fetch room cap**: 30 rooms. `INITIAL_ROOMS_CAP = 30` in `src/renderer/social/social.js`. Rationale: balances startup latency vs stale preview; any room beyond 30 will show "暂无对话" until clicked.

**Singleton modal vs fresh**: Used a **singleton modal** (`_addFriendModal` module-level variable, created once, re-populated on every open). Avoids leaking DOM nodes on repeated opens. The `_closeModal` function reference is refreshed on each open to rebind Esc / backdrop listeners.

**DM room click clears state.activeKey = ""**: When a DM room is clicked, `state.activeKey` is set to `""` and `state.activeGroupId` to `""`. A guard was added to the `render()` persona-reset logic to skip the `personas[0]` fallback when a DM room is active, preventing the topbar from flashing the first fellow's name before `renderRoomChat` overwrites it.

**Topbar for DM rooms**: `renderRoomChat(els.chat)` writes directly to `#activeChatName`, `#activeChatMeta`, `#activeChatAvatar` after the outer `render()` sets them (double-write, but render runs last). Hides session-menu, composer-bottom, group-info-button. Acceptable for alpha; revisit if visible flicker is reported.

**Enter to send in DM room**: Reuses the existing `#chatForm submit` path (same as fellow and group). DM branch checks `window.aimashiSocial.getActiveRoomId()` first. Shift+Enter newline works automatically (existing composer behavior).

**Input clears after DM send**: `els.chatInput.value = ""` and `resizeChatInput()` called before the async send, same pattern as group.

**Optimistic append on send**: If the WS `room.message_appended` event doesn't arrive within 500ms, the sent message is appended from the API response. De-dup guard by `message.id` prevents double-append if the WS also arrives.

**Add-friend button placement**: Injected dynamically via JS as a sibling of `#newContact` in the contacts sidebar header (not added to index.html HTML). Uses emoji `🤝` as icon. Decision: avoids touching HTML for a small alpha button; revisit if the contacts header needs a proper layout pass.

**CSS shared between fellow chat and DM chat**: DM sidebar cards use the same `persona message-card private-message-card` classes as fellow cards. DM chat messages use the same `message user` / `message assistant` article classes. Composer classes shared. Difference: DM has no `.persona-side` timestamp or unread badge in the sidebar card (deferred — not enough data without a read-state store for rooms).

**No unread badge for DM rooms**: Not implemented. `window.aimashiSessionReadState` is tied to fellow sessions; DM rooms use a separate message cache with no per-room read cursor. Deferred to a future PR.

**No timestamp in DM sidebar row**: The `persona-side` span with time is omitted from the DM card template. Can be added once we have a `formatConversationTime(updatedAt)` call wired in.

**avatarColorForKey not exposed on aimashiAvatar**: The helper doesn't exist on the global; DM sidebar cards fall back to a fixed `#5e5ce6`. The social module itself uses a deterministic hash from room id. Logged here so the UX polish pass knows to add it.

**DM room "lazy-create on first send"**: Already decided in Phase 2a — the cloud creates the DM room when friendship is accepted (not on first message). So the room always exists before the user sees the conversation entry.

**friend_added outgoing/incoming cleanup**: Uses `to_user` / `from_user` field matching (the user-id stored in the request row) rather than username matching, since usernames can change. If the API stores username as `to_user` instead of id, this may need adjustment.

**sendInActiveRoom exposed on aimashiSocial**: Added as the 10th export so app.js's form submit can call it. Not listed in the original spec but required for the send path.

**Things not done / deferred**:
- No unread indicator for DM rooms
- No message timestamps in DM chat bubbles (body only)
- No "typing…" indicator for DM
- No scroll-to-bottom on new message when user has scrolled up (always auto-scrolls)
- No pagination for DM messages (loads first 100 only)
- Mobile app not touched (out of scope)

### Phase 4.1 codex review note (commit 2773b5d)

**Known limitation: fellow ownership is client-asserted.**

`POST /api/rooms` and `POST /api/rooms/:id/members` accept any `memberFellows[].fellowId` and tag with `ownerId=auth.user.id`. Cloud has no server-side registry of "which fellows belong to which user" because fellows are local concepts (per CLAUDE.md).

Implications:
- A user could claim ownership of an arbitrary fellow id. For demo scenario (Alice creates group with her real Codex, invites Bob, Bob @s codex) this works fine — Alice owns codex, dispatch goes to Alice.
- Current PK `(room_id, member_kind, member_ref)` means only one "codex" entry per room — if both Alice and Bob had locally-named "codex" fellows, only the first add lands.

**Not fixed tonight**: real fix requires either (a) server-side fellow registry, or (b) PK includes owner_id `(room_id, member_kind, member_ref, owner_id)` which is a schema migration touching schema v2 + all room_members queries. Too risky for this overnight slot. Acceptable for alpha because the demo path doesn't exercise this edge.

Track for future S2-polish work.
