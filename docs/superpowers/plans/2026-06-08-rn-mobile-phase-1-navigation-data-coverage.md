# RN Mobile Phase 1 Navigation Data Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first RN parity slice: every Mia 0.1.3 logged-in desktop surface has a reachable native mobile destination and read-only Cloud-backed data where an endpoint already exists.

**Architecture:** Keep `apps/mobile-rn` as the only mobile app. Add typed API shape and endpoint helpers first, then add React Query hooks, then add native navigation stacks/screens that consume those hooks. This phase deliberately avoids write-side management beyond existing login/logout/message behavior; later plans handle chat parity, Bot edits, skills assignment, settings mutation, attachments, and notifications.

**Tech Stack:** Expo SDK 56, React Native 0.85, React 19.2.3, React Navigation 7, TanStack Query 5, TypeScript 6, Jest 30.

---

## Scope

This plan implements Phase 1 from `docs/superpowers/specs/2026-06-08-rn-mobile-desktop-parity-design.md`.

In scope:

- Native destinations for Messages, Contacts, Agents, Skills, and Settings.
- Read-only hooks for settings, skills, bridge devices, bridge runs, incoming friend requests, Bot detail, and Bot runtime binding.
- Basic detail screens for Bot contacts and group conversations.
- Loading, empty, and error affordances for the new read-only screens.

Out of scope for this plan:

- Editing Bots, skills, settings, groups, friend requests, or runtime bindings.
- Model/effort/permission composer controls.
- Attachment picking/upload.
- Push notifications.
- Full desktop-quality visual polish.

## File Structure

- Modify `apps/mobile-rn/src/api/types.ts`: add Cloud response types needed by read-only parity surfaces.
- Create `apps/mobile-rn/src/api/endpoints.ts`: centralize endpoint builders so query hooks and tests do not duplicate route strings.
- Add `apps/mobile-rn/__tests__/endpoints.test.ts`: verify endpoint builders.
- Modify `apps/mobile-rn/src/state/queries.ts`: add React Query hooks for the new read-only surfaces.
- Modify `apps/mobile-rn/src/navigation/types.ts`: define route param lists for Messages, Contacts, Agents, Skills, and Settings.
- Modify `apps/mobile-rn/src/navigation/Tabs.tsx`: add stack navigators and tabs for Agents, Skills, and Settings; wire Contacts detail routes.
- Modify `apps/mobile-rn/src/navigation/AnimatedTabBar.tsx`: add glyph/label support for new tabs.
- Create `apps/mobile-rn/src/screens/AgentsScreen.tsx`: read-only desktop bridge/device/run overview.
- Create `apps/mobile-rn/src/screens/SkillsScreen.tsx`: read-only skill library list.
- Create `apps/mobile-rn/src/screens/SettingsScreen.tsx`: read-only account/settings/provider/status overview.
- Create `apps/mobile-rn/src/screens/BotDetailScreen.tsx`: read-only Bot profile and runtime summary.
- Create `apps/mobile-rn/src/screens/GroupDetailScreen.tsx`: read-only group profile and member list.
- Modify `apps/mobile-rn/src/screens/ContactsScreen.tsx`: navigate to Bot or group detail where possible.
- Create `apps/mobile-rn/src/ui/StateBlock.tsx`: shared loading/empty/error block for new screens.

## Task 1: Endpoint Builders And API Types

**Files:**
- Create: `apps/mobile-rn/src/api/endpoints.ts`
- Modify: `apps/mobile-rn/src/api/types.ts`
- Test: `apps/mobile-rn/__tests__/endpoints.test.ts`

- [ ] **Step 1: Write endpoint tests**

Create `apps/mobile-rn/__tests__/endpoints.test.ts`:

```ts
import {
  botDetailPath,
  botRuntimePath,
  bridgeDevicesPath,
  bridgeRunsPath,
  friendRequestsPath,
  settingsPath,
  skillDetailPath,
  skillsPath,
} from "../src/api/endpoints";

test("builds account and bridge endpoint paths", () => {
  expect(settingsPath()).toBe("/api/me/settings");
  expect(bridgeDevicesPath()).toBe("/api/bridge/devices");
  expect(bridgeRunsPath()).toBe("/api/bridge/runs");
});

test("builds social endpoint paths", () => {
  expect(friendRequestsPath("incoming")).toBe("/api/social/friend-requests?direction=incoming");
  expect(friendRequestsPath("outgoing")).toBe("/api/social/friend-requests?direction=outgoing");
});

test("builds bot endpoint paths with escaping", () => {
  expect(botDetailPath("bot.one")).toBe("/api/me/bots/bot.one");
  expect(botRuntimePath("bot one", "cloud-hermes")).toBe("/api/me/bots/bot%20one/runtime?kind=cloud-hermes");
});

test("builds skill endpoint paths with escaping and optional filters", () => {
  expect(skillsPath({ q: "code review", category: "dev tools", limit: 25 })).toBe(
    "/api/skills?q=code+review&category=dev+tools&limit=25"
  );
  expect(skillsPath()).toBe("/api/skills");
  expect(skillDetailPath("hermes.code-review")).toBe("/api/skills/hermes.code-review");
});
```

- [ ] **Step 2: Run endpoint tests and verify failure**

Run:

```bash
cd apps/mobile-rn
npm test -- --runInBand __tests__/endpoints.test.ts
```

Expected: fail because `src/api/endpoints.ts` does not exist.

- [ ] **Step 3: Add endpoint helpers**

Create `apps/mobile-rn/src/api/endpoints.ts`:

```ts
export type FriendRequestDirection = "incoming" | "outgoing";

function withQuery(path: string, params: Record<string, string | number | undefined>): string {
  const q = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === "") return;
    q.set(key, String(value));
  });
  const text = q.toString();
  return text ? `${path}?${text}` : path;
}

export function settingsPath(): string {
  return "/api/me/settings";
}

export function bridgeDevicesPath(): string {
  return "/api/bridge/devices";
}

export function bridgeRunsPath(): string {
  return "/api/bridge/runs";
}

export function friendRequestsPath(direction: FriendRequestDirection): string {
  return withQuery("/api/social/friend-requests", { direction });
}

export function botDetailPath(botId: string): string {
  return `/api/me/bots/${encodeURIComponent(botId)}`;
}

export function botRuntimePath(botId: string, kind = "cloud-hermes"): string {
  return withQuery(`/api/me/bots/${encodeURIComponent(botId)}/runtime`, { kind });
}

export function skillsPath(filters: { q?: string; category?: string; limit?: number } = {}): string {
  return withQuery("/api/skills", filters);
}

export function skillDetailPath(skillId: string): string {
  return `/api/skills/${encodeURIComponent(skillId)}`;
}
```

- [ ] **Step 4: Add API types**

Append these interfaces to `apps/mobile-rn/src/api/types.ts`:

```ts
export interface UserSettings {
  version?: number;
  pins?: string[];
  readMarks?: Record<string, number>;
  appearance?: Record<string, unknown>;
}

export interface FriendRequest {
  id: string;
  senderId?: string;
  recipientId?: string;
  sender?: Friend;
  recipient?: Friend;
  status?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface BridgeDevice {
  id?: string;
  deviceId?: string;
  name?: string;
  platform?: string;
  status?: string;
  lastSeenAt?: string;
  connected?: boolean;
}

export interface BridgeRun {
  id?: string;
  runId?: string;
  conversationId?: string;
  status?: string;
  command?: string;
  createdAt?: string;
  updatedAt?: string;
  error?: string;
}

export interface BotRuntimeBinding {
  userId?: string;
  botId?: string;
  runtimeKind?: string;
  enabled?: boolean;
  config?: Record<string, unknown>;
}

export interface SkillSummary {
  id: string;
  name?: string;
  title?: string;
  category?: string;
  description?: string;
  ownerLabel?: string;
  installs?: number;
  version?: {
    version?: string;
    checksum?: string;
    entryPath?: string;
  } | null;
}

export interface SkillCategory {
  id?: string;
  name?: string;
  count?: number;
}
```

- [ ] **Step 5: Verify endpoint tests pass**

Run:

```bash
cd apps/mobile-rn
npm test -- --runInBand __tests__/endpoints.test.ts
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add apps/mobile-rn/src/api/endpoints.ts apps/mobile-rn/src/api/types.ts apps/mobile-rn/__tests__/endpoints.test.ts
git commit -m "feat(mobile): 增加桌面复刻数据端点定义"
```

## Task 2: Read-Only Query Hooks

**Files:**
- Modify: `apps/mobile-rn/src/state/queries.ts`

- [ ] **Step 1: Extend imports**

Modify the imports at the top of `apps/mobile-rn/src/state/queries.ts`:

```ts
import { useQuery } from "@tanstack/react-query";
import { useApi } from "./clientProvider";
import { useAuth } from "./auth";
import { normalizeServerRow } from "../logic/normalizeMessage";
import {
  botDetailPath,
  botRuntimePath,
  bridgeDevicesPath,
  bridgeRunsPath,
  friendRequestsPath,
  settingsPath,
  skillsPath,
} from "../api/endpoints";
import type {
  Bot,
  BotRuntimeBinding,
  BridgeDevice,
  BridgeRun,
  ChatMessage,
  Conversation,
  Friend,
  FriendRequest,
  MessageRow,
  Member,
  SkillCategory,
  SkillSummary,
  UserSettings,
} from "../api/types";
```

- [ ] **Step 2: Add query hooks**

Append these hooks to `apps/mobile-rn/src/state/queries.ts`:

```ts
export function useUserSettings() {
  const api = useApi();
  return useQuery<UserSettings>({
    queryKey: ["settings"],
    queryFn: () => api.api(settingsPath()).then((d) => d.settings || {}),
  });
}

export function useBridgeDevices() {
  const api = useApi();
  return useQuery<BridgeDevice[]>({
    queryKey: ["bridge-devices"],
    queryFn: () => api.api(bridgeDevicesPath()).then((d) => d.devices || []),
  });
}

export function useBridgeRuns() {
  const api = useApi();
  return useQuery<BridgeRun[]>({
    queryKey: ["bridge-runs"],
    queryFn: () => api.api(bridgeRunsPath()).then((d) => d.runs || []),
  });
}

export function useFriendRequests(direction: "incoming" | "outgoing" = "incoming") {
  const api = useApi();
  return useQuery<FriendRequest[]>({
    queryKey: ["friend-requests", direction],
    queryFn: () => api.api(friendRequestsPath(direction)).then((d) => d.requests || []),
  });
}

export function useBotDetail(botId: string | undefined) {
  const api = useApi();
  return useQuery<Bot | null>({
    queryKey: ["bot-detail", botId],
    enabled: !!botId,
    queryFn: () => api.api(botDetailPath(botId || "")).then((d) => d.bot || null),
  });
}

export function useBotRuntime(botId: string | undefined, kind = "cloud-hermes") {
  const api = useApi();
  return useQuery<BotRuntimeBinding | null>({
    queryKey: ["bot-runtime", botId, kind],
    enabled: !!botId,
    queryFn: () => api.api(botRuntimePath(botId || "", kind)).then((d) => d.binding || null),
  });
}

export function useSkills(filters: { q?: string; category?: string; limit?: number } = {}) {
  const api = useApi();
  const q = filters.q || "";
  const category = filters.category || "";
  const limit = filters.limit || 80;
  return useQuery<{ skills: SkillSummary[]; categories: SkillCategory[] }>({
    queryKey: ["skills", q, category, limit],
    queryFn: () => api.api(skillsPath({ q, category, limit })).then((d) => ({
      skills: d.skills || [],
      categories: d.categories || [],
    })),
  });
}
```

- [ ] **Step 3: Run mobile typecheck**

Run:

```bash
cd apps/mobile-rn
npm run typecheck
```

Expected: pass. If TypeScript reports an existing unrelated error, record the exact error before changing scope.

- [ ] **Step 4: Run mobile tests**

Run:

```bash
cd apps/mobile-rn
npm test -- --runInBand
```

Expected: pass all mobile Jest tests.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile-rn/src/state/queries.ts
git commit -m "feat(mobile): 接入桌面复刻只读数据查询"
```

## Task 3: Navigation Surface Expansion

**Files:**
- Modify: `apps/mobile-rn/src/navigation/types.ts`
- Modify: `apps/mobile-rn/src/navigation/Tabs.tsx`
- Modify: `apps/mobile-rn/src/navigation/AnimatedTabBar.tsx`
- Create: `apps/mobile-rn/src/screens/AgentsScreen.tsx`
- Create: `apps/mobile-rn/src/screens/SkillsScreen.tsx`
- Create: `apps/mobile-rn/src/screens/SettingsScreen.tsx`
- Create: `apps/mobile-rn/src/screens/BotDetailScreen.tsx`
- Create: `apps/mobile-rn/src/screens/GroupDetailScreen.tsx`

- [ ] **Step 1: Add route types**

Replace `apps/mobile-rn/src/navigation/types.ts` with:

```ts
export type MessagesStackParamList = {
  Conversations: undefined;
  Chat: { conversationId: string; title: string };
  GroupDetail: { conversationId: string; title: string };
};

export type ContactsStackParamList = {
  ContactsHome: undefined;
  BotDetail: { botId: string; title: string };
};

export type AgentsStackParamList = {
  AgentsHome: undefined;
};

export type SkillsStackParamList = {
  SkillsHome: undefined;
};

export type SettingsStackParamList = {
  SettingsHome: undefined;
};
```

- [ ] **Step 2: Create temporary destination screens**

Create `apps/mobile-rn/src/screens/AgentsScreen.tsx`:

```tsx
import { View } from "react-native";
import { Brand, Sub } from "../ui/Text";
import { color, space } from "../theme";

export default function AgentsScreen() {
  return (
    <View style={{ flex: 1, backgroundColor: color.bg, padding: space.lg, gap: space.sm }}>
      <Brand>Agents</Brand>
      <Sub>桌面 Bridge、运行中任务、权限等待和运行历史会在这里汇总。</Sub>
    </View>
  );
}
```

Create `apps/mobile-rn/src/screens/SkillsScreen.tsx`:

```tsx
import { View } from "react-native";
import { Brand, Sub } from "../ui/Text";
import { color, space } from "../theme";

export default function SkillsScreen() {
  return (
    <View style={{ flex: 1, backgroundColor: color.bg, padding: space.lg, gap: space.sm }}>
      <Brand>Skills</Brand>
      <Sub>技能库、技能详情和启用到 Bot 的入口会在这里。</Sub>
    </View>
  );
}
```

Create `apps/mobile-rn/src/screens/SettingsScreen.tsx`:

```tsx
import { View } from "react-native";
import { Brand, Sub } from "../ui/Text";
import { color, space } from "../theme";

