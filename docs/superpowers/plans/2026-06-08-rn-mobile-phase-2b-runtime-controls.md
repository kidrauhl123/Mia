# RN Mobile Phase 2B Runtime Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add desktop-equivalent Cloud bot runtime controls to the RN chat composer: model, effort, and permission mode.

**Architecture:** Keep Cloud protocol helpers in `apps/mobile-rn/src/logic/runtimeControls.ts`, expose Cloud model catalog and runtime save through typed query/mutation hooks, and render compact native controls in the chat composer only for bot conversations. The mobile app uses the same `/api/me/model-catalog` and `/api/me/bots/:id/runtime` endpoints as desktop/web; it does not import desktop/web implementation files.

**Tech Stack:** Expo SDK 56, React Native 0.85, React 19.2.3, React Navigation 7, TanStack Query 5, TypeScript 6, Jest 30.

---

## Scope

In scope:

- Add endpoint builders for `/api/me/model-catalog` and runtime save path.
- Add model catalog and runtime config types.
- Add runtime control adapter tests and implementation for bot ID, runtime kind, model entries, selected values, and config patching.
- Add React Query hook for model catalog and mutation hook for bot runtime config.
- Render model, effort, and permission controls above the chat input for bot conversations.
- Save control changes through Cloud and refresh runtime cache.

Out of scope:

- Desktop-local runtime secret editing.
- Full-screen model picker.
- Native attachment picker.
- Non-bot group-level runtime override.

## File Structure

- Modify `apps/mobile-rn/src/api/endpoints.ts`: add `modelCatalogPath()` and `botRuntimeSavePath()`.
- Modify `apps/mobile-rn/__tests__/endpoints.test.ts`: verify new paths.
- Modify `apps/mobile-rn/src/api/types.ts`: add runtime config and model catalog types.
- Create `apps/mobile-rn/src/logic/runtimeControls.ts`: normalize bot conversation control state and runtime config patches.
- Add `apps/mobile-rn/__tests__/runtimeControls.test.ts`: TDD coverage for adapter behavior.
- Modify `apps/mobile-rn/src/state/queries.ts`: add `useModelCatalog()` and `useSaveBotRuntimeConfig()`.
- Create `apps/mobile-rn/src/components/RuntimeControls.tsx`: compact segmented controls for model, effort, and permission.
- Modify `apps/mobile-rn/src/screens/ChatScreen.tsx`: find current conversation/bot, render runtime controls, and save changes.

## Task 1: Runtime Endpoints And Adapter

**Files:**
- Modify: `apps/mobile-rn/src/api/endpoints.ts`
- Modify: `apps/mobile-rn/__tests__/endpoints.test.ts`
- Modify: `apps/mobile-rn/src/api/types.ts`
- Create: `apps/mobile-rn/src/logic/runtimeControls.ts`
- Test: `apps/mobile-rn/__tests__/runtimeControls.test.ts`

- [ ] **Step 1: Extend endpoint tests**

Append to `apps/mobile-rn/__tests__/endpoints.test.ts`:

```ts
import { botRuntimeSavePath, modelCatalogPath } from "../src/api/endpoints";

test("builds runtime control endpoint paths", () => {
  expect(modelCatalogPath()).toBe("/api/me/model-catalog");
  expect(botRuntimeSavePath("bot.one")).toBe("/api/me/bots/bot.one/runtime");
});
```

- [ ] **Step 2: Add runtime adapter tests**

Create `apps/mobile-rn/__tests__/runtimeControls.test.ts`:

```ts
import {
  botIdForRuntimeControls,
  modelEntriesFromCatalog,
  patchForRuntimeField,
  runtimeControlState,
  runtimeKindForControls,
} from "../src/logic/runtimeControls";

test("detects bot id and runtime kind from bot conversation", () => {
  const conversation = { id: "botc_u_mia", type: "bot", bot_id: "mia", decorations: { runtimeKind: "cloud-hermes" } } as any;
  expect(botIdForRuntimeControls(conversation)).toBe("mia");
  expect(runtimeKindForControls(conversation)).toBe("cloud-hermes");
});

test("modelEntriesFromCatalog maps Cloud model catalog rows", () => {
  const entries = modelEntriesFromCatalog([
    { value: "mia-default", label: "Mia Default", model: "mia-default" },
    { modelName: "mia-pro", label: "Mia Pro", upstreamModel: "openai/gpt" },
  ] as any);
  expect(entries).toEqual([
    { id: "mia-default", value: "mia-default", model: "mia-default", label: "Mia Default" },
    { id: "mia-pro", value: "mia-pro", model: "openai/gpt", label: "Mia Pro" },
  ]);
});

test("patchForRuntimeField preserves desktop runtime semantics", () => {
  const entries = [{ value: "mia-default", model: "gpt-5.3", label: "GPT" }];
  expect(patchForRuntimeField("model", "mia-default", entries)).toEqual({ model: "gpt-5.3" });
  expect(patchForRuntimeField("effort", "high", entries)).toEqual({ effortLevel: "high" });
  expect(patchForRuntimeField("permission", "deny", entries)).toEqual({ permissionMode: "deny" });
});

test("runtimeControlState supplies selected values and defaults", () => {
  const state = runtimeControlState({
    binding: { config: { model: "gpt-5.3", effortLevel: "high", permissionMode: "deny" } } as any,
    modelEntries: [{ value: "mia-default", model: "gpt-5.3", label: "GPT" }],
  });
  expect(state.modelValue).toBe("mia-default");
  expect(state.effortValue).toBe("high");
  expect(state.permissionValue).toBe("deny");
});
```

