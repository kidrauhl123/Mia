# RN Mobile Phase 2A Message Approval Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve RN chat parity by rendering Cloud message attachments and making Agent approval queue state visible and recoverable.

**Architecture:** Keep all protocol normalization inside `apps/mobile-rn/src/logic` and render through small RN components. `ChatScreen` remains the owner of send/delete/retry behavior, while `MessageBubble` owns message presentation and `ApprovalSheet` owns the global approval overlay. No desktop renderer or web code is imported.

**Tech Stack:** Expo SDK 56, React Native 0.85, React 19.2.3, React Navigation 7, TanStack Query 5, TypeScript 6, Jest 30.

---

## Scope

This plan implements the first Phase 2 slice from `docs/superpowers/specs/2026-06-08-rn-mobile-desktop-parity-design.md`.

In scope:

- Normalize Cloud file/image attachments into typed mobile attachment objects.
- Preserve attachments through message normalization, optimistic sends, and render-time props.
- Render image/file attachments in native message bubbles with absolute Cloud URLs.
- Show approval queue count and decision submission failure feedback in `ApprovalSheet`.

Out of scope:

- Native image/document pickers.
- Uploading newly selected local files from mobile.
- Model/effort/permission mutation controls.
- Full desktop trace block parity.
- Push notifications.

## File Structure

- Modify `apps/mobile-rn/src/api/types.ts`: add `MessageAttachment` and attach it to `MessageRow` / `ChatMessage`.
- Create `apps/mobile-rn/src/logic/attachments.ts`: normalize attachment records, detect image attachments, resolve relative Cloud URLs.
- Add `apps/mobile-rn/__tests__/attachments.test.ts`: TDD coverage for attachment normalization and URL resolution.
- Modify `apps/mobile-rn/src/logic/normalizeMessage.ts`: carry normalized attachments from server rows into `ChatMessage`.
- Modify `apps/mobile-rn/__tests__/normalizeMessage.test.ts`: verify attachments survive normalization.
- Create `apps/mobile-rn/src/components/AttachmentList.tsx`: render image previews and file rows.
- Modify `apps/mobile-rn/src/components/MessageBubble.tsx`: pass message attachments to `AttachmentList`.
- Modify `apps/mobile-rn/src/screens/ChatScreen.tsx`: pass `apiBase` to message bubbles and preserve attachments on retry.
- Modify `apps/mobile-rn/src/state/events.tsx`: expose `pendingApprovalCount` and keep approval count in sync with queue changes.
- Modify `apps/mobile-rn/src/components/ApprovalSheet.tsx`: show queue count and display decision submission failures.

## Task 1: Attachment Normalization

**Files:**
- Create: `apps/mobile-rn/src/logic/attachments.ts`
- Modify: `apps/mobile-rn/src/api/types.ts`
- Test: `apps/mobile-rn/__tests__/attachments.test.ts`

- [ ] **Step 1: Write failing attachment tests**

Create `apps/mobile-rn/__tests__/attachments.test.ts`:

```ts
import { isImageAttachment, normalizeAttachment, normalizeAttachments, resolveAttachmentUrl } from "../src/logic/attachments";

test("normalizes Cloud file attachment shape", () => {
  expect(normalizeAttachment({
    id: "file_1",
    type: "image",
    name: "shot.png",
    mimeType: "image/png",
    url: "/api/files/file_1",
    size: 123,
  })).toEqual({
    id: "file_1",
    type: "image",
    name: "shot.png",
    mimeType: "image/png",
    url: "/api/files/file_1",
    size: 123,
  });
});

test("normalizes legacy mime and drops unusable entries", () => {
  expect(normalizeAttachment({ name: "report.pdf", mime: "application/pdf", url: "https://cdn.test/r.pdf" })).toMatchObject({
    type: "file",
    name: "report.pdf",
    mimeType: "application/pdf",
    url: "https://cdn.test/r.pdf",
  });
  expect(normalizeAttachment({ name: "" })).toBeNull();
  expect(normalizeAttachments([{ name: "x.txt", url: "/api/files/a" }, null])).toHaveLength(1);
});

test("detects images by type, mime, or filename", () => {
  expect(isImageAttachment({ type: "image", name: "a.bin" })).toBe(true);
  expect(isImageAttachment({ mimeType: "image/jpeg", name: "a.bin" })).toBe(true);
  expect(isImageAttachment({ name: "photo.webp" })).toBe(true);
  expect(isImageAttachment({ name: "notes.txt" })).toBe(false);
});

test("resolves relative Cloud URLs against apiBase", () => {
  expect(resolveAttachmentUrl("/api/files/file_1", "https://mia.gifgif.cn")).toBe("https://mia.gifgif.cn/api/files/file_1");
  expect(resolveAttachmentUrl("https://cdn.test/a.png", "https://mia.gifgif.cn")).toBe("https://cdn.test/a.png");
  expect(resolveAttachmentUrl("", "https://mia.gifgif.cn")).toBe("");
});
```

