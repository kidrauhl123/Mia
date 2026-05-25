# Cloud Canonical Conversations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make logged-in conversations use cloud `rooms/messages` as the single user-visible source of truth. Local JSON sessions remain only for logged-out/offline mode and as explicit migration input.

**Architecture:** Stable fellow private chat rooms are first-class cloud rooms with id `fellow:<userId>:<fellowKey>`. Desktop sync publishes user/fellow identity and ensures fellow rooms, but it does not backfill or mirror arbitrary local sessions. Renderer conversation lists come from cloud rooms while signed in. Main process owns local fellow replies for cloud fellow rooms and stores local agent session metadata keyed by room id.

**Tech Stack:** Electron main/renderer, Node test runner, local cloud server in `scripts/serve-cloud.js`, IPC bridge in `src/preload.js`, cloud/social clients under `src/main`.

---

## File Structure

- Modify: `scripts/serve-cloud.js`
  - Owns cloud HTTP routes and persistence. Add the stable fellow room endpoint here and keep the existing session-id endpoint as a legacy compatibility route.
- Modify: `src/main/social/social-api.js`
  - Owns main-process social HTTP methods. Add `ensureFellowRoom(fellowId, body)`.
- Modify: `src/main/social/social-ipc.js`
  - Owns renderer-to-main social IPC handlers. Register the new `SocialEnsureFellowRoom` channel.
- Modify: `src/shared/ipc-channels.js`
  - Owns IPC channel names. Add one stable channel constant.
- Modify: `src/preload.js`
  - Owns safe renderer bridge APIs. Expose `window.mia.social.ensureFellowRoom`.
- Modify: `src/main/cloud/desktop-sync-client.js`
  - Owns desktop-to-cloud identity sync. Stop reading local chat sessions during login sync; ensure stable fellow rooms after fellow identity sync.
- Modify: `src/renderer/social/social.js`
  - Owns cloud social renderer state and events. Ensure local fellows have cloud rooms before listing rooms, and upsert rooms from events.
- Modify: `src/renderer/app.js`
  - Owns shell/sidebar/chat form routing. Use cloud room rows while signed in and show fellow rooms.
- Modify: `src/main/social/local-fellow-responder.js`
  - Owns posting AI fellow replies to rooms. Switch from stateless replies to room-scoped `sendChat` sessions.
- Create: `src/main/social/fellow-room-responder.js`
  - Owns deciding whether a cloud fellow room message should trigger a local fellow reply.
- Modify: `src/main/cloud/cloud-events-client.js`
  - Owns routing cloud events into main-process conductors. Send room-message events to both group and fellow conductors.
- Modify: `src/main.js`
  - Owns main-process wiring. Instantiate and inject the fellow room responder.
- Test: `tests/fellow-rooms.test.js`
  - Covers stable fellow room server behavior.
- Test: `tests/main-social-api.test.js`
  - Covers social API endpoint path and method.
- Test: `tests/main-cloud-desktop-sync-client.test.js`
  - Covers sync no longer reads local sessions.
- Test: `tests/renderer-social.test.js`
  - Covers renderer room ensuring and event upsert.
- Test: `tests/renderer-shell.test.js`
  - Covers logged-in sidebar source and fellow room visibility.
- Test: `tests/local-fellow-responder.test.js`
  - Covers room-scoped local agent session ids.
- Create: `tests/main-fellow-room-responder.test.js`
  - Covers owned fellow room routing and ignore cases.
- Test: `tests/main-cloud-room-ai-routing.test.js`
  - Covers cloud event routing to group and fellow conductors.

---

## Current Evidence

- `docs/adr/2026-05-22-conversation-state-canonical-owner.md` already says cloud is the write authority when logged in.
- `docs/superpowers/plans/2026-05-23-sync-architecture-redesign.md` planned moving fellow private conversations into rooms.
- `src/main/cloud/desktop-sync-client.js` still reads `mia-sessions.json` and pushes session ids as cloud fellow room ids.
- `scripts/serve-cloud.js` only has `PUT /api/me/fellow-rooms/:sessionId`, creating `fellow:<userId>:<sessionId>`.
- `src/renderer/app.js` still merges local persona rows into the logged-in message list and explicitly hides `room.type === "fellow"` rooms.
- `src/renderer/social/social.js` handles `room.updated` by mapping existing rooms only, so a new room event can be dropped.
- `src/main/social/local-fellow-responder.js` uses stateless chat, so local agent context is not keyed to stable room ids.
- `src/main/social/group-conductor.js` ignores non-group rooms, so fellow cloud rooms need a main-process responder path.

