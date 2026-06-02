# Member Avatar Identity 设计

状态：设计已确认，待写实施计划
日期：2026-06-01

## 1. 背景

Mia 现在已经有几个共享 Module 试图统一头像：

- `packages/shared/avatar.js` 负责头像 fallback、裁剪、媒体类型、视频 trim 和成员颜色；`src/shared/avatar-resolve.js`、`src/shared/avatar-media.js`、`src/shared/member-color.js` 只保留 Node 兼容入口。
- `packages/shared/contact.js` 把 self / fellow / user 解析成 contact；`src/shared/contact.js` 只保留 Node 兼容入口。
- `packages/shared/group-tiles.js` 把群成员解析成头像 tile；`src/shared/group-tiles.js` 只保留 Node 兼容入口。

但实际 UI 仍然在多处绕开这些 Module：

- Web 使用 `/api/me?compact=1` 与 `/api/me/fellows?compact=1` 启动，compact payload 去掉了 `avatarImage/avatarCrop/avatarColor`，但 web 头像渲染仍直接读这些字段。
- 桌面端部分路径读本地 fellow manifest，web 端读 cloud compact fellow，导致同一个 fellow 在不同端显示不同头像。
- DM 真人和 fellow 的 fallback 不一致：一些路径用字母，一些路径用 identity hash preset。
- Cloud conversation member detail 只 enrich fellow avatar，不以同构方式 enrich user avatar。
- Mobile 只用会话标题首字母，虽然页面加载了 `avatar-resolve.js`，但没有接入统一头像体系。

用户要求根本解决：任何成员，不管是真人还是 fellow，不管在 web、desktop 还是 mobile，头像逻辑必须一致。新用户或新 fellow 没有头像时，不再随机或 hash 到预设图片，而是统一使用稳定颜色和名字前两个字。

补充要求：现有内置预设头像系统也要移除。这包括用户可选入口、无头像 fallback、以及运行时对当前内置预设资源路径的依赖。历史数据里已经保存的当前预设头像路径要被识别为 legacy preset，并降级为“无真实头像”，统一渲染为颜色 + 名字前两个字，而不是破图或继续显示旧预设图。用户自行上传、远程 URL、data URL 等真实头像仍然保留。

## 2. 目标

1. 建立唯一的成员身份解析 contract：`MemberIdentity`。
2. 所有头像 fallback 都由 shared Module 决定，UI 层不再判断“没头像怎么办”。
3. 新用户、新 fellow、未知成员的默认头像统一为“稳定颜色 + 名字前两个字”。
4. 颜色只由 `packages/shared/avatar.js` 的一个算法产生。
5. 移除当前内置预设头像作为用户可选项、无头像 fallback 和运行时渲染依赖，并在代码引用清空后删除对应 catalog / asset 文件。
6. 历史保存的当前内置预设头像路径统一 normalize 为空头像，走颜色 + 两字 fallback。
7. Web、desktop、mobile 的会话列表、聊天 header、消息气泡、群头像 mosaic、联系人卡都消费同一种 avatar descriptor。
8. Cloud conversation detail 对 user member 和 fellow member 返回同构 identity。
9. 保留 compact bootstrap 的性能收益，但 compact payload 不再被当成头像权威。
10. 通过回归测试防止新渲染路径重新分叉。

## 3. 非目标

- 本期不迁移真实头像媒体存储方式。`avatar.image` 仍可以是 data URL、非预设相对资源路径、远程 URL 或空字符串。
- 本期不保留当前内置预设头像。旧数据里指向当前内置预设资源的 `avatarImage` 不再视为合法真实头像。
- 本期不重写整个 web 或 renderer 大文件，只在头像身份解析相关路径做收敛。
- 本期不改变 conversation canonical owner ADR：登录 Mia Cloud 后，cloud 仍是 conversation state 的写权威。
- 本期不改变 fellow runtime / model / permission 设置，只统一 fellow 身份展示。

## 4. 核心 Contract

新增 shared Module：

```text
src/shared/member-identity.js
```

### 4.1 MemberIdentity

```js
{
  kind: "user" | "fellow",
  id: "user_or_fellow_id",
  ownerId: "owner_user_id_or_empty",
  globalId: "fellow:<ownerId>:<fellowId> for fellows, empty for users",
  displayName: "空铃",
  avatar: {
    image: "",
    crop: null,
    color: "#65aadd",
    text: "空铃"
  }
}
```

规则：

- `avatar.image` 只有在真实头像存在时才有值。
- `avatar.image` 如果来自当前内置预设头像资源路径，必须 normalize 为 `""`。
- 没有真实头像时，`avatar.image === ""`。
- `avatar.color` 始终来自 `memberAccentColor(identityKey)`。
- `avatar.text` 始终来自 `displayName` 的前两个可见字符。
- UI 渲染头像时只消费 `avatar`，不能自己重新算颜色、首字或 fallback 图片。

