# Chat Consistency: Unify All Conversation Pipelines Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse the four parallel conversation pipelines (fellow private, local group, cloud DM, cloud group) into a single pipeline so right-click menus, timestamps, avatars, and AI orchestration behave identically regardless of where a conversation lives.

**Architecture:** Introduce three shared contracts in `src/shared/`: a `Contact` model resolving any participant kind to a uniform display payload, a `RenderableMessageSpec` defining what a message looks like and what actions it permits, and source-specific `MessageSourceAdapter` modules that translate each pipeline's raw schema into the spec. A single `createMessageBubble(spec)` renderer consumes specs; `getActiveConversation()` collapses the three-way active-state checks scattered across `renderChat` / topbar / composer; the conductor lifts out of `group.js` and attaches to the cloud-room adapter with four guards (own-fellow-only, sender-is-user, turn_id dedup, no fellow→fellow relay).

**Tech Stack:** Vanilla JS IIFE modules in `src/renderer/`, pure Node modules in `src/shared/`, Node test runner (`node --test`) using the existing vm-sandbox pattern from `tests/renderer-social.test.js`.

---

## File Structure

**New files (shared, used by both Electron renderer and node tests):**

- `src/shared/time-format.js` — `formatConversationTime(value)`, `formatMessageTime(value)`. Replaces 3 duplicate formatters.
- `src/shared/contact.js` — `Contact` shape + `resolveContact({kind, ref, context})` lookup. Replaces 4 ad-hoc lookups (fellow by key, friend by id, room member, self).
- `src/shared/message-spec.js` — `RenderableMessageSpec` field list + `MessageCapability` enum + `defaultCapabilities()`.
- `src/shared/cloud-events.js` — `CloudEvent` constants for the 42 WS event-type literals.

**New files (renderer):**

- `src/renderer/contact-avatar.js` — `renderAvatar(contact, options?)` → DOM element. The ONE entry point for any avatar render.
- `src/renderer/message-sources/fellow-session-source.js` — `createFellowSource(persona, sessionId, deps)` adapter.
- `src/renderer/message-sources/local-group-source.js` — `createLocalGroupSource(group, deps)` adapter.
- `src/renderer/message-sources/cloud-room-source.js` — `createCloudRoomSource(room, deps)` adapter.
- `src/renderer/message-bubble-renderer.js` — `createMessageBubble(spec)` → DOM. Replaces `_buildMessageArticle`, `_buildGroupMessageArticle`, fellow chat inline render, local group chat inline render.
- `src/renderer/active-conversation.js` — `getActiveConversation()` returning `{kind, id, title, messageSource, composerActions}`. Collapses 3-way state checks.
- `src/renderer/conductor/index.js` — relocated from `src/renderer/group/group.js` (the `decideDispatch` logic).
- `src/renderer/conductor/cloud-room-conductor.js` — hooks `cloud-room-source.onIncomingMessage` into the conductor with the 4 guards.

**Files modified:**

- `src/renderer/app.js` (~lines 1700-1830 `renderChat`, ~3550-3620 chatForm submit) — delegates to active-conversation + bubble renderer.
- `src/renderer/group/group.js` (~lines 502-625 `renderActiveGroup`, ~629-720 `sendInActiveGroup`) — uses local-group-source + bubble renderer.
- `src/renderer/social/social.js` (~lines 270-390 `renderRoomChat`, `_buildMessageArticle`) — uses cloud-room-source + bubble renderer.
- `src/renderer/social/social-groups.js` (`buildGroupMessageArticle`) — deleted, cloud group goes through bubble renderer.
- `src/renderer/index.html` — add `<script>` tags for new shared + renderer modules.

**New ADR:**

- `docs/adr/2026-05-22-conversation-state-canonical-owner.md` — declares cloud as the write-authority once logged in, with desktop chatStore as offline cache mirror.

---

## Stage 1 — Foundations (pure shared modules)

Goal: ship the four shared modules with full unit tests. No renderer changes yet. After this stage, the existing app continues to work; new modules are unused but verified.

### Task 1.1: time-format shared module

**Files:**
- Create: `src/shared/time-format.js`
- Test: `tests/shared-time-format.test.js`

- [ ] **Step 1: Write the failing test**

```js
// tests/shared-time-format.test.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { formatConversationTime, formatMessageTime } = require("../src/shared/time-format");

test("formatConversationTime today returns HH:MM", () => {
  const now = new Date();
  now.setHours(14, 5, 0, 0);
  assert.equal(formatConversationTime(now.toISOString()), "14:05");
});

test("formatConversationTime yesterday returns 昨天", () => {
  const y = new Date();
  y.setDate(y.getDate() - 1);
  assert.equal(formatConversationTime(y.toISOString()), "昨天");
});

test("formatConversationTime older returns M/D", () => {
  assert.equal(formatConversationTime("2026-04-12T03:00:00.000Z").endsWith("/12"), true);
});

test("formatConversationTime empty returns empty string", () => {
  assert.equal(formatConversationTime(""), "");
  assert.equal(formatConversationTime(null), "");
});

test("formatMessageTime returns HH:MM", () => {
  const d = new Date();
  d.setHours(9, 7, 0, 0);
  assert.equal(formatMessageTime(d.toISOString()), "09:07");
});
```

- [ ] **Step 2: Run test to verify it fails**

```
node --test tests/shared-time-format.test.js
```
Expected: FAIL with `Cannot find module '../src/shared/time-format'`.

- [ ] **Step 3: Write minimal implementation**

```js
// src/shared/time-format.js
function formatConversationTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return "昨天";
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

function formatMessageTime(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

module.exports = { formatConversationTime, formatMessageTime };
```

- [ ] **Step 4: Run test to verify it passes**

```
node --test tests/shared-time-format.test.js
```
Expected: PASS — 5 tests pass.

- [ ] **Step 5: Commit**

```
git add src/shared/time-format.js tests/shared-time-format.test.js
git commit -m "feat(shared): time-format module unifying conversation + message time formatters"
```

### Task 1.2: Contact shared module

**Files:**
- Create: `src/shared/contact.js`
- Test: `tests/shared-contact.test.js`

- [ ] **Step 1: Write the failing test**

```js
// tests/shared-contact.test.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { resolveContact, ContactKind } = require("../src/shared/contact");

const ctx = {
  self: { id: "user_me", username: "me", avatarImage: "data:me", avatarCrop: {x:50,y:50,zoom:1}, avatarColor: "#111" },
  fellows: [{ key: "codex", id: "codex", name: "Codex", avatarImage: "./assets/avatars/02.png", avatarCrop: { x: 57, y: 8, zoom: 1.5 }, color: "#5e5ce6" }],
  friends: [{ id: "user_friend", username: "alice", avatarImage: "data:alice", avatarCrop: { x: 50, y: 50, zoom: 1 }, avatarColor: "#34c759" }]
};

test("resolveContact self", () => {
  const c = resolveContact({ kind: "self" }, ctx);
  assert.equal(c.kind, ContactKind.Self);
  assert.equal(c.displayName, "me");
  assert.equal(c.avatar.image, "data:me");
});

test("resolveContact fellow by key", () => {
  const c = resolveContact({ kind: "fellow", ref: "codex" }, ctx);
  assert.equal(c.kind, ContactKind.Fellow);
  assert.equal(c.displayName, "Codex");
  assert.equal(c.avatar.image, "./assets/avatars/02.png");
  assert.equal(c.avatar.crop.zoom, 1.5);
});

test("resolveContact friend by id", () => {
  const c = resolveContact({ kind: "user", ref: "user_friend" }, ctx);
  assert.equal(c.kind, ContactKind.User);
  assert.equal(c.displayName, "alice");
  assert.equal(c.avatar.image, "data:alice");
});

test("resolveContact unknown returns placeholder", () => {
  const c = resolveContact({ kind: "user", ref: "user_ghost" }, ctx);
  assert.equal(c.displayName, "user_ghost");
  assert.equal(c.avatar.image, "");
});
```

- [ ] **Step 2: Run test to verify it fails**

```
node --test tests/shared-contact.test.js
```
Expected: FAIL with `Cannot find module '../src/shared/contact'`.

- [ ] **Step 3: Write minimal implementation**

```js
// src/shared/contact.js
const ContactKind = Object.freeze({
  Self: "self",
  Fellow: "fellow",
  User: "user"
});

function emptyAvatar(color) {
  return { image: "", crop: null, color: color || "#5e5ce6" };
}

function avatarFromFellow(f) {
  return {
    image: f.avatarImage || "",
    crop: f.avatarCrop || null,
    color: f.color || "#5e5ce6"
  };
}

function avatarFromUser(u) {
  return {
    image: u.avatarImage || "",
    crop: u.avatarCrop || null,
    color: u.avatarColor || "#5e5ce6"
  };
}

function resolveContact(query, ctx = {}) {
  const { kind, ref } = query || {};
  if (kind === ContactKind.Self) {
    const u = ctx.self || {};
    return {
      kind: ContactKind.Self,
      id: u.id || "",
      displayName: u.username || u.account || "",
      avatar: avatarFromUser(u)
    };
  }
  if (kind === ContactKind.Fellow) {
    const fellows = Array.isArray(ctx.fellows) ? ctx.fellows : [];
    const f = fellows.find((x) => x.key === ref || x.id === ref);
    if (f) return { kind: ContactKind.Fellow, id: f.key || f.id, displayName: f.name || f.key, avatar: avatarFromFellow(f) };
    return { kind: ContactKind.Fellow, id: String(ref || ""), displayName: String(ref || ""), avatar: emptyAvatar() };
  }
  if (kind === ContactKind.User) {
    const friends = Array.isArray(ctx.friends) ? ctx.friends : [];
    if (ctx.self && (ctx.self.id === ref)) return resolveContact({ kind: ContactKind.Self }, ctx);
    const f = friends.find((x) => x.id === ref);
    if (f) return { kind: ContactKind.User, id: f.id, displayName: f.username || f.account || f.id, avatar: avatarFromUser(f) };
    return { kind: ContactKind.User, id: String(ref || ""), displayName: String(ref || ""), avatar: emptyAvatar() };
  }
  return { kind: "", id: "", displayName: "", avatar: emptyAvatar() };
}

module.exports = { resolveContact, ContactKind };
```

- [ ] **Step 4: Run test to verify it passes**

```
node --test tests/shared-contact.test.js
```
Expected: PASS — 4 tests pass.

- [ ] **Step 5: Commit**

```
git add src/shared/contact.js tests/shared-contact.test.js
git commit -m "feat(shared): Contact model + resolveContact for fellow/friend/self"
```

### Task 1.3: RenderableMessageSpec contract

**Files:**
- Create: `src/shared/message-spec.js`
- Test: `tests/shared-message-spec.test.js`

- [ ] **Step 1: Write the failing test**

```js
// tests/shared-message-spec.test.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { MessageCapability, defaultCapabilities, normalizeSpec } = require("../src/shared/message-spec");

test("MessageCapability has reply / copy / pin / delete", () => {
  assert.equal(MessageCapability.Reply, "reply");
  assert.equal(MessageCapability.Copy, "copy");
  assert.equal(MessageCapability.Pin, "pin");
  assert.equal(MessageCapability.Delete, "delete");
});

test("defaultCapabilities returns object with all flags false", () => {
  const cap = defaultCapabilities();
  assert.equal(cap.reply, false);
  assert.equal(cap.copy, false);
  assert.equal(cap.pin, false);
  assert.equal(cap.delete, false);
});

test("normalizeSpec fills missing fields with safe defaults", () => {
  const s = normalizeSpec({ source: "fellow-session", conversationId: "c1", messageId: "m1", role: "user" });
  assert.equal(s.role, "user");
  assert.equal(s.bodyMd, "");
  assert.equal(s.attachments.length, 0);
  assert.equal(s.capabilities.copy, false);
  assert.equal(s.authorName, "");
});

test("normalizeSpec preserves provided fields", () => {
  const s = normalizeSpec({
    source: "cloud-room", conversationId: "dm:a:b", messageId: "msg_1",
    role: "user", authorName: "alice", bodyMd: "hi",
    capabilities: { reply: true, copy: true }
  });
  assert.equal(s.authorName, "alice");
  assert.equal(s.bodyMd, "hi");
  assert.equal(s.capabilities.reply, true);
  assert.equal(s.capabilities.delete, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

```
node --test tests/shared-message-spec.test.js
```
Expected: FAIL with `Cannot find module '../src/shared/message-spec'`.

- [ ] **Step 3: Write minimal implementation**

```js
// src/shared/message-spec.js
const MessageCapability = Object.freeze({
  Reply: "reply",
  Copy: "copy",
  Pin: "pin",
  Delete: "delete"
});