export default function SettingsScreen() {
  return (
    <View style={{ flex: 1, backgroundColor: color.bg, padding: space.lg, gap: space.sm }}>
      <Brand>Settings</Brand>
      <Sub>账号、同步、外观、模型、权限和 Bridge 状态会在这里。</Sub>
    </View>
  );
}
```

Create `apps/mobile-rn/src/screens/BotDetailScreen.tsx`:

```tsx
import { View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { Brand, Sub } from "../ui/Text";
import { color, space } from "../theme";
import type { ContactsStackParamList } from "../navigation/types";

type Props = NativeStackScreenProps<ContactsStackParamList, "BotDetail">;

export default function BotDetailScreen({ route }: Props) {
  return (
    <View style={{ flex: 1, backgroundColor: color.bg, padding: space.lg, gap: space.sm }}>
      <Brand>{route.params.title}</Brand>
      <Sub>{route.params.botId}</Sub>
    </View>
  );
}
```

Create `apps/mobile-rn/src/screens/GroupDetailScreen.tsx`:

```tsx
import { View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { Brand, Sub } from "../ui/Text";
import { color, space } from "../theme";
import type { MessagesStackParamList } from "../navigation/types";

type Props = NativeStackScreenProps<MessagesStackParamList, "GroupDetail">;

export default function GroupDetailScreen({ route }: Props) {
  return (
    <View style={{ flex: 1, backgroundColor: color.bg, padding: space.lg, gap: space.sm }}>
      <Brand>{route.params.title}</Brand>
      <Sub>{route.params.conversationId}</Sub>
    </View>
  );
}
```

- [ ] **Step 3: Expand tab labels and glyphs**

Modify `apps/mobile-rn/src/navigation/AnimatedTabBar.tsx` constants:

```ts
const GLYPHS: Record<string, string> = {
  Messages: "✦",
  Contacts: "◇",
  Agents: "▣",
  Skills: "✚",
  Settings: "●",
};
const LABELS: Record<string, string> = {
  Messages: "消息",
  Contacts: "联系人",
  Agents: "运行",
  Skills: "技能",
  Settings: "设置",
};
```

- [ ] **Step 4: Replace tab navigator wiring**

Replace `apps/mobile-rn/src/navigation/Tabs.tsx` with:

```tsx
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import ConversationListScreen from "../screens/ConversationListScreen";
import ChatScreen from "../screens/ChatScreen";
import ContactsScreen from "../screens/ContactsScreen";
import AgentsScreen from "../screens/AgentsScreen";
import SkillsScreen from "../screens/SkillsScreen";
import SettingsScreen from "../screens/SettingsScreen";
import BotDetailScreen from "../screens/BotDetailScreen";
import GroupDetailScreen from "../screens/GroupDetailScreen";
import AnimatedTabBar from "./AnimatedTabBar";
import { color } from "../theme";
import type {
  AgentsStackParamList,
  ContactsStackParamList,
  MessagesStackParamList,
  SettingsStackParamList,
  SkillsStackParamList,
} from "./types";

const MessagesStackNav = createNativeStackNavigator<MessagesStackParamList>();
const ContactsStackNav = createNativeStackNavigator<ContactsStackParamList>();
const AgentsStackNav = createNativeStackNavigator<AgentsStackParamList>();
const SkillsStackNav = createNativeStackNavigator<SkillsStackParamList>();
const SettingsStackNav = createNativeStackNavigator<SettingsStackParamList>();
const Tab = createBottomTabNavigator();

const headerOptions = {
  headerStyle: { backgroundColor: color.bg },
  headerShadowVisible: false,
  headerTintColor: color.accent,
  headerTitleStyle: { fontSize: 17, fontWeight: "700" as const, color: color.ink },
  headerTitleAlign: "center" as const,
  contentStyle: { backgroundColor: color.bg },
};

function MessagesStack() {
  return (
    <MessagesStackNav.Navigator screenOptions={headerOptions}>
      <MessagesStackNav.Screen name="Conversations" component={ConversationListScreen} options={{ title: "消息" }} />
      <MessagesStackNav.Screen name="Chat" component={ChatScreen} options={({ route }) => ({ title: route.params?.title || "" })} />
      <MessagesStackNav.Screen name="GroupDetail" component={GroupDetailScreen} options={({ route }) => ({ title: route.params?.title || "群聊" })} />
    </MessagesStackNav.Navigator>
  );
}

function ContactsStack() {
  return (
    <ContactsStackNav.Navigator screenOptions={headerOptions}>
      <ContactsStackNav.Screen name="ContactsHome" component={ContactsScreen} options={{ title: "联系人" }} />
      <ContactsStackNav.Screen name="BotDetail" component={BotDetailScreen} options={({ route }) => ({ title: route.params?.title || "Bot" })} />
    </ContactsStackNav.Navigator>
  );
}

function AgentsStack() {
  return (
    <AgentsStackNav.Navigator screenOptions={headerOptions}>
      <AgentsStackNav.Screen name="AgentsHome" component={AgentsScreen} options={{ title: "运行" }} />
    </AgentsStackNav.Navigator>
  );
}

function SkillsStack() {
  return (
    <SkillsStackNav.Navigator screenOptions={headerOptions}>
      <SkillsStackNav.Screen name="SkillsHome" component={SkillsScreen} options={{ title: "技能" }} />
    </SkillsStackNav.Navigator>
  );
}

function SettingsStack() {
  return (
    <SettingsStackNav.Navigator screenOptions={headerOptions}>
      <SettingsStackNav.Screen name="SettingsHome" component={SettingsScreen} options={{ title: "设置" }} />
    </SettingsStackNav.Navigator>
  );
}

export default function Tabs() {
  return (
    <Tab.Navigator screenOptions={headerOptions} tabBar={(props) => <AnimatedTabBar {...props} />}>
      <Tab.Screen name="Messages" component={MessagesStack} options={{ headerShown: false, title: "消息" }} />
      <Tab.Screen name="Contacts" component={ContactsStack} options={{ headerShown: false, title: "联系人" }} />
      <Tab.Screen name="Agents" component={AgentsStack} options={{ headerShown: false, title: "运行" }} />
      <Tab.Screen name="Skills" component={SkillsStack} options={{ headerShown: false, title: "技能" }} />
      <Tab.Screen name="Settings" component={SettingsStack} options={{ headerShown: false, title: "设置" }} />
    </Tab.Navigator>
  );
}
```

- [ ] **Step 5: Run typecheck**

Run:

```bash
cd apps/mobile-rn
npm run typecheck
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add apps/mobile-rn/src/navigation apps/mobile-rn/src/screens/AgentsScreen.tsx apps/mobile-rn/src/screens/SkillsScreen.tsx apps/mobile-rn/src/screens/SettingsScreen.tsx apps/mobile-rn/src/screens/BotDetailScreen.tsx apps/mobile-rn/src/screens/GroupDetailScreen.tsx
git commit -m "feat(mobile): 建立桌面复刻导航入口"
```

## Task 4: Shared State Block UI

**Files:**
- Create: `apps/mobile-rn/src/ui/StateBlock.tsx`

- [ ] **Step 1: Create reusable state block**

Create `apps/mobile-rn/src/ui/StateBlock.tsx`:

```tsx
import { StyleSheet, View } from "react-native";
import { Body, Label } from "./Text";
import { color, space } from "../theme";

export default function StateBlock({
  title,
  detail,
}: {
  title: string;
  detail?: string;
}) {
  return (
    <View style={styles.wrap}>
      <Label style={styles.title}>{title}</Label>
      {detail ? <Body style={styles.detail}>{detail}</Body> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: "center",
    justifyContent: "center",
    padding: space.xl,
    gap: space.sm,
  },
  title: {
    color: color.inkMuted,
    textAlign: "center",
  },
  detail: {
    color: color.inkFaint,
    textAlign: "center",
  },
});
```

- [ ] **Step 2: Run typecheck**

Run:

```bash
cd apps/mobile-rn
npm run typecheck
```

Expected: pass.

- [ ] **Step 3: Commit**

```bash
git add apps/mobile-rn/src/ui/StateBlock.tsx
git commit -m "feat(mobile): 增加只读页面状态组件"
```

## Task 5: Agents Screen Read-Only Data

**Files:**
- Modify: `apps/mobile-rn/src/screens/AgentsScreen.tsx`

- [ ] **Step 1: Replace placeholder with bridge/device/run overview**

Replace `apps/mobile-rn/src/screens/AgentsScreen.tsx` with:

```tsx
import { FlatList, StyleSheet, View } from "react-native";
import { useBridgeDevices, useBridgeRuns } from "../state/queries";
import StateBlock from "../ui/StateBlock";
import { BodyStrong, Label, Sub } from "../ui/Text";
import { color, space, hairlineWidth } from "../theme";

function statusText(value: unknown): string {
  if (value === true) return "online";
  if (value === false) return "offline";
  return String(value || "unknown");
}

export default function AgentsScreen() {
  const devices = useBridgeDevices();
  const runs = useBridgeRuns();
  const loading = devices.isLoading || runs.isLoading;
  const error = devices.error || runs.error;
  const items = [
    ...(devices.data || []).map((d, index) => ({
      key: `device:${d.id || d.deviceId || index}`,
      title: d.name || d.deviceId || d.id || "Desktop device",
      subtitle: `${d.platform || "desktop"} · ${statusText(d.connected ?? d.status)}`,
      meta: d.lastSeenAt || "",
    })),
    ...(runs.data || []).map((r, index) => ({
      key: `run:${r.id || r.runId || index}`,
      title: r.command || r.runId || r.id || "Bridge run",
      subtitle: statusText(r.status),
      meta: r.updatedAt || r.createdAt || "",
    })),
  ];

  if (loading) return <StateBlock title="加载运行状态…" />;
  if (error) return <StateBlock title="运行状态加载失败" detail={String((error as Error).message || error)} />;
  if (!items.length) return <StateBlock title="暂无桌面运行状态" detail="登录同一账号的桌面端上线后会显示在这里。" />;

  return (
    <FlatList
      style={styles.root}
      data={items}
      keyExtractor={(item) => item.key}
      renderItem={({ item }) => (
        <View style={styles.row}>
          <View style={styles.dot} />
          <View style={styles.text}>
            <BodyStrong numberOfLines={1}>{item.title}</BodyStrong>
            <Sub numberOfLines={1}>{item.subtitle}</Sub>
          </View>
          {item.meta ? <Label style={styles.meta}>{item.meta}</Label> : null}
        </View>
      )}
    />
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.bg },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderBottomWidth: hairlineWidth,
    borderBottomColor: color.line,
  },
  dot: { width: 10, height: 10, borderRadius: 5, backgroundColor: color.accent },
  text: { flex: 1, minWidth: 0, gap: 3 },
  meta: { maxWidth: 120, textAlign: "right" },
});
```

- [ ] **Step 2: Run typecheck**

Run:

```bash
cd apps/mobile-rn
npm run typecheck
```

Expected: pass.

- [ ] **Step 3: Commit**

```bash
git add apps/mobile-rn/src/screens/AgentsScreen.tsx
git commit -m "feat(mobile): 展示桌面运行和 Bridge 状态"
```

## Task 6: Skills Screen Read-Only Data

**Files:**
- Modify: `apps/mobile-rn/src/screens/SkillsScreen.tsx`

- [ ] **Step 1: Replace placeholder with skill list**

Replace `apps/mobile-rn/src/screens/SkillsScreen.tsx` with:

```tsx
import { FlatList, StyleSheet, View } from "react-native";
import { useSkills } from "../state/queries";
import StateBlock from "../ui/StateBlock";
import { BodyStrong, Label, Sub } from "../ui/Text";
import { color, space, hairlineWidth } from "../theme";