### 4.2 解析入口

```js
resolveMemberIdentity(query, ctx)
```

`query`：

```js
{
  kind: "user" | "fellow" | "self",
  ref: "member_ref",
  ownerId: "",
  conversationId: ""
}
```

`ctx`：

```js
{
  self,
  friends,
  fellows,
  members
}
```

解析优先级：

- self user：`ctx.self`。
- friend / user：`member.identity` → `ctx.friends` → `ctx.self` → minimal fallback。
- owned fellow：`ctx.fellows` → `member.identity` → minimal fallback。
- cross-owner fellow：`member.identity` → minimal fallback；不能因为 fellow key 撞名就使用当前用户本地 fellow。

### 4.3 Fallback

新增 helpers：

```js
identityDisplayText(displayName, fallback)
identityColor(identity)
normalizeAvatarImage(image)
avatarForIdentity(identitySource)
```

Fallback 必须统一：

- `displayName` 为空时，user 使用 `member_ref || "用户"`，fellow 使用 `member_ref || "Fellow"`。
- `avatar.text = Array.from(displayName.trim()).slice(0, 2).join("") || "?"`。
- `avatar.color = memberAccentColor(identityKey)`。
- `identityKey` 对 user 为 user id；对 fellow 优先使用 `globalId`，没有 owner 时退回 fellow id，避免不同用户拥有同 key fellow 时颜色冲突。
- fellow `identity.globalId` 使用 `packages/shared/fellow-identity.fellowGlobalId(ownerId, id)` 生成；本地 `id/key` 仍可重复，但跨用户分享、成员身份和事件 payload 必须带 `globalId`。
- `normalizeAvatarImage(image)` 对当前内置预设头像路径返回 `""`，包括 web/desktop/mobile 曾使用过的 `assets/avatars`、`assets/avatars-pet`、`avatar-thumbs`、以及同类 legacy preset 路径；匹配时要处理 `./`、`/`、绝对 app resource URL 等路径形态。
- 任何 UI 层不得再用 `title[0]`、`initials(...)`、本地 `avatarColor(...)` 或 hash preset 作为无头像 fallback。

## 5. Cloud 数据流

### 5.1 Conversation detail

`GET /api/conversations/:id` 返回 members 时，每个 member 都带同构 `identity`：

```js
{
  member_kind: "user",
  member_ref: "u_1",
  owner_id: null,
  identity: {
    kind: "user",
    id: "u_1",
    ownerId: "",
    globalId: "",
    displayName: "老板",
    avatar: {
      image: "data:image/png;base64,...",
      crop: { "x": 50, "y": 50, "zoom": 1 },
      color: "#65aadd",
      text: "老板"
    }
  }
}
```

```js
{
  member_kind: "fellow",
  member_ref: "kongling",
  owner_id: "u_1",
  identity: {
    kind: "fellow",
    id: "kongling",
    ownerId: "u_1",
    globalId: "fellow:u_1:kongling",
    displayName: "空铃",
    avatar: {
      image: "",
      crop: null,
      color: "#b08fd8",
      text: "空铃"
    }
  }
}
```

Compatibility fields such as `fellow_name`, `fellow_avatar_image`, `fellow_avatar_crop`, and `user` may stay temporarily, but new renderer code must use `member.identity`.

### 5.2 Lightweight endpoints

Existing lightweight endpoints remain:

- `POST /api/auth/login`
- `POST /api/auth/register`
- `GET /api/me?compact=1`
- `GET /api/me/fellows?compact=1`
- `GET /api/conversations`

These endpoints may omit avatar media. They are not identity authority for avatar rendering.

Avatar rendering surfaces must use one of:

- `GET /api/conversations/:id` member identity.
- Existing non-compact profile/fellow detail response when editing or managing an entity.
- A new narrow identity response only if a surface needs self or fellow identity outside a conversation.

The web shell can render immediately with fallback avatar, then upgrade once identity detail arrives. It must not block login or conversation list paint on large avatar media.

## 6. Web 端设计

### 6.1 State

Web keeps compact bootstrap for fast initial render:

- `state.user` may be compact.
- `state.fellows` may be compact.
- `state.conversationMembersCache` becomes the primary avatar identity cache for conversation surfaces.

When a conversation is active or appears as a group/fellow row needing concrete member avatars, web calls `ensureConversationMembers(conversationId)` and uses `member.identity`.

### 6.2 Surfaces

Web surfaces that must use `MemberIdentity.avatar`:

- Rail self avatar.
- Conversation list rows.
- Active chat header.
- Message sender avatar.
- Streaming fellow avatar.
- Group mosaic tiles.
- Contact card.
- Create group member picker.