function defaultCapabilities() {
  return { reply: false, copy: false, pin: false, delete: false };
}

// RenderableMessageSpec shape:
// {
//   source: "fellow-session" | "local-group" | "cloud-room",
//   conversationId, messageId, messageIndex,
//   role: "user" | "assistant" | "system",
//   authorName, avatar: { image, crop, color },
//   bodyMd, createdAt, attachments, mentions,
//   isOwn, isPending,
//   capabilities: { reply, copy, pin, delete }
// }
function normalizeSpec(input = {}) {
  return {
    source: input.source || "",
    conversationId: input.conversationId || "",
    messageId: input.messageId || "",
    messageIndex: typeof input.messageIndex === "number" ? input.messageIndex : 0,
    role: ["user", "assistant", "system"].includes(input.role) ? input.role : "assistant",
    authorName: input.authorName || "",
    avatar: input.avatar && typeof input.avatar === "object"
      ? { image: input.avatar.image || "", crop: input.avatar.crop || null, color: input.avatar.color || "" }
      : { image: "", crop: null, color: "" },
    bodyMd: typeof input.bodyMd === "string" ? input.bodyMd : "",
    createdAt: input.createdAt || "",
    attachments: Array.isArray(input.attachments) ? input.attachments : [],
    mentions: Array.isArray(input.mentions) ? input.mentions : [],
    isOwn: Boolean(input.isOwn),
    isPending: Boolean(input.isPending),
    capabilities: Object.assign(defaultCapabilities(), input.capabilities || {})
  };
}

module.exports = { MessageCapability, defaultCapabilities, normalizeSpec };
```

- [ ] **Step 4: Run test to verify it passes**

```
node --test tests/shared-message-spec.test.js
```
Expected: PASS — 4 tests pass.

- [ ] **Step 5: Commit**

```
git add src/shared/message-spec.js tests/shared-message-spec.test.js
git commit -m "feat(shared): RenderableMessageSpec contract + capabilities enum"
```

### Task 1.4: renderAvatar helper

**Files:**
- Create: `src/renderer/contact-avatar.js`
- Test: `tests/renderer-contact-avatar.test.js`
- Modify: `src/renderer/index.html` (add `<script src="./contact-avatar.js">`)

- [ ] **Step 1: Write the failing test**

```js
// tests/renderer-contact-avatar.test.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadHelper() {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "contact-avatar.js"), "utf8");
  const mockEl = () => {
    const el = {
      tagName: "SPAN",
      className: "",
      attrs: {},
      style: { cssText: "" },
      _text: "",
      setAttribute(k, v) { this.attrs[k] = v; },
      get textContent() { return this._text; },
      set textContent(v) { this._text = v; }
    };
    return el;
  };
  const window = { aimashiAvatar: { avatarThumbBackgroundStyle: (img, crop, color) => `background-image:url(${img});background-color:${color};` } };
  const ctx = vm.createContext({ window, globalThis: window, document: { createElement: () => mockEl() }, console });
  vm.runInContext(src, ctx);
  return window.aimashiContactAvatar;
}

test("renderAvatar with image returns styled element", () => {
  const helper = loadHelper();
  const el = helper.renderAvatar({ kind: "fellow", id: "x", displayName: "Codex", avatar: { image: "data:x", crop: null, color: "#5e5ce6" } });
  assert.match(el.style.cssText, /background-image:url\(data:x\)/);
});

test("renderAvatar without image falls back to letter + color", () => {
  const helper = loadHelper();
  const el = helper.renderAvatar({ kind: "user", id: "u", displayName: "Alice", avatar: { image: "", crop: null, color: "#34c759" } });
  assert.equal(el.textContent, "A");
  assert.match(el.style.cssText, /background-color:#34c759/);
});

test("renderAvatar empty contact uses ? letter", () => {
  const helper = loadHelper();
  const el = helper.renderAvatar({ kind: "", id: "", displayName: "", avatar: { image: "", color: "" } });
  assert.equal(el.textContent, "?");
});
```

- [ ] **Step 2: Run test to verify it fails**

```
node --test tests/renderer-contact-avatar.test.js
```
Expected: FAIL — file does not exist.

- [ ] **Step 3: Write minimal implementation**

```js
// src/renderer/contact-avatar.js
(function (global) {
  "use strict";

  function renderAvatar(contact, options = {}) {
    const el = document.createElement("span");
    el.className = `avatar contact-avatar${options.className ? " " + options.className : ""}`;
    const avatar = contact && contact.avatar ? contact.avatar : { image: "", crop: null, color: "" };
    const color = avatar.color || "#5e5ce6";
    if (avatar.image) {
      const helper = global.aimashiAvatar?.avatarThumbBackgroundStyle;
      let style = "";
      if (typeof helper === "function") style = helper(avatar.image, avatar.crop, color);
      if (!style) style = `background-image:url('${avatar.image}');background-color:${color};background-size:cover;background-position:center;`;
      el.style.cssText = style;
      el.textContent = "";
    } else {
      const letter = ((contact?.displayName || "")[0] || "?").toUpperCase();
      el.style.cssText = `background-color:${color};color:#fff;display:inline-flex;align-items:center;justify-content:center;`;
      el.textContent = letter;
    }
    return el;
  }

  global.aimashiContactAvatar = { renderAvatar };
})(typeof window !== "undefined" ? window : globalThis);
```

- [ ] **Step 4: Run test to verify it passes**

```
node --test tests/renderer-contact-avatar.test.js
```
Expected: PASS — 3 tests pass.

- [ ] **Step 5: Register the script in index.html**

Modify `src/renderer/index.html` — locate the line `<script src="./sidebar-card-renderer.js"></script>` and add immediately before it:

```html
  <!-- Shared avatar renderer (one entry point for every avatar display) -->
  <script src="./contact-avatar.js"></script>
```

- [ ] **Step 6: Commit**

```
git add src/renderer/contact-avatar.js tests/renderer-contact-avatar.test.js src/renderer/index.html
git commit -m "feat(renderer): contact-avatar.js — single entry point for avatar render"
```

**Stage 1 acceptance:** `npm test` passes the new 4 test files plus the existing 346. No renderer behavior changed yet — modules are present but unused outside their tests.

---

## Stage 2 — Message Source Adapters

Goal: build three adapters (fellow, local-group, cloud-room) that emit `RenderableMessageSpec` from their respective raw message shapes. Adapters are independent — testable in isolation. No bubble renderer yet.

### Task 2.1: FellowSessionSource adapter

**Files:**
- Create: `src/renderer/message-sources/fellow-session-source.js`
- Test: `tests/fellow-session-source.test.js`
- Modify: `src/renderer/index.html`

- [ ] **Step 1: Write the failing test**

```js
// tests/fellow-session-source.test.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadSource() {
  const sharedSpec = fs.readFileSync(path.join(__dirname, "..", "src", "shared", "message-spec.js"), "utf8");
  const sharedContact = fs.readFileSync(path.join(__dirname, "..", "src", "shared", "contact.js"), "utf8");
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "message-sources", "fellow-session-source.js"), "utf8");
  const exports1 = {}, exports2 = {};
  const window = {};
  const ctx = vm.createContext({ window, globalThis: window, module: { exports: {} }, require, console });
  // Pre-populate window with shared modules (renderer wraps them via globals from CommonJS bundles in real index.html load)
  vm.runInContext("globalThis.aimashiMessageSpec = (function(){ const module = { exports: {} }; " + sharedSpec + "; return module.exports; })();", ctx);
  vm.runInContext("globalThis.aimashiContact = (function(){ const module = { exports: {} }; " + sharedContact + "; return module.exports; })();", ctx);
  vm.runInContext(src, ctx);
  return window.aimashiFellowSessionSource;
}

test("FellowSessionSource maps user message to spec", () => {
  const src = loadSource();
  const session = { id: "s1", personaKey: "codex", messages: [
    { role: "user", content: "hi", createdAt: "2026-05-22T01:00:00.000Z", attachments: [] }
  ]};
  const ctx = {
    self: { id: "user_me", username: "me", avatarImage: "data:me" },
    fellows: [{ key: "codex", name: "Codex", avatarImage: "data:codex" }],
    friends: []
  };
  const source = src.createFellowSessionSource({ session, persona: ctx.fellows[0], ctx });
  const specs = source.listMessages();
  assert.equal(specs.length, 1);
  assert.equal(specs[0].source, "fellow-session");
  assert.equal(specs[0].role, "user");
  assert.equal(specs[0].isOwn, true);
  assert.equal(specs[0].authorName, "me");
});

test("FellowSessionSource maps assistant message with fellow avatar", () => {
  const src = loadSource();
  const session = { id: "s1", personaKey: "codex", messages: [
    { role: "assistant", content: "hello", createdAt: "2026-05-22T01:01:00.000Z" }
  ]};
  const ctx = {
    self: { id: "user_me", username: "me" },
    fellows: [{ key: "codex", name: "Codex", avatarImage: "data:codex" }],
    friends: []
  };
  const source = src.createFellowSessionSource({ session, persona: ctx.fellows[0], ctx });
  const spec = source.listMessages()[0];
  assert.equal(spec.role, "assistant");
  assert.equal(spec.isOwn, false);
  assert.equal(spec.authorName, "Codex");
  assert.equal(spec.avatar.image, "data:codex");
});

test("FellowSessionSource exposes capabilities reply+copy+pin+delete", () => {
  const src = loadSource();
  const session = { id: "s1", personaKey: "codex", messages: [{ role: "user", content: "x", createdAt: "" }] };
  const ctx = { self: {}, fellows: [{ key: "codex" }], friends: [] };
  const source = src.createFellowSessionSource({ session, persona: ctx.fellows[0], ctx });
  const cap = source.listMessages()[0].capabilities;
  assert.equal(cap.reply, true);
  assert.equal(cap.copy, true);
  assert.equal(cap.pin, true);
  assert.equal(cap.delete, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

```
node --test tests/fellow-session-source.test.js
```
Expected: FAIL — source file missing.

- [ ] **Step 3: Write minimal implementation**

```js
// src/renderer/message-sources/fellow-session-source.js
(function (global) {
  "use strict";

  function spec() {
    return global.aimashiMessageSpec || require("../../shared/message-spec");
  }
  function contact() {
    return global.aimashiContact || require("../../shared/contact");
  }

  function createFellowSessionSource({ session, persona, ctx }) {
    const { normalizeSpec } = spec();
    const { resolveContact, ContactKind } = contact();
    const fellowContact = resolveContact({ kind: ContactKind.Fellow, ref: persona.key || persona.id }, ctx);
    const selfContact = resolveContact({ kind: ContactKind.Self }, ctx);

    function listMessages() {
      const msgs = Array.isArray(session.messages) ? session.messages : [];
      return msgs.map((m, idx) => {
        const isUser = m.role === "user";
        const author = isUser ? selfContact : fellowContact;
        return normalizeSpec({
          source: "fellow-session",
          conversationId: session.id,
          messageId: m.id || `${session.id}#${idx}`,
          messageIndex: idx,
          role: m.role,
          authorName: author.displayName,
          avatar: author.avatar,
          bodyMd: String(m.content || m.text || ""),
          createdAt: m.createdAt || "",
          attachments: Array.isArray(m.attachments) ? m.attachments : [],
          isOwn: isUser,
          capabilities: { reply: true, copy: true, pin: true, delete: true }
        });
      });
    }

    return { kind: "fellow-session", id: session.id, listMessages };
  }

  global.aimashiFellowSessionSource = { createFellowSessionSource };
})(typeof window !== "undefined" ? window : globalThis);
```

- [ ] **Step 4: Run test to verify it passes**

```
node --test tests/fellow-session-source.test.js
```
Expected: PASS — 3 tests pass.

- [ ] **Step 5: Register script in index.html**

Modify `src/renderer/index.html`, add immediately after the `contact-avatar.js` line:

```html
  <!-- Message source adapters (raw schema → RenderableMessageSpec) -->
  <script src="./message-sources/fellow-session-source.js"></script>