---

## Desired Behavior

- Logged in:
  - Sidebar conversation rows are cloud rooms only.
  - Fellow private chats appear as `private-room` rows backed by `room.type === "fellow"`.
  - Sending to a fellow private chat writes to `/api/rooms/:roomId/messages`.
  - The user's message appears immediately from the same optimistic social message path as groups.
  - Main process responds as the local fellow when the room's fellow belongs to the current desktop user.
  - Other devices see the same room id and messages.
- Logged out:
  - Existing local persona/private-chat mode remains usable.
- Sync:
  - Login sync pushes profile and fellow identity.
  - Login sync ensures stable fellow rooms.
  - Login sync does not enumerate local sessions or push historic local messages automatically.

---

## Task 1: Add Stable Fellow Room API

- [ ] Add failing server tests in `tests/fellow-rooms.test.js`.

```js
test("PUT /api/me/fellows/:fellowId/room creates a stable fellow room", async (t) => {
  const app = await startTestServer(t);
  const token = await signInAs(app, "jung");

  const res = await fetch(`${app.baseUrl}/api/me/fellows/alice/room`, {
    method: "PUT",
    headers: authJson(token),
    body: JSON.stringify({ title: "爱丽丝", runtimeKind: "desktop-local" }),
  });

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.room.id, `fellow:${body.user.id}:alice`);
  assert.equal(body.room.type, "fellow");
  assert.equal(body.room.decorations.fellowKey, "alice");

  const rooms = await getJson(`${app.baseUrl}/api/rooms`, token);
  assert.equal(rooms.rooms.some((room) => room.id === body.room.id), true);
});

test("PUT /api/me/fellows/:fellowId/room is idempotent", async (t) => {
  const app = await startTestServer(t);
  const token = await signInAs(app, "jung");

  const first = await putJson(app, token, "/api/me/fellows/alice/room", { title: "爱丽丝" });
  const second = await putJson(app, token, "/api/me/fellows/alice/room", { title: "爱丽丝" });

  assert.equal(first.room.id, second.room.id);
  assert.equal(second.created, false);
});
```

- [ ] Implement `PUT /api/me/fellows/:fellowId/room` in `scripts/serve-cloud.js`.
  - Place the route before the existing generic fellow detail routes.
  - Reuse existing auth, storage, `insertMessage`/room persistence helpers where available.
  - Create or update a `rooms` row:
    - `id = fellow:${user.id}:${fellowId}`
    - `type = "fellow"`
    - `name = body.title || existingFellow.name || fellowId`
    - `decorations = { fellowKey: fellowId, runtimeKind }`
  - Ensure room members:
    - current user as `member_kind: "user"`
    - fellow as `member_kind: "fellow"`, `member_ref: fellowId`, `owner_id: user.id`
  - Broadcast `room.updated` after create/update.

- [ ] Preserve the old `PUT /api/me/fellow-rooms/:sessionId` endpoint for compatibility, but stop using it from desktop sync and renderer login paths.

- [ ] Add failing main social API tests in `tests/main-social-api.test.js`.

```js
test("ensureFellowRoom calls stable fellow room endpoint", async () => {
  const calls = [];
  const api = createSocialApi({
    requestJson: async (path, options) => {
      calls.push({ path, options });
      return { ok: true, data: { ok: true, room: { id: "fellow:u_1:alice" } } };
    },
  });

  const result = await api.ensureFellowRoom("alice", { title: "爱丽丝" });

  assert.equal(result.ok, true);
  assert.equal(calls[0].path, "/api/me/fellows/alice/room");
  assert.equal(calls[0].options.method, "PUT");
});
```

- [ ] Implement `ensureFellowRoom(fellowId, body)` in `src/main/social/social-api.js`.

- [ ] Add IPC bridge support.
  - Add `SocialEnsureFellowRoom` in `src/shared/ipc-channels.js`.
  - Register it in `src/main/social/social-ipc.js`.
  - Expose `window.mia.social.ensureFellowRoom` in `src/preload.js`.
  - Add a test in the existing preload or IPC bridge test file that asserts `ensureFellowRoom("alice", { title: "爱丽丝" })` invokes the `SocialEnsureFellowRoom` channel with the same arguments.