- [ ] **Step 2: Verify tests fail**

Run:

```bash
cd apps/mobile-rn
npm test -- --runInBand __tests__/attachments.test.ts
```

Expected: fail because `src/logic/attachments.ts` does not exist.

- [ ] **Step 3: Add attachment types and helpers**

Modify `apps/mobile-rn/src/api/types.ts`:

```ts
export interface MessageAttachment {
  id?: string;
  type?: string;
  name?: string;
  mimeType?: string;
  url?: string;
  path?: string;
  size?: number;
  createdAt?: string;
}
```

Update `MessageRow.attachments` and `ChatMessage.attachments` to use `MessageAttachment[]`.

Create `apps/mobile-rn/src/logic/attachments.ts`:

```ts
import type { MessageAttachment } from "../api/types";

export function normalizeAttachment(input: any): MessageAttachment | null {
  if (!input || typeof input !== "object") return null;
  const url = String(input.url || input.path || "").trim();
  const name = String(input.name || input.filename || input.id || "").trim();
  if (!url && !name) return null;
  const mimeType = String(input.mimeType || input.mime || "").trim();
  const type = String(input.type || (mimeType.startsWith("image/") ? "image" : "file") || "file").trim();
  return {
    ...(input.id ? { id: String(input.id) } : {}),
    type,
    name: name || "附件",
    ...(mimeType ? { mimeType } : {}),
    ...(url ? { url } : {}),
    ...(input.path && !url ? { path: String(input.path) } : {}),
    ...(Number.isFinite(Number(input.size)) ? { size: Number(input.size) } : {}),
    ...(input.createdAt ? { createdAt: String(input.createdAt) } : {}),
  };
}

export function normalizeAttachments(input: unknown): MessageAttachment[] {
  if (!Array.isArray(input)) return [];
  return input.map(normalizeAttachment).filter(Boolean) as MessageAttachment[];
}

export function isImageAttachment(att: Pick<MessageAttachment, "type" | "mimeType" | "name">): boolean {
  const type = String(att.type || "").toLowerCase();
  const mime = String(att.mimeType || "").toLowerCase();
  const name = String(att.name || "").toLowerCase();
  return type === "image" || mime.startsWith("image/") || /\.(png|jpe?g|gif|webp|heic|heif)$/.test(name);
}

export function resolveAttachmentUrl(url: string | undefined, apiBase: string): string {
  const raw = String(url || "").trim();
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw) || /^data:/i.test(raw)) return raw;
  if (!raw.startsWith("/")) return raw;
  return `${String(apiBase || "").replace(/\/+$/, "")}${raw}`;
}
```

- [ ] **Step 4: Verify attachment tests pass**

Run:

```bash
cd apps/mobile-rn
npm test -- --runInBand __tests__/attachments.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile-rn/src/api/types.ts apps/mobile-rn/src/logic/attachments.ts apps/mobile-rn/__tests__/attachments.test.ts
git commit -m "feat(mobile): 规范化云端消息附件"
```

## Task 2: Message Attachment Data Flow

**Files:**
- Modify: `apps/mobile-rn/src/logic/normalizeMessage.ts`
- Modify: `apps/mobile-rn/__tests__/normalizeMessage.test.ts`

- [ ] **Step 1: Write failing normalization test**