```

- [ ] **Step 6: Commit**

```
git add src/renderer/message-sources/fellow-session-source.js tests/fellow-session-source.test.js src/renderer/index.html
git commit -m "feat(renderer): FellowSessionSource adapter (fellow private chat → spec)"
```

### Task 2.2: LocalGroupSource adapter

**Files:**
- Create: `src/renderer/message-sources/local-group-source.js`
- Test: `tests/local-group-source.test.js`
- Modify: `src/renderer/index.html`

- [ ] **Step 1: Write the failing test**

```js
// tests/local-group-source.test.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadSource() {
  const sharedSpec = fs.readFileSync(path.join(__dirname, "..", "src", "shared", "message-spec.js"), "utf8");
  const sharedContact = fs.readFileSync(path.join(__dirname, "..", "src", "shared", "contact.js"), "utf8");
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "message-sources", "local-group-source.js"), "utf8");
  const window = {};
  const ctx = vm.createContext({ window, globalThis: window, console });
  vm.runInContext("globalThis.aimashiMessageSpec = (function(){ const module = { exports: {} }; " + sharedSpec + "; return module.exports; })();", ctx);
  vm.runInContext("globalThis.aimashiContact = (function(){ const module = { exports: {} }; " + sharedContact + "; return module.exports; })();", ctx);
  vm.runInContext(src, ctx);
  return window.aimashiLocalGroupSource;
}

test("LocalGroupSource maps user + fellow messages with correct authors", () => {
  const src = loadSource();
  const group = {
    id: "g_local_1",
    name: "Test Group",
    members: [{ kind: "fellow", fellowId: "codex" }, { kind: "fellow", fellowId: "claude" }],
    hostMember: { fellowId: "codex" }
  };
  const messages = [
    { id: "m1", role: "user", content: "Hello team", createdAt: "2026-05-22T01:00:00.000Z" },
    { id: "m2", role: "assistant", content: "Hi!", senderFellowId: "codex", createdAt: "2026-05-22T01:00:30.000Z" }
  ];
  const ctx = {
    self: { id: "user_me", username: "me" },
    fellows: [
      { key: "codex", name: "Codex", avatarImage: "data:codex" },
      { key: "claude", name: "Claude", avatarImage: "data:claude" }
    ],
    friends: []
  };
  const source = src.createLocalGroupSource({ group, messages, ctx });
  const specs = source.listMessages();
  assert.equal(specs.length, 2);
  assert.equal(specs[0].authorName, "me");
  assert.equal(specs[0].isOwn, true);
  assert.equal(specs[1].authorName, "Codex");
  assert.equal(specs[1].avatar.image, "data:codex");
});

test("LocalGroupSource capabilities include reply/copy/pin/delete", () => {
  const src = loadSource();
  const group = { id: "g1", members: [] };
  const source = src.createLocalGroupSource({ group, messages: [{ id: "m", role: "user", content: "x", createdAt: "" }], ctx: { self: {}, fellows: [], friends: [] } });
  const cap = source.listMessages()[0].capabilities;
  assert.equal(cap.reply, true);
  assert.equal(cap.delete, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

```
node --test tests/local-group-source.test.js
```
Expected: FAIL — source file missing.

- [ ] **Step 3: Write minimal implementation**

```js
// src/renderer/message-sources/local-group-source.js
(function (global) {
  "use strict";

  function spec() { return global.aimashiMessageSpec || require("../../shared/message-spec"); }
  function contact() { return global.aimashiContact || require("../../shared/contact"); }

  function createLocalGroupSource({ group, messages, ctx }) {
    const { normalizeSpec } = spec();
    const { resolveContact, ContactKind } = contact();
    const selfContact = resolveContact({ kind: ContactKind.Self }, ctx);

    function authorForMessage(m) {
      if (m.role === "user") return selfContact;
      if (m.role === "system") {
        return { kind: "system", id: "system", displayName: "系统", avatar: { image: "", crop: null, color: "#888" } };
      }
      const fellowKey = m.senderFellowId || m.fellowId || (group.hostMember && group.hostMember.fellowId);
      return resolveContact({ kind: ContactKind.Fellow, ref: fellowKey }, ctx);
    }

    function listMessages() {
      const msgs = Array.isArray(messages) ? messages : [];
      return msgs.map((m, idx) => {
        const isOwn = m.role === "user";
        const author = authorForMessage(m);
        return normalizeSpec({
          source: "local-group",
          conversationId: group.id,
          messageId: m.id || `${group.id}#${idx}`,
          messageIndex: idx,
          role: m.role,
          authorName: author.displayName,
          avatar: author.avatar,
          bodyMd: String(m.content || m.text || ""),
          createdAt: m.createdAt || "",
          attachments: Array.isArray(m.attachments) ? m.attachments : [],
          mentions: Array.isArray(m.mentions) ? m.mentions : [],
          isOwn,
          capabilities: { reply: true, copy: true, pin: true, delete: true }
        });
      });
    }

    return { kind: "local-group", id: group.id, listMessages };
  }

  global.aimashiLocalGroupSource = { createLocalGroupSource };
})(typeof window !== "undefined" ? window : globalThis);
```

- [ ] **Step 4: Run test to verify it passes**

```
node --test tests/local-group-source.test.js
```
Expected: PASS — 2 tests pass.

- [ ] **Step 5: Register script in index.html**

Modify `src/renderer/index.html`, add after `fellow-session-source.js` line:

```html
  <script src="./message-sources/local-group-source.js"></script>
```

- [ ] **Step 6: Commit**

```
git add src/renderer/message-sources/local-group-source.js tests/local-group-source.test.js src/renderer/index.html
git commit -m "feat(renderer): LocalGroupSource adapter"
```

### Task 2.3: CloudRoomSource adapter (DM + group via member.kind)

**Files:**
- Create: `src/renderer/message-sources/cloud-room-source.js`
- Test: `tests/cloud-room-source.test.js`
- Modify: `src/renderer/index.html`

- [ ] **Step 1: Write the failing test**

```js
// tests/cloud-room-source.test.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadSource() {
  const sharedSpec = fs.readFileSync(path.join(__dirname, "..", "src", "shared", "message-spec.js"), "utf8");
  const sharedContact = fs.readFileSync(path.join(__dirname, "..", "src", "shared", "contact.js"), "utf8");
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "message-sources", "cloud-room-source.js"), "utf8");
  const window = {};
  const ctx = vm.createContext({ window, globalThis: window, console });
  vm.runInContext("globalThis.aimashiMessageSpec = (function(){ const module = { exports: {} }; " + sharedSpec + "; return module.exports; })();", ctx);
  vm.runInContext("globalThis.aimashiContact = (function(){ const module = { exports: {} }; " + sharedContact + "; return module.exports; })();", ctx);
  vm.runInContext(src, ctx);
  return window.aimashiCloudRoomSource;
}

test("CloudRoomSource DM friend message uses friend avatar", () => {
  const src = loadSource();
  const room = { id: "dm:user_me:user_friend", name: null };
  const messages = [
    { id: "msg1", sender_kind: "user", sender_ref: "user_friend", body_md: "hi", created_at: "2026-05-22T01:00:00.000Z", seq: 1 }
  ];
  const ctx = {
    self: { id: "user_me", username: "me" },
    fellows: [],
    friends: [{ id: "user_friend", username: "alice", avatarImage: "data:alice" }]
  };
  const source = src.createCloudRoomSource({ room, messages, members: [], ctx });
  const spec = source.listMessages()[0];
  assert.equal(spec.source, "cloud-room");
  assert.equal(spec.role, "user");
  assert.equal(spec.authorName, "alice");
  assert.equal(spec.avatar.image, "data:alice");
  assert.equal(spec.isOwn, false);
});

test("CloudRoomSource own message marks isOwn=true", () => {
  const src = loadSource();
  const room = { id: "dm:user_me:user_friend" };
  const messages = [{ id: "msg2", sender_kind: "user", sender_ref: "user_me", body_md: "ok", created_at: "", seq: 2 }];
  const ctx = { self: { id: "user_me", username: "me" }, fellows: [], friends: [] };
  const source = src.createCloudRoomSource({ room, messages, members: [], ctx });
  const spec = source.listMessages()[0];
  assert.equal(spec.isOwn, true);
  assert.equal(spec.authorName, "me");
});

test("CloudRoomSource group fellow message resolves fellow contact via members", () => {
  const src = loadSource();
  const room = { id: "g_room1", name: "Mixed" };
  const messages = [{ id: "msg3", sender_kind: "fellow", sender_ref: "codex", body_md: "yo", created_at: "", seq: 3 }];
  const members = [
    { member_kind: "fellow", member_ref: "codex", owner_id: "user_friend" },
    { member_kind: "user", member_ref: "user_friend" }
  ];
  const ctx = {
    self: { id: "user_me", username: "me" },
    fellows: [],
    friends: [{ id: "user_friend", username: "alice" }]
  };
  const source = src.createCloudRoomSource({ room, messages, members, ctx });
  const spec = source.listMessages()[0];
  assert.equal(spec.role, "assistant");
  assert.equal(spec.authorName, "codex (alice)");
});

test("CloudRoomSource capabilities include copy + reply but pin/delete false (no endpoint yet)", () => {
  const src = loadSource();
  const room = { id: "dm:a:b" };
  const messages = [{ id: "m", sender_kind: "user", sender_ref: "a", body_md: "x", created_at: "", seq: 1 }];
  const source = src.createCloudRoomSource({ room, messages, members: [], ctx: { self: {}, fellows: [], friends: [] } });
  const cap = source.listMessages()[0].capabilities;
  assert.equal(cap.copy, true);
  assert.equal(cap.reply, true);
  assert.equal(cap.pin, false);
  assert.equal(cap.delete, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

```
node --test tests/cloud-room-source.test.js
```
Expected: FAIL — source missing.

- [ ] **Step 3: Write minimal implementation**

```js
// src/renderer/message-sources/cloud-room-source.js
(function (global) {
  "use strict";

  function spec() { return global.aimashiMessageSpec || require("../../shared/message-spec"); }
  function contact() { return global.aimashiContact || require("../../shared/contact"); }

  function createCloudRoomSource({ room, messages, members, ctx }) {
    const { normalizeSpec } = spec();
    const { resolveContact, ContactKind } = contact();
    const selfId = ctx.self?.id || "";
    const memberArr = Array.isArray(members) ? members : [];

    function authorForMessage(m) {
      if (m.sender_kind === "user") {
        if (m.sender_ref === selfId) return resolveContact({ kind: ContactKind.Self }, ctx);
        return resolveContact({ kind: ContactKind.User, ref: m.sender_ref }, ctx);
      }
      if (m.sender_kind === "fellow") {
        const member = memberArr.find((mem) => mem.member_kind === "fellow" && mem.member_ref === m.sender_ref);
        const ownerLabel = member ? (member.owner?.username || member.owner_username) : "";
        let owner = ownerLabel;
        if (!owner && member?.owner_id) {
          const friend = (ctx.friends || []).find((f) => f.id === member.owner_id);
          if (friend) owner = friend.username || friend.account || "";
          if (!owner && selfId === member.owner_id) owner = ctx.self?.username || "";
        }
        const displayName = owner ? `${m.sender_ref} (${owner})` : m.sender_ref;
        return {
          kind: ContactKind.Fellow,
          id: m.sender_ref,
          displayName,
          avatar: { image: "", crop: null, color: "#5e5ce6" }
        };
      }
      return { kind: "", id: "", displayName: m.sender_ref || "", avatar: { image: "", crop: null, color: "#888" } };
    }

    function listMessages() {
      const msgs = Array.isArray(messages) ? messages : [];
      return msgs.map((m, idx) => {
        const author = authorForMessage(m);
        const isOwnUser = m.sender_kind === "user" && m.sender_ref === selfId;
        return normalizeSpec({
          source: "cloud-room",
          conversationId: room.id,
          messageId: m.id || `${room.id}#${m.seq || idx}`,
          messageIndex: idx,
          role: m.sender_kind === "fellow" ? "assistant" : "user",
          authorName: author.displayName,
          avatar: author.avatar,
          bodyMd: String(m.body_md || ""),
          createdAt: m.created_at || "",
          attachments: m.attachments_json ? safeJsonArray(m.attachments_json) : (Array.isArray(m.attachments) ? m.attachments : []),
          mentions: m.mentions_json ? safeJsonArray(m.mentions_json) : (Array.isArray(m.mentions) ? m.mentions : []),
          isOwn: isOwnUser,
          capabilities: { reply: true, copy: true, pin: false, delete: false }
        });
      });
    }

    function safeJsonArray(s) { try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch { return []; } }

    return { kind: "cloud-room", id: room.id, listMessages };
  }

  global.aimashiCloudRoomSource = { createCloudRoomSource };
})(typeof window !== "undefined" ? window : globalThis);
```

- [ ] **Step 4: Run test to verify it passes**

```
node --test tests/cloud-room-source.test.js
```
Expected: PASS — 4 tests pass.

- [ ] **Step 5: Register script in index.html**

Modify `src/renderer/index.html`, add after `local-group-source.js`:

```html
  <script src="./message-sources/cloud-room-source.js"></script>