function titleFor(skill: { name?: string; title?: string; id: string }): string {
  return skill.title || skill.name || skill.id;
}

export default function SkillsScreen() {
  const { data, isLoading, error } = useSkills({ limit: 80 });
  const skills = data?.skills || [];

  if (isLoading) return <StateBlock title="加载技能库…" />;
  if (error) return <StateBlock title="技能库加载失败" detail={String((error as Error).message || error)} />;
  if (!skills.length) return <StateBlock title="暂无技能" detail="Cloud 技能库同步后会显示在这里。" />;

  return (
    <FlatList
      style={styles.root}
      data={skills}
      keyExtractor={(item) => item.id}
      renderItem={({ item }) => (
        <View style={styles.row}>
          <View style={styles.mark}>
            <Label style={styles.markText}>{titleFor(item).slice(0, 2)}</Label>
          </View>
          <View style={styles.text}>
            <BodyStrong numberOfLines={1}>{titleFor(item)}</BodyStrong>
            <Sub numberOfLines={2}>{item.description || item.category || item.id}</Sub>
          </View>
        </View>
      )}
    />
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.bg },
  row: {
    flexDirection: "row",
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderBottomWidth: hairlineWidth,
    borderBottomColor: color.line,
  },
  mark: {
    width: 40,
    height: 40,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: color.surfaceMuted,
  },
  markText: { color: color.accent },
  text: { flex: 1, minWidth: 0, gap: 3 },
});
```

- [ ] **Step 2: Run typecheck**

Run:

```bash
cd apps/mobile-rn
npm run typecheck
```

Expected: pass.

- [ ] **Step 3: Commit**

```bash
git add apps/mobile-rn/src/screens/SkillsScreen.tsx
git commit -m "feat(mobile): 展示只读技能库"
```

## Task 7: Settings Screen Read-Only Data

**Files:**
- Modify: `apps/mobile-rn/src/screens/SettingsScreen.tsx`

- [ ] **Step 1: Replace placeholder with account and settings overview**

Replace `apps/mobile-rn/src/screens/SettingsScreen.tsx` with:

```tsx
import { ScrollView, StyleSheet, View } from "react-native";
import { useAuth } from "../state/auth";
import { useBridgeDevices, useMe, useUserSettings } from "../state/queries";
import StateBlock from "../ui/StateBlock";
import { Body, BodyStrong, Label, Sub } from "../ui/Text";
import { color, space, hairlineWidth } from "../theme";

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Label>{label}</Label>
      <Body style={styles.value}>{value}</Body>
    </View>
  );
}