Web `applyAvatarMedia` should accept the unified avatar descriptor:

```js
paintAvatar(el, identity.avatar)
```

The function handles:

- image/video/gif media when `avatar.image` exists.
- solid background + `avatar.text` when `avatar.image` is empty.

## 7. Desktop 端设计

Desktop already has `window.miaAvatar.paintAvatar`, but many callers still assemble avatar input manually.

Desktop renderer must use `resolveMemberIdentity` for:

- Sidebar private/group cards.
- Active cloud conversation header.
- Local fellow session message bubbles.
- Cloud conversation message bubbles.
- Group info dialog member rows.
- Contact cards.
- Fellow manager display rows.
- Group creation member picker.

`applyFellowAvatar` and `applyUserAvatar` may remain only as compatibility wrappers during transition, but they must consume `MemberIdentity.avatar`. Raw `avatarAssetForKey` must be removed from rendering paths; if a temporary compatibility helper remains, it may only detect legacy preset paths and normalize them to empty avatar.

```js
const identity = resolveMemberIdentity(query, ctx);
window.miaAvatar.paintAvatar(el, identity.avatar);
```

## 8. Mobile 端设计

Mobile is in scope through `apps/mobile-rn`; the old `src/mobile` WebView app has been retired.

`apps/mobile-rn/src/logic/conversationList.ts` must return avatar descriptors/tiles, not just title/subtitle:

```js
{
  id,
  title,
  subtitle,
  unread,
  tiles,
  raw
}
```

RN mobile must use shared identity/avatar helpers for:

- Conversation list avatar.
- Contacts list avatar.
- Chat title/header avatar when present.
- Future message sender avatar rendering.

The RN layout can stay platform-native, but the identity data contract must match web and desktop.

## 9. Rendering Rules

All platforms must follow the same rendering rules:

1. If `avatar.image` is non-empty, render the media using the existing platform URL adapter.
2. If `avatar.image` is empty, render a circle with `avatar.color` and centered `avatar.text`.
3. Do not infer fallback text from the conversation title at the render site.
4. Do not infer fallback color at the render site.
5. Do not fallback to `avatarAssetForKey`.
6. Do not render current bundled preset avatar assets even if old persisted data points at them.
7. Do not treat user and fellow differently in renderer fallback logic.

## 10. Testing Strategy

### Shared tests

- `resolveMemberIdentity` returns the same fallback shape for user and fellow without avatars.
- `resolveMemberIdentity` uses `member.identity` for cross-owner fellows instead of local fellow key collision.
- `resolveMemberIdentity` uses `member.identity` for user members when friends list is missing.
- `avatar.text` uses the first two visible characters, not a one-character fallback.
- `memberAccentColor` is the only color source.
- Current bundled preset avatar paths normalize to `avatar.image === ""` and use text fallback.

### Cloud tests

- `GET /api/conversations/:id` returns `member.identity` for user members.
- `GET /api/conversations/:id` returns `member.identity` for fellow members.
- `GET /api/conversations/:id` does not return current bundled preset paths as `identity.avatar.image`.
- Compact auth and bootstrap responses remain small and do not carry avatar media.

### Web tests

- Web conversation list uses member identity for DM and fellow rows.
- Web active header uses member identity.
- Web compact fellow does not block member-row identity from supplying the real avatar.
- Web fallback for new user and new fellow is color + two-character text.
- Web no longer exposes current bundled preset avatar picker options.

### Desktop tests

- Sidebar card specs contain avatar descriptors from `resolveMemberIdentity`.
- Cloud conversation message source uses `MemberIdentity`.
- Group info and contact cards use `MemberIdentity`.
- Direct `avatarAssetForKey` fallback does not reappear in rendering paths.
- Old persisted current preset paths render as color + two-character text, not broken images.

### Mobile tests

- `buildConversationListItems` outputs `avatar`.
- Mobile contacts list consumes avatar descriptors for both friends and fellows.
- Mobile fallback matches shared user/fellow fallback.
- Mobile does not carry a separate preset fallback or first-letter fallback.

## 11. Acceptance Criteria

1. Same account, same fellow, same friend, and same group render with the same avatar on web, desktop, and mobile.
2. A new user with no uploaded avatar renders as stable color + first two display-name characters everywhere.
3. A new fellow with no uploaded avatar renders as stable color + first two display-name characters everywhere.
4. No renderer path falls back to identity-hashed preset images for missing avatars.
5. Current bundled preset avatar options, catalogs, and asset files are removed after product code no longer references them.
6. Old persisted current preset avatar references render as stable color + first two display-name characters everywhere.
7. Compact bootstrap remains fast and does not carry large avatar media.
8. Conversation detail is the canonical source for per-member identity in conversation surfaces.
9. Relevant targeted tests and `npm run check` pass.