```

- [ ] **Step 6: Commit**

```
git add src/renderer/message-sources/cloud-room-source.js tests/cloud-room-source.test.js src/renderer/index.html
git commit -m "feat(renderer): CloudRoomSource adapter (DM + group cloud messages → spec)"
```

**Stage 2 acceptance:** All three adapters produce a `RenderableMessageSpec` from their respective raw schemas. `npm test` passes. No renderer behavior changed — adapters are unused outside tests.

---

## Stage 3 — Unified Bubble Renderer

Goal: ship a single `createMessageBubble(spec)` that becomes the only message-bubble DOM producer. Replace the four existing renderers in `app.js renderChat`, `group.js renderActiveGroup`, `social.js renderRoomChat`, and the inline cloud-group renderer.

### Task 3.1: createMessageBubble + context menu

**Files:**
- Create: `src/renderer/message-bubble-renderer.js`
- Test: `tests/message-bubble-renderer.test.js`
- Modify: `src/renderer/index.html`

- [ ] **Step 1: Write the failing test**

```js
// tests/message-bubble-renderer.test.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadRenderer() {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "message-bubble-renderer.js"), "utf8");
  const mockEl = () => {
    const el = {
      tagName: "ARTICLE",
      className: "",
      attrs: {},
      children: [],
      style: { cssText: "" },
      _text: "",
      _html: "",
      _listeners: {},
      appendChild(c) { this.children.push(c); return c; },
      addEventListener(name, fn) { this._listeners[name] = fn; },
      setAttribute(k, v) { this.attrs[k] = v; },
      get innerHTML() { return this._html; },
      set innerHTML(v) { this._html = v; },
      get textContent() { return this._text; },
      set textContent(v) { this._text = v; }
    };
    return el;
  };
  const window = {
    aimashiMarkdown: { escapeHtml: (v) => String(v || ""), renderMarkdown: (v) => String(v || "") },
    aimashiContactAvatar: { renderAvatar: (c) => mockEl() }
  };
  const ctx = vm.createContext({ window, globalThis: window, document: { createElement: () => mockEl() }, console });
  vm.runInContext(src, ctx);
  return window.aimashiMessageBubble;
}

test("createMessageBubble user message gets .message.user class", () => {
  const r = loadRenderer();
  const article = r.createMessageBubble({
    source: "fellow-session", conversationId: "c", messageId: "m",
    role: "user", authorName: "me", bodyMd: "hi", isOwn: true,
    avatar: { image: "", color: "#0162db" }, capabilities: { reply: true, copy: true, pin: true, delete: true }
  });
  assert.match(article.className, /message user/);
});

test("createMessageBubble assistant message gets .message.assistant class", () => {
  const r = loadRenderer();
  const article = r.createMessageBubble({
    source: "cloud-room", conversationId: "dm", messageId: "m",
    role: "assistant", authorName: "Codex", bodyMd: "ok",
    avatar: { image: "data:codex" }, capabilities: { reply: true, copy: true, pin: false, delete: false }
  });
  assert.match(article.className, /message assistant/);
});

test("createMessageBubble emits contextmenu listener on the article", () => {
  const r = loadRenderer();
  const calls = [];
  const article = r.createMessageBubble({
    source: "cloud-room", conversationId: "x", messageId: "y",
    role: "user", authorName: "a", bodyMd: "x", isOwn: false,
    avatar: { color: "#5e5ce6" }, capabilities: { reply: true, copy: true, pin: false, delete: false }
  }, {
    onContextMenu: (spec, x, y) => calls.push({ spec, x, y })
  });
  article._listeners.contextmenu({ preventDefault() {}, stopPropagation() {}, clientX: 10, clientY: 20 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].spec.messageId, "y");
});
```

- [ ] **Step 2: Run test to verify it fails**

```
node --test tests/message-bubble-renderer.test.js
```
Expected: FAIL — module missing.

- [ ] **Step 3: Write minimal implementation**

```js
// src/renderer/message-bubble-renderer.js
(function (global) {
  "use strict";

  function escapeHtml(value) {
    const h = global.aimashiMarkdown?.escapeHtml;
    if (typeof h === "function") return h(value);
    return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]));
  }
  function renderMd(md) {
    const fn = global.aimashiMarkdown?.renderMarkdown;
    if (typeof fn === "function") { try { return fn(md); } catch { /* fall */ } }
    return escapeHtml(md);
  }
  function shortTime(value) {
    if (!value) return "";
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  }

  function createMessageBubble(spec, options = {}) {
    const article = document.createElement("article");
    const role = spec.role === "user" ? "user" : (spec.role === "system" ? "system" : "assistant");
    article.className = `message ${role}${spec.isOwn ? " is-own" : ""}${spec.isPending ? " is-pending" : ""}`;
    article.setAttribute("data-message-id", spec.messageId || "");
    article.setAttribute("data-source", spec.source || "");

    const avatarEl = global.aimashiContactAvatar?.renderAvatar
      ? global.aimashiContactAvatar.renderAvatar({ displayName: spec.authorName, avatar: spec.avatar || {} })
      : null;
    if (avatarEl) article.appendChild(avatarEl);

    const stack = document.createElement("div");
    stack.className = "message-stack";
    const showAuthor = spec.authorName && !spec.isOwn && role !== "system";
    stack.innerHTML = `
      ${showAuthor ? `<span class="message-sender">${escapeHtml(spec.authorName)}</span>` : ""}
      <div class="bubble">${renderMd(spec.bodyMd || "")}</div>
      <span class="message-time">${escapeHtml(shortTime(spec.createdAt))}</span>
    `;
    article.appendChild(stack);

    article.addEventListener("contextmenu", (event) => {
      if (typeof options.onContextMenu !== "function") return;
      event.preventDefault();
      event.stopPropagation();
      options.onContextMenu(spec, event.clientX, event.clientY);
    });
    return article;
  }

  global.aimashiMessageBubble = { createMessageBubble };
})(typeof window !== "undefined" ? window : globalThis);
```

- [ ] **Step 4: Run test to verify it passes**

```
node --test tests/message-bubble-renderer.test.js
```
Expected: PASS — 3 tests pass.

- [ ] **Step 5: Register script in index.html**

Modify `src/renderer/index.html`, add immediately after `cloud-room-source.js`:

```html
  <!-- Single message-bubble DOM producer -->
  <script src="./message-bubble-renderer.js"></script>