- [ ] Run targeted tests:

```bash
npm test -- tests/fellow-rooms.test.js tests/main-social-api.test.js
```

- [ ] Commit:

```bash
git add scripts/serve-cloud.js src/main/social/social-api.js src/main/social/social-ipc.js src/shared/ipc-channels.js src/preload.js tests/fellow-rooms.test.js tests/main-social-api.test.js
git commit -m "feat: add stable fellow room endpoint"
```

---

## Task 2: Stop Session Backfill During Login Sync

- [ ] Add or update failing tests in `tests/main-cloud-desktop-sync-client.test.js`.

```js
test("syncWorkspace syncs fellow identity and stable rooms without reading local sessions", async () => {
  const calls = [];
  const client = createDesktopSyncClient({
    baseUrl: "https://cloud.test",
    getToken: () => "token",
    loadProfile: () => ({ displayName: "Jung" }),
    loadFellows: () => [{ key: "alice", name: "爱丽丝" }],
    loadChatStore: () => {
      throw new Error("local session store must not be read during login sync");
    },
    fetchImpl: async (url, options = {}) => {
      calls.push({ url: String(url), method: options.method || "GET" });
      if (String(url).endsWith("/api/me")) {
        return jsonResponse({ ok: true, user: { id: "u_1" }, fellows: [] });
      }
      return jsonResponse({ ok: true, room: { id: "fellow:u_1:alice" } });
    },
  });

  await client.syncWorkspace();

  assert.deepEqual(
    calls.map((call) => [call.method, new URL(call.url).pathname]),
    [
      ["PATCH", "/api/me/profile"],
      ["PUT", "/api/me/fellows/alice"],
      ["PUT", "/api/me/fellows/alice/room"],
      ["GET", "/api/me"],
    ],
  );
});
```

- [ ] Refactor `src/main/cloud/desktop-sync-client.js`.
  - Keep `pushUserProfile()` and `pushFellow()` identity sync.
  - Add `ensureFellowRoom(fellow)` using `/api/me/fellows/:fellowKey/room`.
  - Change `pushAllFellows()` so it syncs identity and ensures the room per fellow.
  - Remove `pushAllFellowSessionsToCloudRooms()` from `syncWorkspace()`.
  - Keep `pushDesktopMessage()` only as a logged-out legacy compatibility path, or return a clear skipped status when called while cloud canonical mode is active.

```js
async function pushFellowWithRoom(fellow) {
  await pushFellow(fellow);
  return ensureFellowRoom(fellow);
}

async function syncWorkspace() {
  const profileResult = await pushUserProfile();
  const fellowResults = await pushAllFellows();
  const meResult = await getMe();
  return { ok: true, profile: profileResult, fellows: fellowResults, me: meResult };
}
```

- [ ] Remove or quarantine tests that assert local session backfill on login.

- [ ] Run targeted tests:

```bash
npm test -- tests/main-cloud-desktop-sync-client.test.js
```

- [ ] Commit:

```bash
git add src/main/cloud/desktop-sync-client.js tests/main-cloud-desktop-sync-client.test.js
git commit -m "refactor: stop login session backfill"
```

---

## Task 3: Make Renderer Use Cloud Rooms While Signed In

- [ ] Add failing renderer social tests in `tests/renderer-social.test.js`.

```js
test("bootstrapAfterLogin ensures local fellow rooms before listing rooms", async () => {
  const social = loadSocialModule();
  const calls = [];

  social.initSocialModule({
    getState: () => ({ runtime: { fellows: [{ key: "alice", name: "爱丽丝" }] } }),
    render: () => {},
    els: {},
  });

  social.__setSocialApi({
    myUsername: async () => ({ ok: true, data: { username: "jung" } }),
    listFriends: async () => ({ ok: true, data: { friends: [] } }),
    listRequests: async () => ({ ok: true, data: { incoming: [], outgoing: [] } }),
    settingsGet: async () => ({ ok: true, data: { settings: {} } }),
    ensureFellowRoom: async (fellowId, body) => {
      calls.push({ kind: "ensure", fellowId, body });
      return { ok: true, data: { room: { id: "fellow:u_1:alice", type: "fellow" } } };
    },
    listRooms: async () => {
      calls.push({ kind: "listRooms" });
      return { ok: true, data: { rooms: [{ id: "fellow:u_1:alice", type: "fellow", name: "爱丽丝" }] } };
    },
    listRoomMessages: async () => ({ ok: true, data: { messages: [] } }),
  });

  await social.bootstrapAfterLogin();

  assert.deepEqual(calls.map((call) => call.kind), ["ensure", "listRooms"]);
});

test("room.updated upserts rooms that are not already in moduleState", async () => {
  const social = loadSocialModule();
  social.initSocialModule({ getState: () => ({}), render: () => {}, els: {} });

  social.__emitCloudEvent({
    type: "room.updated",
    room: { id: "fellow:u_1:alice", type: "fellow", name: "爱丽丝" },
  });

  assert.equal(social.getModuleState().rooms.some((room) => room.id === "fellow:u_1:alice"), true);
});
```