export default function SettingsScreen() {
  const { session } = useAuth();
  const me = useMe();
  const settings = useUserSettings();
  const devices = useBridgeDevices();
  const loading = me.isLoading || settings.isLoading;
  const error = me.error || settings.error;
  const appearance = settings.data?.appearance || {};

  if (loading) return <StateBlock title="加载设置…" />;
  if (error) return <StateBlock title="设置加载失败" detail={String((error as Error).message || error)} />;

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content}>
      <View style={styles.section}>
        <BodyStrong>账号</BodyStrong>
        <Sub>{session?.apiBase || ""}</Sub>
        <Row label="用户名" value={me.data?.username || session?.user?.username || ""} />
        <Row label="用户 ID" value={me.data?.id || session?.user?.id || ""} />
      </View>
      <View style={styles.section}>
        <BodyStrong>同步</BodyStrong>
        <Row label="设置版本" value={String(settings.data?.version || 0)} />
        <Row label="置顶会话" value={String(settings.data?.pins?.length || 0)} />
        <Row label="桌面设备" value={String(devices.data?.length || 0)} />
      </View>
      <View style={styles.section}>
        <BodyStrong>外观</BodyStrong>
        <Row label="主题" value={String(appearance.theme || "light")} />
        <Row label="列表样式" value={String(appearance.listStyle || "default")} />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.bg },
  content: { padding: space.lg, gap: space.lg },
  section: {
    gap: space.sm,
    paddingBottom: space.lg,
    borderBottomWidth: hairlineWidth,
    borderBottomColor: color.line,
  },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: space.md,
  },
  value: {
    flex: 1,
    textAlign: "right",
    color: color.inkMuted,
  },
});
```

- [ ] **Step 2: Run typecheck**

Run:

```bash
cd apps/mobile-rn
npm run typecheck
```

Expected: pass.

- [ ] **Step 3: Commit**

```bash
git add apps/mobile-rn/src/screens/SettingsScreen.tsx
git commit -m "feat(mobile): 展示账号同步和设置概览"
```

## Task 8: Bot And Group Detail Read-Only Screens

**Files:**
- Modify: `apps/mobile-rn/src/screens/BotDetailScreen.tsx`
- Modify: `apps/mobile-rn/src/screens/GroupDetailScreen.tsx`

- [ ] **Step 1: Replace Bot detail placeholder**

Replace `apps/mobile-rn/src/screens/BotDetailScreen.tsx` with:

```tsx
import { ScrollView, StyleSheet, View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import Avatar from "../components/Avatar";
import { resolveAvatar } from "../logic/conversationList";
import { useBotDetail, useBotRuntime } from "../state/queries";
import StateBlock from "../ui/StateBlock";
import { Body, BodyStrong, Label, Sub } from "../ui/Text";
import { color, space, hairlineWidth } from "../theme";
import type { ContactsStackParamList } from "../navigation/types";

type Props = NativeStackScreenProps<ContactsStackParamList, "BotDetail">;

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Label>{label}</Label>
      <Body style={styles.value}>{value}</Body>
    </View>
  );
}