```

- [ ] **Step 6: Commit**

```
git add src/renderer/message-bubble-renderer.js tests/message-bubble-renderer.test.js src/renderer/index.html
git commit -m "feat(renderer): createMessageBubble — single DOM producer for all messages"
```

### Task 3.2: Wire fellow private chat through bubble renderer

**Files:**
- Modify: `src/renderer/app.js` (in `renderChat`, replace inline message creation with bubble renderer fed by FellowSessionSource)

- [ ] **Step 1: Identify the current fellow-message render block**

Open `src/renderer/app.js`. Locate `function renderChat()` around line 1731. Inside it, find the loop that iterates `session.messages` and constructs `<article class="message ...">` HTML.

- [ ] **Step 2: Replace inline construction with adapter + bubble**

Replace the inline loop with:

```js
// Inside renderChat(), after we have `session` + `persona` resolved:
const messageContext = {
  self: state.runtime?.user || {},
  fellows: state.runtime?.fellows || state.runtime?.personas || [],
  friends: window.aimashiSocial?.moduleState?.friends || []
};
const source = window.aimashiFellowSessionSource.createFellowSessionSource({ session, persona, ctx: messageContext });
const specs = source.listMessages();
els.chat.innerHTML = "";
for (const spec of specs) {
  const bubble = window.aimashiMessageBubble.createMessageBubble(spec, {
    onContextMenu: (s, x, y) => window.aimashiMessageMenu?.openMessageMenu?.(s, x, y)
  });
  els.chat.appendChild(bubble);
}
els.chat.scrollTop = els.chat.scrollHeight;
```

- [ ] **Step 3: Restart and verify visually**

```
npm run open
```

Open a fellow private chat with existing messages. Verify:
- Messages display with bubble + time + avatar
- Right-clicking opens the existing message menu
- Sender name shows for assistant messages

- [ ] **Step 4: Run tests to confirm no regression**

```
npm test
```
Expected: PASS — same count as before this task plus new ones.

- [ ] **Step 5: Commit**

```
git add src/renderer/app.js
git commit -m "refactor(renderer): fellow chat uses createMessageBubble via FellowSessionSource"
```

### Task 3.3: Wire local group through bubble renderer

**Files:**
- Modify: `src/renderer/group/group.js` (function `renderActiveGroup` / `renderGroupMessagesIntoChat`)

- [ ] **Step 1: Locate the existing renderer**

Open `src/renderer/group/group.js`. Find `function renderGroupMessagesIntoChat(group, msgs, chatEl)` around line 530.

- [ ] **Step 2: Replace inline render with adapter + bubble**

Replace the function body with:

```js
function renderGroupMessagesIntoChat(group, msgs, chatEl) {
  if (!chatEl) return;
  const messageContext = {
    self: moduleState.deps?.getState?.()?.runtime?.user || {},
    fellows: moduleState.deps?.getFellows?.() || [],
    friends: window.aimashiSocial?.moduleState?.friends || []
  };
  const source = window.aimashiLocalGroupSource.createLocalGroupSource({ group, messages: msgs, ctx: messageContext });
  const specs = source.listMessages();
  chatEl.innerHTML = "";
  for (const spec of specs) {
    const bubble = window.aimashiMessageBubble.createMessageBubble(spec, {
      onContextMenu: (s, x, y) => window.aimashiMessageMenu?.openMessageMenu?.(s, x, y)
    });
    chatEl.appendChild(bubble);
  }
  chatEl.scrollTop = chatEl.scrollHeight;
}
```

- [ ] **Step 3: Verify visually**

```
npm run open
```
Open a local group. Verify messages render with avatars + time + right-click.

- [ ] **Step 4: Run tests**

```
npm test
```
Expected: PASS.

- [ ] **Step 5: Commit**

```
git add src/renderer/group/group.js
git commit -m "refactor(renderer): local group chat uses createMessageBubble via LocalGroupSource"
```

### Task 3.4: Wire cloud DM + group through bubble renderer

**Files:**
- Modify: `src/renderer/social/social.js` (`renderRoomChat`, lines ~313-378)
- Delete (replace contents): `_buildMessageArticle`, internal call to `_buildGroupMessageArticle`

- [ ] **Step 1: Replace renderRoomChat body**

In `src/renderer/social/social.js`, locate `function renderRoomChat(containerEl)`. Replace the function body with:

```js
function renderRoomChat(containerEl) {
  if (!containerEl) return;
  const roomId = moduleState.activeRoomId;
  if (!roomId) return;
  const room = moduleState.rooms.find((r) => r.id === roomId);
  if (!room) return;
  const entry = moduleState.messageCache.get(roomId) || { messages: [], maxSeq: 0 };
  const members = _roomMembersCache.get(roomId) || [];
  const messageContext = {
    self: deps?.getState?.()?.runtime?.user || { id: moduleState.myUserId, username: moduleState.myUsername },
    fellows: deps?.getState?.()?.runtime?.fellows || deps?.getState?.()?.runtime?.personas || [],
    friends: moduleState.friends
  };
  const source = window.aimashiCloudRoomSource.createCloudRoomSource({ room, messages: entry.messages, members, ctx: messageContext });
  const specs = source.listMessages();
  containerEl.innerHTML = "";
  for (const spec of specs) {
    const bubble = window.aimashiMessageBubble.createMessageBubble(spec, {
      onContextMenu: (s, x, y) => window.aimashiMessageMenu?.openMessageMenu?.(s, x, y)
    });
    containerEl.appendChild(bubble);
  }
  containerEl.scrollTop = containerEl.scrollHeight;

  // Topbar updates remain (name + meta + avatar)
  const nameEl = document.getElementById("activeChatName");
  const metaEl = document.getElementById("activeChatMeta");
  const isGroup = room.name != null && roomId.startsWith("g_");
  if (isGroup) {
    if (nameEl) nameEl.textContent = room.name || "群聊";
    if (metaEl) metaEl.textContent = members.length ? `群聊 · ${members.length} 人` : "群聊";
  } else {
    const other = otherUserForRoom(room);
    if (nameEl) nameEl.textContent = other.username || other.account || "好友";
    if (metaEl) metaEl.textContent = "私聊";
  }
}
```

- [ ] **Step 2: Update _appendMessageToActiveChat to use bubble**

Replace `function _appendMessageToActiveChat(msg)` with:

```js
function _appendMessageToActiveChat(msg) {
  const chatEl = document.getElementById("chat");
  if (!chatEl) return;
  const room = moduleState.rooms.find((r) => r.id === moduleState.activeRoomId);
  if (!room) return;
  const members = _roomMembersCache.get(room.id) || [];
  const messageContext = {
    self: deps?.getState?.()?.runtime?.user || { id: moduleState.myUserId, username: moduleState.myUsername },
    fellows: deps?.getState?.()?.runtime?.fellows || deps?.getState?.()?.runtime?.personas || [],
    friends: moduleState.friends
  };
  const source = window.aimashiCloudRoomSource.createCloudRoomSource({ room, messages: [msg], members, ctx: messageContext });
  const spec = source.listMessages()[0];
  if (!spec) return;
  const bubble = window.aimashiMessageBubble.createMessageBubble(spec, {
    onContextMenu: (s, x, y) => window.aimashiMessageMenu?.openMessageMenu?.(s, x, y)
  });
  chatEl.appendChild(bubble);
  chatEl.scrollTop = chatEl.scrollHeight;
}
```

- [ ] **Step 3: Delete the now-unused `_buildMessageArticle` + `_buildGroupMessageArticle` + `_renderMsgBody` shim**

In `src/renderer/social/social.js`, delete `function _buildMessageArticle`, `function _buildGroupMessageArticle`, and `function _renderMsgBody`. Also delete `function buildGroupMessageArticle` in `src/renderer/social/social-groups.js`.

- [ ] **Step 4: Verify visually**

```
npm run open
```
Open a DM and a cloud group. Verify messages render with friend's avatar + time + right-click menu. Send a message — confirm WS event still appends correctly via `_appendMessageToActiveChat`.

- [ ] **Step 5: Run tests**

```
npm test
```
Expected: PASS.

- [ ] **Step 6: Commit**

```
git add src/renderer/social/social.js src/renderer/social/social-groups.js
git commit -m "refactor(renderer): cloud DM + group use createMessageBubble via CloudRoomSource"
```

**Stage 3 acceptance:** Every message bubble in every conversation kind (fellow private / local group / cloud DM / cloud group) renders via the same `createMessageBubble`. Right-click triggers the same menu hook. Timestamps display uniformly. `_buildMessageArticle` and `_buildGroupMessageArticle` are deleted from the codebase. `npm test` passes.

---

## Stage 4 — Avatar Everywhere via renderAvatar

Goal: every place that displays a user/friend/fellow avatar uses `aimashiContactAvatar.renderAvatar` with a resolved `Contact`. The 7-place inconsistency the user observed disappears.

### Task 4.1: Add-friend dialog incoming/outgoing rows

**Files:**
- Modify: `src/renderer/social/social.js` (`_renderRequestList`, line ~640)

- [ ] **Step 1: Locate the existing row builder**

Find `function _renderRequestList(container, requests, direction, modal)`.

- [ ] **Step 2: Add avatar element to each row**

Replace the inner row builder so each row constructs an avatar via `renderAvatar`:

```js
for (const req of requests) {
  const row = document.createElement("div");
  row.style.cssText = "display:flex; align-items:center; gap:10px; padding:6px 0; border-bottom:1px solid var(--border,rgba(0,0,0,.08));";

  const otherUser = req.other || req.from || {};
  const fallbackId = direction === "incoming" ? req.from_user : req.to_user;
  const displayName = otherUser.username || otherUser.account || fallbackId || "—";

  const ctx = {
    self: deps?.getState?.()?.runtime?.user || {},
    fellows: [],
    friends: moduleState.friends.concat([{
      id: otherUser.id || fallbackId,
      username: otherUser.username,
      account: otherUser.account,
      avatarImage: otherUser.avatarImage,
      avatarCrop: otherUser.avatarCrop,
      avatarColor: otherUser.avatarColor
    }])
  };
  const contact = window.aimashiContact
    ? window.aimashiContact.resolveContact({ kind: "user", ref: otherUser.id || fallbackId }, ctx)
    : { displayName, avatar: { image: "", color: "#5e5ce6" } };
  const avatarEl = window.aimashiContactAvatar.renderAvatar(contact, { className: "request-row-avatar" });
  avatarEl.style.cssText += "width:32px; height:32px; flex:0 0 auto;";
  row.appendChild(avatarEl);

  const nameSpan = document.createElement("span");
  nameSpan.style.cssText = "flex:1; font-weight:500;";
  nameSpan.textContent = displayName;
  row.appendChild(nameSpan);
  // ... existing accept/reject/cancel buttons remain ...
```

- [ ] **Step 3: Expose `aimashiContact` to window**

Modify `src/renderer/index.html` — directly before `<script src="./contact-avatar.js"></script>` insert:

```html
  <!-- Shared Contact resolver -->
  <script>(function(){const m={exports:{}};</script>
  <script src="./shared/contact.js"></script>
  <script>window.aimashiContact = m.exports || window.aimashiContact;})();</script>
```

Wait — this approach is fragile. Instead, modify `src/shared/contact.js` to detect browser context:

Append to `src/shared/contact.js`:

```js
if (typeof window !== "undefined") {
  window.aimashiContact = module.exports;
}
```

And include via:

```html
  <script src="./shared/contact.js"></script>
```

before `contact-avatar.js`. Same approach for `time-format.js` and `message-spec.js`.

- [ ] **Step 4: Verify visually**

`npm run open` → open add-friend dialog → confirm avatars show next to incoming/outgoing usernames.

- [ ] **Step 5: Run tests**

```
npm test
```
Expected: PASS.

- [ ] **Step 6: Commit**

```
git add src/renderer/social/social.js src/shared/contact.js src/shared/time-format.js src/shared/message-spec.js src/renderer/index.html
git commit -m "feat(renderer): add-friend dialog uses renderAvatar for incoming/outgoing rows"
```

### Task 4.2: Create-group dialog friend selector + group-info dialog

**Files:**
- Modify: `src/renderer/social/social-groups.js` (`_renderCreateGroupModal`)

- [ ] **Step 1: Locate the friend checkbox rendering**

In `src/renderer/social/social-groups.js` find the loop that builds friend checkboxes inside `_renderCreateGroupModal`.

- [ ] **Step 2: Add avatar next to each friend's name**

Replace the inner checkbox creation so each row gets an avatar:

```js
for (const friend of moduleState.friends) {
  const row = document.createElement("label");
  row.style.cssText = "display:flex; align-items:center; gap:10px; padding:6px 0; cursor:pointer;";
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.value = friend.id;
  cb.dataset.kind = "friend";
  const contact = window.aimashiContact.resolveContact({ kind: "user", ref: friend.id }, {
    self: deps?.getState?.()?.runtime?.user || {},
    fellows: [],
    friends: moduleState.friends
  });
  const avatarEl = window.aimashiContactAvatar.renderAvatar(contact, { className: "selector-avatar" });
  avatarEl.style.cssText += "width:28px;height:28px;flex:0 0 auto;";
  const nameSpan = document.createElement("span");
  nameSpan.textContent = contact.displayName;
  row.appendChild(cb);
  row.appendChild(avatarEl);
  row.appendChild(nameSpan);
  friendsList.appendChild(row);
}
```

- [ ] **Step 3: Verify visually**

`npm run open` → 发起群聊 → 朋友列表应当显示头像。

- [ ] **Step 4: Run tests**

```
npm test
```
Expected: PASS.

- [ ] **Step 5: Commit**

```
git add src/renderer/social/social-groups.js
git commit -m "feat(renderer): create-group dialog friend rows show avatars via renderAvatar"
```

### Task 4.3: Sidebar card + topbar resolve avatars through Contact

**Files:**
- Modify: `src/renderer/app.js` (`conversationCardSpecFromRow` and topbar avatar updates)

- [ ] **Step 1: Refactor `conversationCardSpecFromRow` to delegate avatar build to Contact**

In `src/renderer/app.js`, the existing `conversationCardSpecFromRow` already pulls avatar fields from friend/fellow records. Update each branch to resolve via `aimashiContact.resolveContact` and pass a single `Contact` (kind/name/avatar) into the spec rather than reading `friend.avatarImage` etc. directly. Example for the `dm-room` branch:

```js
if (row.type === "dm-room") {
  const room = row.room;
  const otherId = (() => {
    const parts = room.id.split(":");
    return parts[1] === state.runtime?.user?.id ? parts[2] : parts[1];
  })();
  const ctxObj = {
    self: state.runtime?.user || {},
    fellows: state.runtime?.fellows || state.runtime?.personas || [],
    friends: window.aimashiSocial?.moduleState?.friends || []
  };
  const contact = window.aimashiContact.resolveContact({ kind: "user", ref: otherId }, ctxObj);
  // ... use contact.displayName, contact.avatar
  return {
    kind: "private",
    active: room.id === window.aimashiSocial?.getActiveRoomId?.(),
    pinned: false,
    name: contact.displayName,
    typeLabel: "私聊",
    preview: room.lastMessagePreview || "暂无对话",
    time: formatConversationTime(row.updatedAt),
    unread: window.aimashiSocial?.getUnreadForRoom?.(room.id) || 0,
    avatar: contact.avatar,
    onClick: () => { /* existing handler */ },
    onContextMenu: (x, y) => openRoomContextMenu(room, "dm", x, y)
  };
}
```

Apply the same Contact-resolution pattern to the fellow, group, and group-room branches.

- [ ] **Step 2: Verify visually**

Open desktop app, verify sidebar avatars look the same as before (regression check).

- [ ] **Step 3: Run tests**

```
npm test
```
Expected: PASS.

- [ ] **Step 4: Commit**

```
git add src/renderer/app.js
git commit -m "refactor(renderer): sidebar cards resolve avatar through Contact + renderAvatar"
```

**Stage 4 acceptance:** Every avatar display surface (sidebar card / chat topbar / chat bubble / add-friend dialog / create-group dialog) renders via `renderAvatar(contact)` after resolving through `resolveContact`. Same friend displayed in any two places shows the same avatar. `npm test` passes.

---

## Stage 5 — Active Conversation Adapter

Goal: collapse the three-way `state.activeKey` / `activeGroup()` / `getActiveRoomId()` checks scattered across `renderChat`, topbar render, composer submit, and send-button enable into one `getActiveConversation()` call.

### Task 5.1: getActiveConversation module

**Files:**
- Create: `src/renderer/active-conversation.js`
- Test: `tests/active-conversation.test.js`
- Modify: `src/renderer/index.html`

- [ ] **Step 1: Write the failing test**

```js
// tests/active-conversation.test.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function load() {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "active-conversation.js"), "utf8");
  const window = {};
  const ctx = vm.createContext({ window, globalThis: window, console });
  vm.runInContext(src, ctx);
  return window.aimashiActiveConversation;
}