- [ ] **Step 3: Verify tests fail**

Run:

```bash
cd apps/mobile-rn
npm test -- --runInBand __tests__/endpoints.test.ts __tests__/runtimeControls.test.ts
```

Expected: fail because new endpoint exports and `runtimeControls.ts` do not exist.

- [ ] **Step 4: Add endpoint helpers and types**

Add to `apps/mobile-rn/src/api/endpoints.ts`:

```ts
export function modelCatalogPath(): string {
  return "/api/me/model-catalog";
}

export function botRuntimeSavePath(botId: string): string {
  return `/api/me/bots/${encodeURIComponent(botId)}/runtime`;
}
```

Add to `apps/mobile-rn/src/api/types.ts`:

```ts
export interface RuntimeModelEntry {
  id: string;
  value: string;
  model: string;
  label: string;
  provider?: string;
  providerLabel?: string;
}

export interface PlatformModelRow {
  id?: string;
  value?: string;
  model?: string;
  modelName?: string;
  label?: string;
  name?: string;
  upstreamModel?: string;
  provider?: string;
  providerLabel?: string;
}

export interface BotRuntimeConfig {
  model?: string;
  effortLevel?: string;
  permissionMode?: string;
  modelEntries?: RuntimeModelEntry[];
}
```

Change `BotRuntimeBinding.config` to `BotRuntimeConfig`.

- [ ] **Step 5: Implement runtime adapter**

Create `apps/mobile-rn/src/logic/runtimeControls.ts`:

```ts
import type { BotRuntimeBinding, Conversation, PlatformModelRow, RuntimeModelEntry } from "../api/types";

export const EFFORT_OPTIONS = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];

export const PERMISSION_OPTIONS = [
  { value: "ask", label: "Ask" },
  { value: "yolo", label: "YOLO" },
  { value: "deny", label: "Deny" },
];

export function botIdForRuntimeControls(conversation?: Conversation | null): string {
  return String(conversation?.decorations?.botId || conversation?.bot_id || conversation?.botId || "").trim();
}

export function runtimeKindForControls(conversation?: Conversation | null): string {
  return String(conversation?.decorations?.runtimeKind || "cloud-hermes").trim() || "cloud-hermes";
}

export function modelEntriesFromCatalog(rows: PlatformModelRow[] = []): RuntimeModelEntry[] {
  const entries = rows.map((row) => {
    const value = String(row.value || row.id || row.modelName || row.model || "").trim();
    const model = String(row.model || row.upstreamModel || value).trim();
    const label = String(row.label || row.name || value || model).trim();
    if (!value && !model) return null;
    return {
      id: value || model,
      value: value || model,
      model: model || value,
      label: label || value || model,
      ...(row.provider ? { provider: String(row.provider) } : {}),
      ...(row.providerLabel ? { providerLabel: String(row.providerLabel) } : {}),
    };
  }).filter(Boolean) as RuntimeModelEntry[];
  return entries.length ? entries : [{ id: "mia-default", value: "mia-default", model: "mia-default", label: "Mia Default" }];
}

function modelEntryForValue(entries: RuntimeModelEntry[], value: string): RuntimeModelEntry | null {
  const wanted = String(value || "").trim();
  return entries.find((entry) => [entry.id, entry.value, entry.model].some((item) => String(item || "").trim() === wanted)) || null;
}

export function patchForRuntimeField(field: string, value: string, modelEntries: RuntimeModelEntry[] = []): Record<string, string> {
  if (field === "model") {
    const entry = modelEntryForValue(modelEntries, value);
    return { model: entry?.model || value };
  }
  if (field === "effort" || field === "effortLevel") return { effortLevel: value };
  if (field === "permission" || field === "permissionMode") return { permissionMode: value };
  return {};
}

export function runtimeControlState({
  binding,
  modelEntries,
}: {
  binding?: BotRuntimeBinding | null;
  modelEntries: RuntimeModelEntry[];
}) {
  const config = binding?.config || {};
  const currentModel = String(config.model || modelEntries[0]?.model || modelEntries[0]?.value || "mia-default");
  const modelEntry = modelEntryForValue(modelEntries, currentModel) || modelEntries[0];
  return {
    modelValue: modelEntry?.value || currentModel,
    effortValue: String(config.effortLevel || "medium"),
    permissionValue: String(config.permissionMode || "ask"),
  };
}
```