- [ ] Implement renderer social changes in `src/renderer/social/social.js`.
  - Add `ensureLocalFellowRooms(api)` before `listRooms()` in `bootstrapAfterLogin()`.
  - Read local fellows from `deps.getState()?.runtime?.fellows` and any existing persona list used by the app.
  - Deduplicate by `fellow.key`.
  - Call `api.ensureFellowRoom(fellow.key, { title: fellow.name, runtimeKind: "desktop-local" })`.
  - Treat ensure failures as non-fatal and surface them through the existing status/error channel.
  - Change `room.updated` event handling to upsert by id.

```js
function upsertRoom(room) {
  if (!room?.id) return;
  const index = moduleState.rooms.findIndex((existing) => existing.id === room.id);
  if (index >= 0) {
    moduleState.rooms = moduleState.rooms.map((existing) => (existing.id === room.id ? { ...existing, ...room } : existing));
  } else {
    moduleState.rooms = [...moduleState.rooms, room];
  }
  ensureRoomCache(room.id);
}
```

- [ ] Add failing renderer shell tests in `tests/renderer-shell.test.js`.

```js
test("logged-in message list uses social rows instead of local fellow rows", () => {
  const source = readFileSync(appJsPath, "utf8");
  assert.match(source, /cloudSignedIn\s*\?\s*\[\]\s*:\s*visiblePersonas\.map/s);
});

test("fellow cloud rooms are not hidden from the sidebar", () => {
  const source = readFileSync(appJsPath, "utf8");
  assert.doesNotMatch(source, /if\s*\(\s*isFellow\s*\)\s*return\s+null/);
});
```

- [ ] Implement renderer app changes in `src/renderer/app.js`.
  - In `renderSidebarRows()`, build local fellow rows only when not signed in.

```js
const localConversationRows = cloudSignedIn
  ? []
  : visiblePersonas.map((persona) => ({ type: "fellow", persona, message: recentMessage }));

const messageRows = !cloudReady
  ? []
  : sortConversationRows([...localConversationRows, ...socialRows]);
```

  - Remove the `room.type === "fellow"` hide branch from `conversationCardSpecFromRow()`.
  - For fellow room cards, derive avatar/name from `room.decorations.fellowKey` and local personas when available.
  - Keep the logged-out local chat path intact.

- [ ] Run targeted tests:

```bash
npm test -- tests/renderer-social.test.js tests/renderer-shell.test.js
```

- [ ] Commit:

```bash
git add src/renderer/social/social.js src/renderer/app.js tests/renderer-social.test.js tests/renderer-shell.test.js
git commit -m "refactor: render fellow chats from cloud rooms"
```

---

## Task 4: Reply From Local Fellows In Cloud Fellow Rooms

- [ ] Add failing tests for room-keyed local fellow responses in `tests/local-fellow-responder.test.js`.

```js
test("local fellow responder uses room scoped chat sessions", async () => {
  const engineCalls = [];
  const responder = createLocalFellowResponder({
    sendChat: async (request) => {
      engineCalls.push(request);
      return { content: "收到" };
    },
    postRoomMessageAsFellow: async () => ({ ok: true }),
  });

  await responder.respond({
    roomId: "fellow:u_1:alice",
    fellowId: "alice",
    systemPrompt: "You are Alice",
    userPrompt: "你好",
  });

  assert.equal(engineCalls[0].fellowKey, "alice");
  assert.equal(engineCalls[0].sessionId, "room:fellow:u_1:alice");
});
```