test("fellow-session when state.activeKey points to a persona", () => {
  const mod = load();
  const conv = mod.getActiveConversation({
    state: { activeKey: "codex", activeGroupId: "" },
    personas: [{ key: "codex", name: "Codex" }],
    groups: [],
    socialActiveRoomId: ""
  });
  assert.equal(conv.kind, "fellow-session");
  assert.equal(conv.id, "codex");
});

test("local-group when state.activeGroupId set", () => {
  const mod = load();
  const conv = mod.getActiveConversation({
    state: { activeKey: "g1", activeGroupId: "g1" },
    personas: [],
    groups: [{ id: "g1", name: "Team" }],
    socialActiveRoomId: ""
  });
  assert.equal(conv.kind, "local-group");
});

test("cloud-room when socialActiveRoomId set", () => {
  const mod = load();
  const conv = mod.getActiveConversation({
    state: { activeKey: "", activeGroupId: "" },
    personas: [],
    groups: [],
    socialActiveRoomId: "dm:a:b"
  });
  assert.equal(conv.kind, "cloud-room");
  assert.equal(conv.id, "dm:a:b");
});

test("none when nothing active", () => {
  const mod = load();
  const conv = mod.getActiveConversation({ state: { activeKey: "", activeGroupId: "" }, personas: [], groups: [], socialActiveRoomId: "" });
  assert.equal(conv.kind, "none");
});
```

- [ ] **Step 2: Run test to verify it fails**

```
node --test tests/active-conversation.test.js
```
Expected: FAIL — module missing.

- [ ] **Step 3: Write minimal implementation**

```js
// src/renderer/active-conversation.js
(function (global) {
  "use strict";

  function getActiveConversation({ state, personas, groups, socialActiveRoomId }) {
    if (socialActiveRoomId) {
      const isGroup = String(socialActiveRoomId).startsWith("g_");
      return {
        kind: "cloud-room",
        id: socialActiveRoomId,
        isGroup
      };
    }
    if (state.activeGroupId) {
      const group = (groups || []).find((g) => g.id === state.activeGroupId);
      return { kind: "local-group", id: state.activeGroupId, group };
    }
    if (state.activeKey) {
      const persona = (personas || []).find((p) => p.key === state.activeKey);
      if (persona) return { kind: "fellow-session", id: state.activeKey, persona };
    }
    return { kind: "none", id: "" };
  }

  global.aimashiActiveConversation = { getActiveConversation };
})(typeof window !== "undefined" ? window : globalThis);
```

- [ ] **Step 4: Run test to verify it passes**

```
node --test tests/active-conversation.test.js
```
Expected: PASS — 4 tests pass.

- [ ] **Step 5: Register script in index.html**

Modify `src/renderer/index.html`, add after `message-bubble-renderer.js`:

```html
  <script src="./active-conversation.js"></script>
```

- [ ] **Step 6: Commit**

```
git add src/renderer/active-conversation.js tests/active-conversation.test.js src/renderer/index.html
git commit -m "feat(renderer): getActiveConversation() collapses 3-way state checks"
```

### Task 5.2: Refactor renderChat to delegate via active conv

**Files:**
- Modify: `src/renderer/app.js` (`function renderChat`)

- [ ] **Step 1: Replace the dispatch logic in renderChat**

In `src/renderer/app.js`, locate `function renderChat()`. Replace the leading dispatch block (the if/else checking `state.activeGroupId`, `state.activeKey`, `aimashiSocial.getActiveRoomId()`) with:

```js
function renderChat() {
  const conv = window.aimashiActiveConversation.getActiveConversation({
    state,
    personas: state.runtime?.personas || state.runtime?.fellows || [],
    groups: listGroups(),
    socialActiveRoomId: window.aimashiSocial?.getActiveRoomId?.() || ""
  });
  if (conv.kind === "cloud-room") {
    window.aimashiSocial.renderRoomChat(els.chat);
    return;
  }
  if (conv.kind === "local-group") {
    if (window.aimashiGroup?.renderActiveGroup) window.aimashiGroup.renderActiveGroup(conv.group);
    return;
  }
  if (conv.kind === "fellow-session") {
    // existing fellow-session render path (now uses the bubble renderer from Task 3.2)
    return renderFellowSessionChat(conv.persona);
  }
  els.chat.innerHTML = '<p class="chat-empty">没有选中的会话。</p>';
}
```

- [ ] **Step 2: Extract `renderFellowSessionChat(persona)` from the prior inline code**

Pull the fellow-session render logic (now using FellowSessionSource + bubble renderer, from Task 3.2) into a top-level `function renderFellowSessionChat(persona)` directly above `renderChat`.

- [ ] **Step 3: Verify visually**

`npm run open` — switch between fellow / local group / cloud DM / cloud group. Confirm each renders correctly.

- [ ] **Step 4: Run tests**

```
npm test
```
Expected: PASS.

- [ ] **Step 5: Commit**

```
git add src/renderer/app.js
git commit -m "refactor(renderer): renderChat delegates via getActiveConversation"
```

### Task 5.3: Refactor chatForm submit + send button enable

**Files:**
- Modify: `src/renderer/app.js` (chatForm submit handler around line 3595, sendButton enable logic)

- [ ] **Step 1: Replace submit dispatch**

In `src/renderer/app.js`, find the `els.chatForm.addEventListener("submit", ...)` block. Replace the body with:

```js
els.chatForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (window.aimashiMessageHelpers.isComposerComposing()) return;
  const conv = window.aimashiActiveConversation.getActiveConversation({
    state,
    personas: state.runtime?.personas || state.runtime?.fellows || [],
    groups: listGroups(),
    socialActiveRoomId: window.aimashiSocial?.getActiveRoomId?.() || ""
  });
  if (conv.kind === "cloud-room") {
    const text = els.chatInput.value.trim();
    if (!text) return;
    els.chatInput.value = "";
    window.aimashiMessageHelpers.resizeChatInput();
    const isGroup = String(conv.id).startsWith("g_");
    if (isGroup && typeof window.aimashiSocial.sendInActiveGroupRoom === "function") {
      await window.aimashiSocial.sendInActiveGroupRoom(text);
    } else {
      await window.aimashiSocial.sendInActiveRoom(text);
    }
    return;
  }
  if (conv.kind === "local-group") {
    if (window.aimashiGroup?.sendInActiveGroup) await window.aimashiGroup.sendInActiveGroup();
    return;
  }
  // fall back to the existing fellow-session send handler
  await handleFellowChatSubmit(event);
});
```

Move the prior fellow-chat-send body into a function `handleFellowChatSubmit(event)`.

- [ ] **Step 2: Verify visually**

`npm run open` — send messages in each conversation kind. All should work.

- [ ] **Step 3: Run tests**

```
npm test
```
Expected: PASS.

- [ ] **Step 4: Commit**

```
git add src/renderer/app.js
git commit -m "refactor(renderer): chatForm submit + send button delegate via active conversation"
```

**Stage 5 acceptance:** `state.activeKey` / `activeGroup()` / `getActiveRoomId()` are no longer mixed-tested inside `renderChat`, topbar, submit, or send-button enable. Each location asks `getActiveConversation()` once and dispatches based on `conv.kind`. `npm test` passes.

---

## Stage 6 — Unified Group Response Mode (cloud groups honor the same setting local groups have)

Goal: cloud rooms must consult `group.decorations.responseMode` (the existing `GROUP_RESPONSE_MODE = { Conductor, MentionsOnly }` enum) on every incoming message, exactly like local groups do. The conductor is **one implementation of one mode**, not "the cloud group feature." Same UI toggle that local groups expose in the group-info dialog gets surfaced for cloud rooms.

Four guards apply universally (already in the conductor flow for local groups; just need to make sure they fire for cloud rooms): `sender_kind === "user"` only / my-fellow-only / turn_id dedup / no fellow→fellow auto-relay.

### Task 6.1: Persist responseMode on cloud rooms (schema v4)

**Files:**
- Modify: `src/cloud/sqlite-store.js` (rooms table v4 migration: add `decorations_json` column)
- Modify: `scripts/serve-cloud.js` (room CRUD reads/writes `decorations_json`)
- Test: `tests/cloud-sqlite-store.test.js` (extend with v4 migration + decorations round-trip)

- [ ] **Step 1: Add v4 migration for decorations_json**

In `src/cloud/sqlite-store.js`, in the migration block at the bottom of the schema setup:

```js
if (!hasColumn(db, "rooms", "decorations_json")) {
  db.exec("ALTER TABLE rooms ADD COLUMN decorations_json TEXT NOT NULL DEFAULT '{}'");
}
db.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (4, ?)")
  .run(nowIso());
```

- [ ] **Step 2: Add row mapper + getter/setter for decorations**

In `src/cloud/sqlite-store.js`, where `rowToRoom` (or equivalent) is defined, include `decorations` parsed from `decorations_json`. Add `updateRoomDecorations(roomId, ownerId, patch)` and `getRoomDecorations(roomId)`.

- [ ] **Step 3: Add `/api/rooms/:id/decorations PATCH` endpoint**

In `scripts/serve-cloud.js`, after the existing room routes, add:

```js
const decoMatch = url.pathname.match(/^\/api\/rooms\/([A-Za-z0-9_:-]+)\/decorations$/);
if (req.method === "PATCH" && decoMatch) {
  const roomId = decoMatch[1];
  if (!userIsMemberOfRoom(context.socialStore, roomId, auth.user.id)) {
    return writeError(res, 403, "not a member of this room");
  }
  const body = await readJson(req);
  const merged = context.socialStore.mergeRoomDecorations(roomId, body || {});
  broadcastEvent(context.eventHub, ..., { type: CloudEvent.RoomDecorationsUpdated, roomId, decorations: merged });
  return writeJson(res, 200, { decorations: merged });
}
```

Note: also add `RoomDecorationsUpdated: "room.decorations_updated"` to `src/shared/cloud-events.js` per Stage 7.1.

- [ ] **Step 4: Write the failing migration test**

In `tests/cloud-sqlite-store.test.js`, add:

```js
test("v4 migration adds decorations_json column with default '{}'", () => {
  const { db } = setupTempStore();
  const cols = db.prepare("PRAGMA table_info(rooms)").all().map((c) => c.name);
  assert.ok(cols.includes("decorations_json"));
  const dec = db.prepare("SELECT decorations_json FROM rooms LIMIT 1").get();
  // For pre-existing rows, default is '{}'.
  if (dec) assert.equal(dec.decorations_json, "{}");
});
```

- [ ] **Step 5: Run tests**

```
npm test
```
Expected: PASS. Schema migration is idempotent.

- [ ] **Step 6: Commit**

```
git add src/cloud/sqlite-store.js scripts/serve-cloud.js tests/cloud-sqlite-store.test.js
git commit -m "feat(cloud): rooms.decorations_json + PATCH /api/rooms/:id/decorations (schema v4)"
```

### Task 6.2: Unified group-dispatch module that consults responseMode

The local group already uses `groupResponseMode(group)` to pick between Conductor and MentionsOnly. We extract the dispatch decision into a shared module that BOTH local-group send AND cloud-room incoming-message both call. The module returns the list of fellows (mine only) to run; the caller handles actually running them.

**Files:**
- Create: `src/renderer/group-dispatch.js`
- Test: `tests/group-dispatch.test.js`
- Modify: `src/renderer/index.html` (load `group-dispatch.js` after `response-mode.js`)
- Modify: `src/renderer/group/group.js` (replace the local dispatch decision with `chooseDispatch(...)`)

- [ ] **Step 1: Write the failing test**

```js
// tests/group-dispatch.test.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function load() {
  const responseModeSrc = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "group", "response-mode.js"), "utf8");
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "group-dispatch.js"), "utf8");
  const window = {};
  const ctx = vm.createContext({ window, globalThis: window, module: { exports: {} }, console });
  vm.runInContext(responseModeSrc, ctx);
  vm.runInContext(src, ctx);
  return window.aimashiGroupDispatch;
}