export default function BotDetailScreen({ route }: Props) {
  const bot = useBotDetail(route.params.botId);
  const runtime = useBotRuntime(route.params.botId);
  const data = bot.data;
  const title = data?.displayName || data?.display_name || data?.name || route.params.title;
  const avatar = resolveAvatar(route.params.botId, title, data?.avatarImage || data?.avatar_image || "", data?.avatarCrop || data?.avatar_crop || null);

  if (bot.isLoading) return <StateBlock title="加载 Bot…" />;
  if (bot.error) return <StateBlock title="Bot 加载失败" detail={String((bot.error as Error).message || bot.error)} />;
  if (!data) return <StateBlock title="Bot 不存在" detail={route.params.botId} />;

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content}>
      <View style={styles.head}>
        <Avatar title={title} avatar={avatar} />
        <View style={styles.headText}>
          <BodyStrong>{title}</BodyStrong>
          <Sub>{route.params.botId}</Sub>
        </View>
      </View>
      <View style={styles.section}>
        <Row label="运行时" value={runtime.data?.runtimeKind || "cloud-hermes"} />
        <Row label="启用" value={runtime.data?.enabled === false ? "否" : "是"} />
        <Row label="所有者" value={data.ownerUserId || data.owner_user_id || ""} />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.bg },
  content: { padding: space.lg, gap: space.lg },
  head: { flexDirection: "row", alignItems: "center", gap: space.md },
  headText: { flex: 1, gap: 4 },
  section: { gap: space.sm, borderTopWidth: hairlineWidth, borderTopColor: color.line, paddingTop: space.lg },
  row: { flexDirection: "row", justifyContent: "space-between", gap: space.md },
  value: { flex: 1, textAlign: "right", color: color.inkMuted },
});
```

- [ ] **Step 2: Replace Group detail placeholder**

Replace `apps/mobile-rn/src/screens/GroupDetailScreen.tsx` with:

```tsx
import { FlatList, StyleSheet, View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import Avatar from "../components/Avatar";
import { resolveAvatar } from "../logic/conversationList";
import { useConversationMembers } from "../state/queries";
import StateBlock from "../ui/StateBlock";
import { BodyStrong, Label, Sub } from "../ui/Text";
import { color, space, hairlineWidth } from "../theme";
import type { MessagesStackParamList } from "../navigation/types";

type Props = NativeStackScreenProps<MessagesStackParamList, "GroupDetail">;

function memberTitle(member: any): string {
  return member.identity?.displayName || member.bot_name || member.member_ref || "成员";
}

export default function GroupDetailScreen({ route }: Props) {
  const members = useConversationMembers(route.params.conversationId);

  if (members.isLoading) return <StateBlock title="加载群聊…" />;
  if (members.error) return <StateBlock title="群聊加载失败" detail={String((members.error as Error).message || members.error)} />;
  if (!members.data?.length) return <StateBlock title="暂无成员" detail={route.params.title} />;

  return (
    <FlatList
      style={styles.root}
      data={members.data}
      keyExtractor={(item, index) => `${item.member_kind || "member"}:${item.member_ref || index}`}
      ListHeaderComponent={
        <View style={styles.header}>
          <BodyStrong>{route.params.title}</BodyStrong>
          <Sub>{route.params.conversationId}</Sub>
        </View>
      }
      renderItem={({ item }) => {
        const title = memberTitle(item);
        const avatar = resolveAvatar(item.member_ref || title, title, item.identity?.avatar?.image || item.bot_avatar_image || "", item.identity?.avatar?.crop || item.bot_avatar_crop || null);
        return (
          <View style={styles.row}>
            <Avatar title={title} avatar={avatar} />
            <View style={styles.text}>
              <BodyStrong numberOfLines={1}>{title}</BodyStrong>
              <Label>{item.member_kind || "member"}</Label>
            </View>
          </View>
        );
      }}
    />
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.bg },
  header: { padding: space.lg, gap: 4, borderBottomWidth: hairlineWidth, borderBottomColor: color.line },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderBottomWidth: hairlineWidth,
    borderBottomColor: color.line,
  },
  text: { flex: 1, minWidth: 0, gap: 3 },
});
```

- [ ] **Step 3: Run typecheck**

Run:

```bash
cd apps/mobile-rn
npm run typecheck
```

Expected: pass.

- [ ] **Step 4: Commit**

```bash
git add apps/mobile-rn/src/screens/BotDetailScreen.tsx apps/mobile-rn/src/screens/GroupDetailScreen.tsx
git commit -m "feat(mobile): 增加 Bot 和群聊只读详情"
```

## Task 9: Contacts Navigation To Details

**Files:**
- Modify: `apps/mobile-rn/src/screens/ContactsScreen.tsx`

- [ ] **Step 1: Update Contacts screen props and row navigation**

Replace `apps/mobile-rn/src/screens/ContactsScreen.tsx` with:

```tsx
import { FlatList, Pressable, StyleSheet, View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useBots, useFriends } from "../state/queries";
import Avatar from "../components/Avatar";
import type { AvatarDescriptor } from "../api/types";
import { resolveAvatar } from "../logic/conversationList";
import { BodyStrong, Label } from "../ui/Text";
import { color, space } from "../theme";
import type { ContactsStackParamList } from "../navigation/types";