- [ ] Refactor `src/main/social/local-fellow-responder.js`.
  - Inject `sendChat` instead of `sendChatStateless` for cloud room replies.
  - Call `sendChat({ fellowKey, sessionId: "room:<roomId>", messages })`.
  - Extract text through the same response-content helper used by existing chat flows.
  - Keep dedup and `postRoomMessageAsFellow()` behavior.

- [ ] Add failing tests for a main fellow room conductor in `tests/main-fellow-room-responder.test.js`.

```js
test("handles user messages in owned fellow rooms", async () => {
  const respondCalls = [];
  const conductor = createMainFellowRoomResponder({
    getCurrentUserId: () => "u_1",
    getRoomDetails: async () => ({
      room: { id: "fellow:u_1:alice", type: "fellow", decorations: { fellowKey: "alice" } },
      members: [
        { member_kind: "user", member_ref: "u_1" },
        { member_kind: "fellow", member_ref: "alice", owner_id: "u_1" },
      ],
    }),
    listRecentMessages: async () => [
      { sender_kind: "user", sender_ref: "u_1", body_md: "你好" },
    ],
    responder: {
      respond: async (args) => respondCalls.push(args),
    },
  });

  await conductor.handleRoomMessageAppended({
    roomId: "fellow:u_1:alice",
    message: { id: "m_1", sender_kind: "user", sender_ref: "u_1", body_md: "你好" },
  });

  assert.equal(respondCalls.length, 1);
  assert.equal(respondCalls[0].fellowId, "alice");
  assert.equal(respondCalls[0].dedupKey, "m_1:alice");
});

test("ignores non-user messages and unowned fellow rooms", async () => {
  const respondCalls = [];
  const conductor = createMainFellowRoomResponder({
    getCurrentUserId: () => "u_1",
    getRoomDetails: async () => ({
      room: { id: "fellow:u_2:alice", type: "fellow", decorations: { fellowKey: "alice" } },
      members: [{ member_kind: "fellow", member_ref: "alice", owner_id: "u_2" }],
    }),
    listRecentMessages: async () => [],
    responder: { respond: async (args) => respondCalls.push(args) },
  });

  await conductor.handleRoomMessageAppended({
    roomId: "fellow:u_2:alice",
    message: { id: "m_1", sender_kind: "user", sender_ref: "u_1", body_md: "你好" },
  });

  assert.equal(respondCalls.length, 0);
});
```

- [ ] Implement `src/main/social/fellow-room-responder.js`.
  - Export `createMainFellowRoomResponder(deps)`.
  - Filter to `room.type === "fellow"`.
  - Ignore messages where `sender_kind !== "user"`.
  - Resolve `fellowId` from `room.decorations.fellowKey`, owned fellow member, or stable room id suffix.
  - Require fellow ownership by `owner_id === currentUserId`.
  - Build a concise prompt from recent room messages.
  - Call `deps.responder.respond({ roomId, fellowId, systemPrompt, userPrompt, dedupKey })`.

- [ ] Wire the conductor in `src/main.js` and `src/main/cloud/cloud-events-client.js`.
  - Instantiate `localFellowResponder` with `sendChat`.
  - Instantiate `mainFellowRoomResponder` with cloud social API accessors and the local responder.
  - Pass it into `createCloudEventsClient`.
  - On `RoomMessageAppended`, invoke group conductor and fellow room responder; each conductor filters its own room type.

- [ ] Update `tests/main-cloud-room-ai-routing.test.js` so it asserts:
  - group rooms continue through the group conductor.
  - fellow rooms are routed to the fellow room responder.
  - renderer does not own local fellow replies.

- [ ] Run targeted tests:

```bash
npm test -- tests/local-fellow-responder.test.js tests/main-fellow-room-responder.test.js tests/main-cloud-room-ai-routing.test.js
```

- [ ] Commit:

```bash
git add src/main/social/local-fellow-responder.js src/main/social/fellow-room-responder.js src/main.js src/main/cloud/cloud-events-client.js tests/local-fellow-responder.test.js tests/main-fellow-room-responder.test.js tests/main-cloud-room-ai-routing.test.js
git commit -m "feat: route cloud fellow rooms to local responders"
```

---

## Task 5: Remove Logged-In Local Mirror Calls From Send Path