test("MentionsOnly mode: returns only mentioned fellows owned by me", async () => {
  const mod = load();
  const fakeConductor = { decideDispatch: () => { throw new Error("should not be called"); } };
  const result = await mod.chooseDispatch({
    group: { id: "g1", decorations: { responseMode: "mentions-only" } },
    members: [
      { member_kind: "fellow", member_ref: "codex", owner_id: "user_me" },
      { member_kind: "fellow", member_ref: "claude", owner_id: "user_friend" }
    ],
    myUserId: "user_me",
    myFellowKeys: ["codex"],
    message: { sender_kind: "user", sender_ref: "user_friend", body_md: "@codex hi", mentions: [{ kind: "fellow", fellowId: "codex" }], turn_id: "t1" },
    conductor: fakeConductor
  });
  assert.deepEqual(result.speak, ["codex"]);
});

test("Conductor mode: asks decideDispatch with my fellows only", async () => {
  const mod = load();
  let received = null;
  const conductor = { decideDispatch: (args) => { received = args; return { speak: ["codex"] }; } };
  const result = await mod.chooseDispatch({
    group: { id: "g1", decorations: { responseMode: "conductor" } },
    members: [
      { member_kind: "fellow", member_ref: "codex", owner_id: "user_me" },
      { member_kind: "fellow", member_ref: "claude", owner_id: "user_friend" }
    ],
    myUserId: "user_me",
    myFellowKeys: ["codex"],
    message: { sender_kind: "user", sender_ref: "user_friend", body_md: "anyone?", mentions: [], turn_id: "t2" },
    conductor
  });
  assert.deepEqual(received.members.map((m) => m.member_ref), ["codex"]);
  assert.deepEqual(result.speak, ["codex"]);
});

test("Guard: own user message → no dispatch", async () => {
  const mod = load();
  const result = await mod.chooseDispatch({
    group: { id: "g1", decorations: { responseMode: "conductor" } },
    members: [{ member_kind: "fellow", member_ref: "codex", owner_id: "user_me" }],
    myUserId: "user_me",
    myFellowKeys: ["codex"],
    message: { sender_kind: "user", sender_ref: "user_me", body_md: "x", turn_id: "t3" },
    conductor: { decideDispatch: () => ({ speak: ["codex"] }) }
  });
  assert.deepEqual(result.speak, []);
  assert.equal(result.skipped, "own-message");
});

test("Guard: fellow sender → no dispatch (no fellow→fellow auto-relay)", async () => {
  const mod = load();
  const result = await mod.chooseDispatch({
    group: { id: "g1", decorations: { responseMode: "conductor" } },
    members: [{ member_kind: "fellow", member_ref: "codex", owner_id: "user_me" }],
    myUserId: "user_me",
    myFellowKeys: ["codex"],
    message: { sender_kind: "fellow", sender_ref: "claude", body_md: "x", turn_id: "t4" },
    conductor: { decideDispatch: () => ({ speak: ["codex"] }) }
  });
  assert.deepEqual(result.speak, []);
});

test("Guard: turn_id dedup", async () => {
  const mod = load();
  const seen = new Set(["t5"]);
  const result = await mod.chooseDispatch({
    group: { id: "g1", decorations: { responseMode: "conductor" } },
    members: [{ member_kind: "fellow", member_ref: "codex", owner_id: "user_me" }],
    myUserId: "user_me",
    myFellowKeys: ["codex"],
    message: { sender_kind: "user", sender_ref: "user_friend", body_md: "x", turn_id: "t5" },
    seenTurnIds: seen,
    conductor: { decideDispatch: () => ({ speak: ["codex"] }) }
  });
  assert.deepEqual(result.speak, []);
  assert.equal(result.skipped, "duplicate-turn");
});

test("Guard: I own no fellows in this group → no dispatch", async () => {
  const mod = load();
  const result = await mod.chooseDispatch({
    group: { id: "g1", decorations: { responseMode: "conductor" } },
    members: [{ member_kind: "fellow", member_ref: "claude", owner_id: "user_friend" }],
    myUserId: "user_me",
    myFellowKeys: [],
    message: { sender_kind: "user", sender_ref: "user_friend", body_md: "x", turn_id: "t6" },
    conductor: { decideDispatch: () => ({ speak: ["claude"] }) }
  });
  assert.deepEqual(result.speak, []);
});
```

- [ ] **Step 2: Run test to verify it fails**

```
node --test tests/group-dispatch.test.js
```
Expected: FAIL — module missing.

- [ ] **Step 3: Write minimal implementation**

```js
// src/renderer/group-dispatch.js
(function (global) {
  "use strict";

  function getResponseMode(group) {
    const api = global.aimashiGroupResponseMode;
    if (api && typeof api.groupResponseMode === "function") return api.groupResponseMode(group);
    return group?.decorations?.responseMode || "conductor";
  }

  function ownsAFellow(myFellowKeys, member, myUserId) {
    return member.member_kind === "fellow"
      && (member.owner_id === myUserId || (myFellowKeys || []).includes(member.member_ref));
  }

  async function chooseDispatch({ group, members, myUserId, myFellowKeys, message, conductor, seenTurnIds }) {
    // Guard 1: only act on user-sent messages
    if (message.sender_kind && message.sender_kind !== "user") return { speak: [], skipped: "non-user-sender" };
    if (message.role && message.role !== "user") return { speak: [], skipped: "non-user-sender" };
    // Guard 2: ignore my own messages
    if (message.sender_ref === myUserId) return { speak: [], skipped: "own-message" };
    // Guard 3: dedup by turn_id
    const turnId = message.turn_id || message.turnId;
    if (turnId && seenTurnIds && seenTurnIds.has(turnId)) return { speak: [], skipped: "duplicate-turn" };
    if (turnId && seenTurnIds) seenTurnIds.add(turnId);
    // Guard 4: restrict to fellows I own (or this device knows about)
    const myFellowMembers = (members || []).filter((m) => ownsAFellow(myFellowKeys, m, myUserId));
    if (myFellowMembers.length === 0) return { speak: [], skipped: "no-owned-fellows" };

    const mode = getResponseMode(group);
    if (mode === "mentions-only") {
      const mentionIds = (message.mentions || [])
        .filter((m) => m.kind === "fellow")
        .map((m) => m.fellowId);
      const speak = mentionIds.filter((id) => myFellowMembers.some((m) => m.member_ref === id));
      return { speak, mode };
    }
    // mode === "conductor"
    let dispatch;
    try {
      dispatch = await conductor.decideDispatch({
        group,
        members: myFellowMembers,
        fellowNamesById: {},
        userMessage: { id: message.id, role: "user", content: message.body_md || message.content || "", createdAt: message.created_at || message.createdAt },
        messages: []
      });
    } catch (err) {
      console.warn("[group-dispatch] conductor.decideDispatch threw:", err);
      return { speak: [], mode, degraded: true };
    }
    const speak = Array.isArray(dispatch?.speak) ? dispatch.speak.filter((id) => myFellowMembers.some((m) => m.member_ref === id)) : [];
    return { speak, mode, degraded: Boolean(dispatch?.degraded) };
  }

  global.aimashiGroupDispatch = { chooseDispatch };
})(typeof window !== "undefined" ? window : globalThis);
```

- [ ] **Step 4: Run test to verify it passes**

```
node --test tests/group-dispatch.test.js
```
Expected: PASS — 6 tests pass.

- [ ] **Step 5: Refactor `src/renderer/group/group.js` to use chooseDispatch**

In `src/renderer/group/group.js`, in `sendInGroup`, replace the `if (mode === MentionsOnly) { ... } else { decideDispatch(...) }` block with:

```js
const result = await window.aimashiGroupDispatch.chooseDispatch({
  group,
  members: members.map((f) => ({
    member_kind: "fellow",
    member_ref: f.id || f.key,
    owner_id: moduleState.deps?.getState?.()?.runtime?.user?.id || ""
  })),
  myUserId: moduleState.deps?.getState?.()?.runtime?.user?.id || "",
  myFellowKeys: members.map((f) => f.id || f.key),
  message: { sender_kind: "user", sender_ref: moduleState.deps?.getState?.()?.runtime?.user?.id || "", body_md: text, mentions: parseMentionsFor(group, text).map((id) => ({ kind: "fellow", fellowId: id })), turn_id: turnId },
  conductor: moduleState.conductor
});
const dispatch = { speak: result.speak, degraded: result.degraded || false };
```

The downstream "for each fellow in dispatch.speak, run it" block stays unchanged.

- [ ] **Step 6: Register script in index.html**

In `src/renderer/index.html`, add after `group/response-mode.js`:

```html
  <script src="./group-dispatch.js"></script>