- [ ] **Step 6: Verify adapter tests pass**

Run:

```bash
cd apps/mobile-rn
npm test -- --runInBand __tests__/endpoints.test.ts __tests__/runtimeControls.test.ts
```

Expected: pass.

- [ ] **Step 7: Commit**

```bash
git add apps/mobile-rn/src/api/endpoints.ts apps/mobile-rn/src/api/types.ts apps/mobile-rn/src/logic/runtimeControls.ts apps/mobile-rn/__tests__/endpoints.test.ts apps/mobile-rn/__tests__/runtimeControls.test.ts
git commit -m "feat(mobile): 增加运行时控制协议适配"
```

## Task 2: Runtime Query And Save Hooks

**Files:**
- Modify: `apps/mobile-rn/src/state/queries.ts`

- [ ] **Step 1: Add model catalog and save mutation hooks**

Modify `apps/mobile-rn/src/state/queries.ts`:

```ts
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
```

Import `botRuntimeSavePath` and `modelCatalogPath`, plus `BotRuntimeConfig`, `PlatformModelRow`.

Add:

```ts
export function useModelCatalog() {
  const api = useApi();
  return useQuery<PlatformModelRow[]>({
    queryKey: ["model-catalog"],
    queryFn: () => api.api(modelCatalogPath()).then((d) => d.models || []),
  });
}

export function useSaveBotRuntimeConfig() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ botId, runtimeKind, config }: { botId: string; runtimeKind: string; config: BotRuntimeConfig }) =>
      api.api(botRuntimeSavePath(botId), { method: "PUT", body: { runtimeKind, enabled: true, config } }).then((d) => d.binding || null),
    onSuccess: (binding, vars) => {
      qc.setQueryData(["bot-runtime", vars.botId, vars.runtimeKind], binding);
    },
  });
}
```

- [ ] **Step 2: Run verification**

```bash
cd apps/mobile-rn
npm run typecheck
npm test -- --runInBand
```

Expected: both pass.

- [ ] **Step 3: Commit**

```bash
git add apps/mobile-rn/src/state/queries.ts
git commit -m "feat(mobile): 接入模型目录和运行时保存"
```

## Task 3: Runtime Controls UI In Chat Composer

**Files:**
- Create: `apps/mobile-rn/src/components/RuntimeControls.tsx`
- Modify: `apps/mobile-rn/src/screens/ChatScreen.tsx`

- [ ] **Step 1: Create compact runtime controls component**

Create `apps/mobile-rn/src/components/RuntimeControls.tsx` using horizontal `ScrollView`/`Pressable` segmented rows for model, effort, and permission values. It receives selected values, entries, saving state, and `onChange(field, value)`.

- [ ] **Step 2: Wire ChatScreen to current bot conversation**

Modify `ChatScreen` to load `useConversations`, `useBots`, `useModelCatalog`, `useBotRuntime`, and `useSaveBotRuntimeConfig`. Find the active conversation, derive `botId` and `runtimeKind`, compute model entries and selected state, and render `RuntimeControls` above the input only when `botId` exists.

- [ ] **Step 3: Save control changes through Cloud**

In `ChatScreen`, implement:

```ts
const saveRuntimeField = async (field: "model" | "effort" | "permission", value: string) => {
  if (!botId) return;
  const patch = patchForRuntimeField(field, value, modelEntries);
  const nextConfig = { ...(runtime.data?.config || {}), ...patch };
  await saveRuntime.mutateAsync({ botId, runtimeKind, config: nextConfig });
};
```

- [ ] **Step 4: Run verification**

```bash
cd apps/mobile-rn
npm run typecheck
npm test -- --runInBand
```

Expected: both pass.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile-rn/src/components/RuntimeControls.tsx apps/mobile-rn/src/screens/ChatScreen.tsx
git commit -m "feat(mobile): 在聊天 composer 展示运行时控制"
```

## Task 4: Final Verification

**Files:**
- Verify only.

- [ ] **Step 1: Run mobile tests**

```bash
cd apps/mobile-rn
npm test -- --runInBand
```

- [ ] **Step 2: Run mobile typecheck**

```bash
cd apps/mobile-rn
npm run typecheck
```

- [ ] **Step 3: Run root structure check**

```bash
npm test -- tests/project-structure-check.test.js
```

- [ ] **Step 4: Inspect state**

```bash
git status --short
git log --oneline -18
```

Expected: working tree clean after commits; recent commits include runtime control work.

## Self-Review

Spec coverage:

- Composer parity: model, effort, and permission controls are visible in bot chats.
- Model selection: uses Cloud model catalog and saves through bot runtime binding.
- Permission mode: mobile can view/change the same Cloud bot permission mode as desktop/web.
- Boundary rule: RN uses mobile adapters and Cloud APIs, not desktop/web imports.

Deferred:

- Full-screen picker for long model catalogs.
- Desktop-local read-only engine controls.
- Sending per-message one-off overrides.
- Native visual QA screenshots.