type Props = NativeStackScreenProps<ContactsStackParamList, "ContactsHome">;

interface Row {
  key: string;
  kind: "friend" | "bot";
  id: string;
  title: string;
  sub: string;
  avatar: AvatarDescriptor;
}

export default function ContactsScreen({ navigation }: Props) {
  const { data: bots = [] } = useBots();
  const { data: friends = [] } = useFriends();
  const rows: Row[] = [
    ...friends.map((f, i) => {
      const title = f.username || f.account || String(f.id);
      const id = String(f.id || title || i);
      return { key: `fr:${id}`, kind: "friend" as const, id, title, sub: "好友", avatar: resolveAvatar(id, title, f.avatarImage || "", f.avatarCrop || null) };
    }),
    ...bots.map((bot, i) => {
      const id = String(bot.id || bot.botId || bot.bot_id || bot.key || i);
      const title = bot.displayName || bot.display_name || bot.name || String(id);
      return { key: `bot:${id}`, kind: "bot" as const, id, title, sub: "智能体", avatar: resolveAvatar(id, title, bot.avatarImage || bot.avatar_image || "", bot.avatarCrop || bot.avatar_crop || null) };
    }),
  ];
  return (
    <FlatList
      style={styles.root}
      data={rows}
      keyExtractor={(r) => r.key}
      ListEmptyComponent={<Label style={styles.empty}>暂无联系人</Label>}
      renderItem={({ item }) => (
        <Pressable
          style={({ pressed }) => [styles.row, pressed && styles.pressed]}
          onPress={() => {
            if (item.kind === "bot") navigation.navigate("BotDetail", { botId: item.id, title: item.title });
          }}
        >
          <Avatar title={item.title} avatar={item.avatar} />
          <View style={styles.col}>
            <BodyStrong>{item.title}</BodyStrong>
            <Label style={styles.sub}>{item.sub}</Label>
          </View>
        </Pressable>
      )}
    />
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.bg },
  empty: { textAlign: "center", marginTop: 48 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
  },
  pressed: { backgroundColor: color.surfaceMuted },
  col: { flex: 1, gap: 3 },
  sub: {},
});
```

- [ ] **Step 2: Run typecheck**

Run:

```bash
cd apps/mobile-rn
npm run typecheck
```

Expected: pass.

- [ ] **Step 3: Commit**

```bash
git add apps/mobile-rn/src/screens/ContactsScreen.tsx
git commit -m "feat(mobile): 联系人支持进入 Bot 详情"
```

## Task 10: Final Verification For Phase 1

**Files:**
- Verify only.

- [ ] **Step 1: Run mobile Jest suite**

Run:

```bash
cd apps/mobile-rn
npm test -- --runInBand
```

Expected: all Jest tests pass.

- [ ] **Step 2: Run mobile typecheck**

Run:

```bash
cd apps/mobile-rn
npm run typecheck
```

Expected: no TypeScript errors.

- [ ] **Step 3: Run root structure check**

Run:

```bash
npm test -- tests/project-structure-check.test.js
```

Expected: project-structure checks pass, including the retired mobile-web entry check and RN shared-boundary checks.

- [ ] **Step 4: Inspect final diff**

Run:

```bash
git status --short
git log --oneline -10
```

Expected: working tree clean after task commits; recent commits show the Phase 1 mobile commits.

## Self-Review

Spec coverage for Phase 1:

- Mobile destinations: Tasks 3, 5, 6, 7, 8, and 9 add destinations for Messages, Contacts, Agents, Skills, Settings, Bot detail, and Group detail.
- Read-only data: Tasks 1 and 2 add endpoint builders, types, and query hooks for settings, skills, bridge devices, bridge runs, friend requests, Bot detail, and Bot runtime.
- Existing behavior preservation: Tasks use current `LoginScreen`, `ChatScreen`, `ConversationListScreen`, approval, events, and shared logic without replacing existing flows.
- Boundary rule: all new data paths use Cloud API hooks and `apps/mobile-rn`; no imports from `src/renderer` or `src/web`.

Remaining spec work intentionally deferred to later plans:

- Chat/composer/trace parity.
- Bot edit/capability mutations.
- Skill assignment.
- Friend request actions.
- Group management actions.
- Attachments.
- Notifications.
- Native rendered QA screenshots.