```

- [ ] **Step 7: Manual verify — local group still works in both modes**

`npm run open` → in a local group → toggle response mode between Conductor and MentionsOnly via the existing UI → send messages → verify behavior matches each mode.

- [ ] **Step 8: Run tests**

```
npm test
```
Expected: PASS — local-group dispatch unchanged in behavior, new module tested.

- [ ] **Step 9: Commit**

```
git add src/renderer/group-dispatch.js tests/group-dispatch.test.js src/renderer/group/group.js src/renderer/index.html
git commit -m "feat(renderer): unified chooseDispatch — local group consults responseMode through shared module"
```

### Task 6.3: Cloud rooms use the same chooseDispatch on WS message_appended

**Files:**
- Modify: `src/renderer/social/social.js` (handleCloudEvent room.message_appended branch)
- Modify: `src/renderer/social/social-groups.js` (expose `runFellowInRoom`)

- [ ] **Step 1: Add dedup set to moduleState**

In `src/renderer/social/social.js`, in `moduleState`, add `seenDispatchTurnIds: new Set()`.

- [ ] **Step 2: Call chooseDispatch on incoming room messages**

In the `if (type === "room.message_appended")` branch in `handleCloudEvent`, AFTER appending the message to cache and BEFORE `renderRoomChat`:

```js
const room = moduleState.rooms.find((r) => r.id === roomId);
const isGroup = room && room.name != null && roomId.startsWith("g_");
if (isGroup) {
  const fellows = deps?.getState?.()?.runtime?.fellows || deps?.getState?.()?.runtime?.personas || [];
  const myFellowKeys = fellows.map((f) => f.key || f.id);
  const conductor = window.aimashiGroup?.moduleState?.conductor || null;
  window.aimashiGroupDispatch.chooseDispatch({
    group: { id: roomId, decorations: room.decorations || {} },
    members: _roomMembersCache.get(roomId) || [],
    myUserId: moduleState.myUserId,
    myFellowKeys,
    message,
    seenTurnIds: moduleState.seenDispatchTurnIds,
    conductor
  }).then((result) => {
    for (const fellowKey of result.speak || []) {
      window.aimashiSocialGroups?.runFellowInRoom?.(fellowKey, room, message);
    }
  }).catch((err) => console.warn("[social] chooseDispatch error:", err));
}
```

The cloud room consults `room.decorations.responseMode` (defaulted to "conductor" by `groupResponseMode`'s normalization), so a room with no decorations gets the Conductor mode — same fallback as local groups.

- [ ] **Step 3: Expose runFellowInRoom in social-groups.js**

If not already present, add to `src/renderer/social/social-groups.js`:

```js
async function runFellowInRoom(fellowKey, room, sourceMessage) {
  const fellow = (ctx.deps?.getState?.()?.runtime?.fellows || []).find((f) => (f.key || f.id) === fellowKey);
  if (!fellow) return;
  // Reuse the existing handleFellowInvocation body (mention-triggered path), which
  // already builds the prompt, runs the local engine and posts back via
  // /api/rooms/:id/messages/as-fellow. Pass a synthesized invocation payload:
  return handleFellowInvocation({
    roomId: room.id,
    fellowId: fellowKey,
    triggeringMessage: { id: sourceMessage.id, body_md: sourceMessage.body_md || "" },
    recentMessages: (ctx.moduleState.messageCache.get(room.id)?.messages || []).slice(-10),
    members: ctx.roomMembersCache.get(room.id) || []
  });
}
global.aimashiSocialGroups.runFellowInRoom = runFellowInRoom;
```

- [ ] **Step 4: Add group-info UI to expose responseMode toggle for cloud rooms**

In whichever dialog surfaces cloud-room info (Task: extend the existing `openRoomContextMenu` placeholder), add a row with a select that PATCHes `/api/rooms/:id/decorations` with `{ responseMode: "conductor" | "mentions-only" }`. The select reads `room.decorations.responseMode` and writes via the new endpoint from Task 6.1.

- [ ] **Step 5: Manual integration test**

`npm run open` on two machines logged into different accounts. Friend's account creates a group with one of my fellows. Friend sends a message; verify:
- Default (Conductor mode): my fellow auto-responds.
- Toggle to MentionsOnly via group settings → friend sends without @: no response. Friend sends `@codex hi`: my codex responds.

- [ ] **Step 6: Run tests**

```
npm test
```
Expected: PASS — same count plus the cloud-events constant + decoration tests.

- [ ] **Step 7: Commit**

```
git add src/renderer/social/social.js src/renderer/social/social-groups.js
git commit -m "feat(social): cloud rooms honor group.decorations.responseMode (Conductor / MentionsOnly)"
```

**Stage 6 acceptance:**
- Local-group send + cloud-room incoming both call the same `chooseDispatch` and the same `GROUP_RESPONSE_MODE` toggle works for both. No parallel "is this a cloud group" branches in dispatch code.
- A friend posting in a cloud group containing one of my fellows triggers my fellow to respond when the room's `decorations.responseMode === "conductor"`. Set to `"mentions-only"` → only explicit @ triggers.
- Group-info UI in both local groups AND cloud rooms exposes the same response-mode toggle. The cloud-room toggle PATCHes `/api/rooms/:id/decorations`; the local group toggle continues to use `groupResponseModePatch`.
- Guards prevent: my own messages re-triggering, fellow→fellow auto-relay, replayed events double-running, friend's fellows being dispatched on my machine.
- `npm test` passes including new `group-dispatch.test.js`, `cloud-sqlite-store.test.js` v4 migration test.

---

## Stage 7 — Parallel Work + Cleanup

Goal: collapse 42 hard-coded WS event strings to constants, write the canonical-state ADR, delete now-dead code.

### Task 7.1: cloud-events constants module

**Files:**
- Create: `src/shared/cloud-events.js`
- Test: `tests/shared-cloud-events.test.js`

- [ ] **Step 1: Write the failing test**

```js
// tests/shared-cloud-events.test.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { CloudEvent } = require("../src/shared/cloud-events");

test("CloudEvent has all 10 known event types", () => {
  assert.equal(CloudEvent.SocialFriendRequestReceived, "social.friend_request_received");
  assert.equal(CloudEvent.SocialFriendAdded, "social.friend_added");
  assert.equal(CloudEvent.SocialRoomInvited, "social.room_invited");
  assert.equal(CloudEvent.RoomMessageAppended, "room.message_appended");
  assert.equal(CloudEvent.RoomFellowInvocationRequested, "room.fellow_invocation_requested");
  assert.equal(CloudEvent.WorkspaceUpdated, "workspace_updated");
  assert.equal(CloudEvent.MessageCreated, "message_created");
  assert.equal(CloudEvent.BridgeRunUpdated, "bridge_run_updated");
  assert.equal(CloudEvent.DeviceUpdated, "device_updated");
  assert.equal(CloudEvent.EventsReady, "events_ready");
});

test("CloudEvent is frozen", () => {
  const { CloudEvent } = require("../src/shared/cloud-events");
  assert.throws(() => { CloudEvent.NewType = "foo"; });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
node --test tests/shared-cloud-events.test.js
```
Expected: FAIL — module missing.

- [ ] **Step 3: Write minimal implementation**

```js
// src/shared/cloud-events.js
const CloudEvent = Object.freeze({
  SocialFriendRequestReceived: "social.friend_request_received",
  SocialFriendAdded: "social.friend_added",
  SocialRoomInvited: "social.room_invited",
  RoomMessageAppended: "room.message_appended",
  RoomFellowInvocationRequested: "room.fellow_invocation_requested",
  WorkspaceUpdated: "workspace_updated",
  MessageCreated: "message_created",
  BridgeRunUpdated: "bridge_run_updated",
  DeviceUpdated: "device_updated",
  EventsReady: "events_ready"
});

module.exports = { CloudEvent };
if (typeof window !== "undefined") window.aimashiCloudEvents = module.exports;
```

- [ ] **Step 4: Run test to verify it passes**

```
node --test tests/shared-cloud-events.test.js
```
Expected: PASS.

- [ ] **Step 5: Commit**

```
git add src/shared/cloud-events.js tests/shared-cloud-events.test.js
git commit -m "feat(shared): CloudEvent constants for all 10 WS event types"
```

### Task 7.2: Replace 42 WS string literals with constants

**Files:**
- Modify: `src/main.js`, `scripts/serve-cloud.js`, `src/renderer/social/social.js`, `src/renderer/social/social-groups.js`, `src/web/app.js`, `src/renderer/index.html`

- [ ] **Step 1: Add `src/shared/cloud-events.js` to web/desktop loading paths**

Modify `src/renderer/index.html`, add early (with other shared scripts):

```html
  <script src="./shared/cloud-events.js"></script>
```

Modify `src/web/index.html`, add similarly:

```html
  <script src="./shared/cloud-events.js"></script>
```

(For `src/web/`, `cloud-events.js` needs to be present in `src/web/shared/`. Either symlink or copy — see Step 5.)

- [ ] **Step 2: In `scripts/serve-cloud.js`, require + replace each broadcast**

Add at top:

```js
const { CloudEvent } = require("../src/shared/cloud-events");
```

Then replace each `broadcastEvent(..., { type: "social.friend_added", ... })` with `broadcastEvent(..., { type: CloudEvent.SocialFriendAdded, ... })` etc. Search-and-replace each of the 10 literals.

- [ ] **Step 3: In `src/main.js`, require + replace**

Add: `const { CloudEvent } = require("./shared/cloud-events");`

Replace each `message.type === "events_ready"` etc with `message.type === CloudEvent.EventsReady`.

- [ ] **Step 4: In `src/renderer/social/social.js` and `social-groups.js`, use the global `window.aimashiCloudEvents.CloudEvent`**

Replace each `type === "social.friend_request_received"` etc with `type === window.aimashiCloudEvents.CloudEvent.SocialFriendRequestReceived`.

Do the same in `src/web/app.js`.

- [ ] **Step 5: Add web/shared symlink or copy**

Easiest: add to `scripts/build-cloud-release.js` the line `copyFile("src/shared/cloud-events.js", path.join(webDir, "shared", "cloud-events.js"));` and create `src/web/shared/` as a directory containing `cloud-events.js` (copy from src/shared).

Actually simpler: serve src/shared under the cloud release web root. Modify `build-cloud-release.js` to include `src/shared/cloud-events.js` as a copy operation into `web/shared/cloud-events.js`.

- [ ] **Step 6: Run tests + manual sanity**

```
npm test
```
Expected: PASS — same count.

- [ ] **Step 7: Commit**

```
git add -A
git commit -m "refactor: replace 42 WS event-type literals with CloudEvent constants"
```

### Task 7.3: Write the canonical-state ADR

**Files:**
- Create: `docs/adr/2026-05-22-conversation-state-canonical-owner.md`

- [ ] **Step 1: Write the ADR document**

```markdown
# ADR: Conversation state canonical owner

**Date:** 2026-05-22
**Status:** Accepted

## Context

aimashi has multiple stores for conversation state: desktop chatStore (local
sessions), desktop groupStore (local groups), cloud workspace (cross-device
mirror), social moduleState (renderer cache). Each was added at a different
time for a different purpose. Without a written authority, contributors keep
adding fifth/sixth stores when new features arrive.

## Decision

When the user is logged into Aimashi Cloud, **cloud is the write authority**
for every conversation state mutation. The desktop chatStore is treated as
an offline cache + write-through mirror; the renderer's social moduleState
is a read-only view onto cloud, derived from REST + WS.

When the user is logged out, the desktop chatStore is the local-only
authority for fellow sessions and local groups. Cloud writes do not exist.
At login, the existing `syncAimashiCloudWorkspace()` pipeline merges in
both directions.

## Consequences

- New conversation-level state (unread cursor, pin flag, custom name, etc.)
  must be added to the cloud schema and exposed through `/api/workspace/sync`
  or a similar endpoint. It is NOT acceptable to add a fifth store.
- Renderer code reads from the cache for snappy UI but writes always go to
  cloud first (with the response merged back).
- Multi-device unread / read-cursor sync is now in scope; the prior
  in-memory `unreadByRoom` Map is a TODO that needs a `room_members.last_read_seq`
  field.

## Alternatives considered

- "Local-first with periodic sync" — rejected because aimashi's multi-device
  use case (which prompted Cloud) means we'd be designing for conflict
  resolution rather than freshness.
- "Each store keeps its own authority for its data type" — rejected; this
  is the current state and it's what causes "real human friend = different
  rendering" bugs.
```

- [ ] **Step 2: Commit**

```
git add docs/adr/2026-05-22-conversation-state-canonical-owner.md
git commit -m "docs(adr): conversation state canonical owner — cloud is write authority when logged in"
```

### Task 7.4: Final cleanup — delete dead code

**Files:**
- Modify: `src/renderer/social/social.js` (delete `_buildMessageArticle`, `_buildGroupMessageArticle`, `_renderMsgBody`)
- Modify: `src/renderer/social/social-groups.js` (delete `buildGroupMessageArticle`)
- Modify: `src/renderer/app.js` (delete the now-dead `formatMessageTime` if shared/time-format.js covers all callers)

- [ ] **Step 1: Search for remaining references**

```
grep -rn "_buildMessageArticle\|_buildGroupMessageArticle\|buildGroupMessageArticle" src/ tests/
```
Expected: no matches outside of definitions about to be deleted.

- [ ] **Step 2: Delete the functions**

Remove `function _buildMessageArticle`, `function _buildGroupMessageArticle`, `function _renderMsgBody` from `src/renderer/social/social.js`. Remove `function buildGroupMessageArticle` from `src/renderer/social/social-groups.js`. Remove its entry from the `attach`'d exports if any.

- [ ] **Step 3: Run tests**

```
npm test
```
Expected: PASS.

- [ ] **Step 4: Verify visually**

`npm run open` — confirm no rendering regression.

- [ ] **Step 5: Commit**

```
git add src/renderer/social/social.js src/renderer/social/social-groups.js src/renderer/app.js
git commit -m "chore: delete dead message-article builders replaced by createMessageBubble"
```

**Stage 7 acceptance:** No remaining inline message-article builders. 42 WS event literals replaced by constants. ADR documents canonical-owner decision. `npm test` passes.

---

## Final Deploy

After all 7 stages:

- [ ] Run full test suite: `npm test` — expected PASS, count includes all new tests.
- [ ] Codex adversarial review via `codex:rescue`: focus on (a) stage-3 dead-code deletion missed any caller; (b) stage-6 conductor guards under reconnect / event replay; (c) avatar resolution under empty/missing data.
- [ ] Push: `git push origin main`.
- [ ] Cloud deploy (only if Stage 7.2 touched the cloud release manifest): `npm run cloud:deploy`.