- [ ] Add failing tests around renderer send behavior.
  - In a cloud room, `sendInActiveRoom()` calls `social.sendRoomMessage()` only.
  - The app does not call `pushCloudMessageQuietly()` after successful cloud-room send.
  - Local private send continues to work when no cloud session exists.

- [ ] Refactor `src/renderer/app.js`.
  - Keep `pushCloudMessageQuietly()` only for explicit legacy/local-mode use.
  - Ensure the signed-in fellow room path always has `activeRoomId`.
  - Remove any logged-in fallback that sends to a local `persona.key` session and then mirrors.

- [ ] Refactor `CloudPushMessage` into an explicit legacy path.
  - Keep the channel only if `rg "CloudPushMessage|cloudPushMessage|pushCloudMessageQuietly" src tests` shows a logged-out/local compatibility caller.
  - Add this comment above the handler when it remains:

```js
// Legacy local-mode mirror path. Logged-in conversations use cloud rooms/messages directly.
```

  - Remove the channel, handler, preload method, and tests when the search shows no runtime caller after the renderer send-path refactor.

- [ ] Run targeted tests:

```bash
npm test -- tests/renderer-social.test.js tests/renderer-shell.test.js tests/main-cloud-desktop-sync-client.test.js
```

- [ ] Commit:

```bash
git add src/renderer/app.js tests/renderer-social.test.js tests/renderer-shell.test.js src/shared/ipc-channels.js src/preload.js src/main/cloud-ipc.js
git commit -m "refactor: remove logged-in local message mirroring"
```

---

## Task 6: End-to-End Verification

- [ ] Run focused test set:

```bash
npm test -- \
  tests/fellow-rooms.test.js \
  tests/main-social-api.test.js \
  tests/main-cloud-desktop-sync-client.test.js \
  tests/renderer-social.test.js \
  tests/renderer-shell.test.js \
  tests/local-fellow-responder.test.js \
  tests/main-fellow-room-responder.test.js \
  tests/main-cloud-room-ai-routing.test.js
```

- [ ] Run full test suite:

```bash
npm test
```

- [ ] Run static checks available in the repo:

```bash
npm run lint
```

If the repo has no lint script, record that explicitly in the final report.

- [ ] Run the app in a clean test profile.

```bash
npm run start
```

Manual checks:

- [ ] Sign in.
- [ ] Confirm fellow conversations appear once in the sidebar.
- [ ] Send a private message to a fellow.
- [ ] Confirm the message appears immediately.
- [ ] Confirm the local fellow replies in the same private cloud room.
- [ ] Send a group message mentioning a fellow.
- [ ] Confirm replies stay in the group room and do not leak to private chat.
- [ ] Restart the app and confirm the same rooms/messages load from cloud.
- [ ] Sign out or clear token and confirm logged-out local private mode still opens.

- [ ] Inspect local data.

```bash
rg "fellow-rooms|pushAllFellowSessionsToCloudRooms|pushDesktopMessage" src tests scripts
rg "isFellow\\s*\\)\\s*return null|type:\\s*\"fellow\"" src/renderer tests
```

Expected results:

- No active logged-in code calls `/api/me/fellow-rooms/:sessionId`.
- No renderer branch hides `room.type === "fellow"`.
- Local JSON session writes are limited to logged-out/local compatibility paths.

- [ ] Run diff hygiene:

```bash
git diff --check
git status --short
```

- [ ] Final commit if Task 6 required small fixes:

```bash
git add <verified-files>
git commit -m "test: verify cloud canonical conversations"
```

---

## Rollback Plan

- The old `PUT /api/me/fellow-rooms/:sessionId` endpoint remains during this change, so server rollback does not require data deletion.
- Renderer rollback can restore local fellow cards for logged-in users by reverting Task 3.
- Main responder rollback can disable `mainFellowRoomResponder` wiring while keeping stable rooms visible.
- No automatic local history migration is performed, so rollback does not duplicate historic messages.

---

## Definition of Done

- Logged-in private fellow chats and group chats both use cloud rooms/messages.
- No logged-in sidebar duplicates local fellow rows and cloud fellow rows.
- Fellow private room messages receive local agent replies in the same room.
- Group room replies do not leak into private fellow chats.
- Login sync no longer reads or pushes local chat sessions.
- Targeted tests and full test suite pass, or every failing test is explained with a concrete unrelated cause.