Append to `apps/mobile-rn/__tests__/normalizeMessage.test.ts`:

```ts
test("attachments are normalized onto ChatMessage", () => {
  const m = normalizeServerRow({
    id: "m4",
    sender_kind: "bot",
    attachments: [{ id: "f1", name: "shot.png", mimeType: "image/png", url: "/api/files/f1" }],
  }, "u1");
  expect(m.attachments).toEqual([{ id: "f1", type: "image", name: "shot.png", mimeType: "image/png", url: "/api/files/f1" }]);
});
```

- [ ] **Step 2: Verify test fails**

Run:

```bash
cd apps/mobile-rn
npm test -- --runInBand __tests__/normalizeMessage.test.ts
```

Expected: fail because `normalizeServerRow` does not populate `attachments`.

- [ ] **Step 3: Normalize attachments in messages**

Modify `apps/mobile-rn/src/logic/normalizeMessage.ts`:

```ts
import { normalizeAttachments } from "./attachments";
```

Add to the returned `ChatMessage`:

```ts
attachments: normalizeAttachments(m.attachments),
```

- [ ] **Step 4: Verify normalization tests pass**

Run:

```bash
cd apps/mobile-rn
npm test -- --runInBand __tests__/normalizeMessage.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile-rn/src/logic/normalizeMessage.ts apps/mobile-rn/__tests__/normalizeMessage.test.ts
git commit -m "feat(mobile): 保留消息附件数据"
```

## Task 3: Attachment Rendering In Bubbles

**Files:**
- Create: `apps/mobile-rn/src/components/AttachmentList.tsx`
- Modify: `apps/mobile-rn/src/components/MessageBubble.tsx`
- Modify: `apps/mobile-rn/src/screens/ChatScreen.tsx`

- [ ] **Step 1: Create attachment renderer**

Create `apps/mobile-rn/src/components/AttachmentList.tsx`:

```tsx
import { Image, Linking, Pressable, StyleSheet, View } from "react-native";
import { isImageAttachment, resolveAttachmentUrl } from "../logic/attachments";
import { BodyStrong, Label } from "../ui/Text";
import { color, radius, space, hairlineWidth } from "../theme";
import type { MessageAttachment } from "../api/types";

export default function AttachmentList({ attachments, apiBase, own }: { attachments?: MessageAttachment[]; apiBase: string; own?: boolean }) {
  const items = attachments || [];
  if (!items.length) return null;
  return (
    <View style={styles.wrap}>
      {items.map((item, index) => {
        const uri = resolveAttachmentUrl(item.url || item.path, apiBase);
        const image = uri && isImageAttachment(item);
        return (
          <Pressable
            key={`${item.id || item.url || item.name || "att"}:${index}`}
            style={[styles.item, own ? styles.itemOwn : styles.itemOther]}
            disabled={!uri}
            onPress={() => uri && Linking.openURL(uri).catch(() => {})}
          >
            {image ? <Image source={{ uri }} style={styles.image} resizeMode="cover" /> : null}
            <View style={styles.meta}>
              <BodyStrong numberOfLines={1} style={own ? styles.ownText : undefined}>{item.name || "附件"}</BodyStrong>
              <Label numberOfLines={1} style={own ? styles.ownSub : undefined}>{item.mimeType || item.type || "file"}</Label>
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: space.sm, marginTop: space.sm },
  item: { overflow: "hidden", borderRadius: radius.md, borderWidth: hairlineWidth },
  itemOwn: { borderColor: "rgba(255,255,255,0.26)", backgroundColor: "rgba(255,255,255,0.10)" },
  itemOther: { borderColor: color.line, backgroundColor: color.surface },
  image: { width: 188, height: 124, backgroundColor: color.surfaceMuted },
  meta: { paddingHorizontal: space.sm, paddingVertical: space.sm, gap: 2 },
  ownText: { color: color.userBubbleText },
  ownSub: { color: "rgba(255,255,255,0.76)" },
});
```

- [ ] **Step 2: Render attachments from message bubbles**

Modify `apps/mobile-rn/src/components/MessageBubble.tsx` to import `AttachmentList`, accept `apiBase`, and render:

```tsx
<AttachmentList attachments={msg.attachments} apiBase={apiBase} own={own} />
```

- [ ] **Step 3: Pass apiBase from ChatScreen and preserve retry attachments**

Modify `apps/mobile-rn/src/screens/ChatScreen.tsx`:

```tsx
const { session, apiBase } = useAuth();
```

Pass `apiBase` to `MessageBubble`:

```tsx
renderItem={({ item }) => <MessageBubble msg={item} apiBase={apiBase} onLongPress={setActionMsg} />}
```

Preserve attachments on retry:

```ts
await postMessage({ bodyMd: m.bodyMd, clientTraceId: m.clientTraceId, attachments: m.attachments });
```

- [ ] **Step 4: Run typecheck and mobile tests**

Run:

```bash
cd apps/mobile-rn
npm run typecheck
npm test -- --runInBand
```

Expected: both pass.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile-rn/src/components/AttachmentList.tsx apps/mobile-rn/src/components/MessageBubble.tsx apps/mobile-rn/src/screens/ChatScreen.tsx
git commit -m "feat(mobile): 渲染聊天消息附件"
```

## Task 4: Approval Queue Visibility And Failure Feedback

**Files:**
- Modify: `apps/mobile-rn/src/state/events.tsx`
- Modify: `apps/mobile-rn/src/components/ApprovalSheet.tsx`

- [ ] **Step 1: Expose approval queue count**

Modify `EventsCtx` in `apps/mobile-rn/src/state/events.tsx`:

```ts
pendingApprovalCount: number;
```

Add state:

```ts
const [pendingApprovalCount, setPendingApprovalCount] = useState(0);
const syncActive = () => {
  setActive(queue.active());
  setPendingApprovalCount(queue.size());
};
```

Return it through the provider value.

- [ ] **Step 2: Show count and decision failures**

Modify `apps/mobile-rn/src/components/ApprovalSheet.tsx`:

```tsx
const { activeApproval, pendingApprovalCount, resolveApproval } = useEvents();
const [error, setError] = useState("");
```

Render the label as:

```tsx
<Label>{pendingApprovalCount > 1 ? `请求权限 · 1/${pendingApprovalCount}` : "请求权限"}</Label>
```

Change `decide` so it only resolves after a successful post:

```ts
setError("");
try {
  await api.api(...);
  resolveApproval(runId);
} catch (err) {
  setError(String((err as Error).message || "提交失败"));
}
```

Show `error` below the preview with danger color.

- [ ] **Step 3: Run verification**

Run:

```bash
cd apps/mobile-rn
npm run typecheck
npm test -- --runInBand
```

Expected: both pass.

- [ ] **Step 4: Commit**

```bash
git add apps/mobile-rn/src/state/events.tsx apps/mobile-rn/src/components/ApprovalSheet.tsx
git commit -m "feat(mobile): 展示审批队列和提交失败"
```

## Task 5: Phase 2A Verification

**Files:**
- Verify only.

- [ ] **Step 1: Run mobile tests**

```bash
cd apps/mobile-rn
npm test -- --runInBand
```

Expected: all mobile Jest tests pass.

- [ ] **Step 2: Run mobile typecheck**

```bash
cd apps/mobile-rn
npm run typecheck
```

Expected: no TypeScript errors.

- [ ] **Step 3: Run root structure check**

```bash
npm test -- tests/project-structure-check.test.js
```

Expected: project structure checks pass.

- [ ] **Step 4: Inspect final state**

```bash
git status --short
git log --oneline -15
```

Expected: working tree clean after commits; recent commits include Phase 2A work.

## Self-Review

Spec coverage:

- Chat message stream: attachments are normalized and rendered in mobile bubbles.
- Message actions: retry preserves attachments.
- Permission approval: visible queue count and decision failure feedback are added.
- Boundary rule: all work stays under `apps/mobile-rn` and uses Cloud URLs; no desktop/web imports.

Deferred to later Phase 2 plans:

- Native picker/upload from local device.
- Model/effort/permission selectors with mutation semantics.
- Full trace/tool block parity.
- Streaming run state cards.
- Push/local notifications.
