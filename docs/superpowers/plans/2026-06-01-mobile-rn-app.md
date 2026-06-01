# 原生手机端(React Native + Expo)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development 或 superpowers:executing-plans。步骤用 `- [ ]` 复选框追踪。

**Goal:** 在 `apps/mobile-rn/` 用 React Native + Expo(TS)实现原生手机端,跑通登录 / 底部 Tab / 聊天(气泡 + trace 折叠)/ 乐观发送 / WS 实时 / 权限底部 sheet,云端零改动;EAS 出 APK + OTA。

**Architecture:** `api/` 唯一网络层(REST + WS,移植自 `cloud-client.js`);`logic/` 纯函数(移植已写好的 JS 纯模块,jest 单测);`state/` auth + react-query + WS 生命周期;`screens/`+`components/` 用 RN 组件渲染。

**Tech Stack:** Expo SDK 56 / React Native / TypeScript / React Navigation(bottom-tabs + native-stack)/ @tanstack/react-query / @gorhom/bottom-sheet / react-native-markdown-display / expo-secure-store / jest(jest-expo)。

**Spec:** `docs/superpowers/specs/2026-06-01-mobile-rn-app-design.md`

---

## Task 1: 脚手架 + 依赖 + 测试环境

**Files:** 新建 `apps/mobile-rn/`(create-expo-app 生成)

- [ ] **Step 1: 生成 Expo TS 工程**

Run:
```bash
cd ~/github/Mia/apps && npx create-expo-app@latest mobile-rn --template blank-typescript
```
Expected: 生成 `apps/mobile-rn/`(App.tsx、package.json、tsconfig.json)

- [ ] **Step 2: 装运行期依赖**

Run(在 `apps/mobile-rn/`):
```bash
npx expo install @react-navigation/native @react-navigation/native-stack @react-navigation/bottom-tabs \
  react-native-screens react-native-safe-area-context @tanstack/react-query \
  expo-secure-store react-native-markdown-display @gorhom/bottom-sheet react-native-reanimated react-native-gesture-handler
```
Expected: 写入 package.json,无致命错误

- [ ] **Step 3: 装测试依赖 + jest 配置**

Run:
```bash
npm i -D jest @types/jest ts-jest
```
建 `apps/mobile-rn/jest.config.js`(只测纯逻辑,用 ts-jest/node,不拉 RN native):
```js
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  testMatch: ["**/__tests__/**/*.test.ts"],
};
```
在 `package.json` 的 scripts 加:`"test": "jest"`、`"typecheck": "tsc --noEmit"`。

- [ ] **Step 4: 冒烟验证**

Run: `cd apps/mobile-rn && npx tsc --noEmit && echo OK`
Expected: 无类型错误（空工程）

- [ ] **Step 5: 提交**

```bash
cd ~/github/Mia && git add apps/mobile-rn && git commit -m "feat(rn): scaffold Expo TS app with navigation/query/test deps"
```

---

## Task 2: api/types.ts + api/client.ts(REST,TDD)

**Files:** Create `apps/mobile-rn/src/api/types.ts`、`src/api/client.ts`、`__tests__/client.test.ts`

- [ ] **Step 1: 写失败测试** `__tests__/client.test.ts`

```ts
import { createCloudClient } from "../src/api/client";

test("GET 带 Bearer,无 clientOpId", async () => {
  const calls: any[] = [];
  const fetchImpl = async (url: string, opts: any) => {
    calls.push({ url, opts });
    return { ok: true, status: 200, json: async () => ({ ok: 1 }) } as any;
  };
  const c = createCloudClient({ apiBase: "https://c.test", fetchImpl, getToken: () => "T" });
  const d = await c.api("/api/me");
  expect(d.ok).toBe(1);
  expect(calls[0].url).toBe("https://c.test/api/me");
  expect(calls[0].opts.headers.Authorization).toBe("Bearer T");
  expect(calls[0].opts.body).toBeUndefined();
});

test("POST 注入 clientOpId 并序列化", async () => {
  let seen: any;
  const fetchImpl = async (_u: string, o: any) => { seen = o; return { ok: true, status: 200, json: async () => ({}) } as any; };
  const c = createCloudClient({ apiBase: "https://c.test", fetchImpl, getToken: () => "", idFactory: () => "op_x" });
  await c.api("/api/x", { method: "POST", body: { a: 1 } });
  expect(JSON.parse(seen.body)).toEqual({ a: 1, clientOpId: "op_x" });
});

test("非 2xx 抛 data.error", async () => {
  const fetchImpl = async () => ({ ok: false, status: 403, json: async () => ({ error: "no" }) } as any);
  const c = createCloudClient({ apiBase: "https://c.test", fetchImpl, getToken: () => "" });
  await expect(c.api("/api/x")).rejects.toThrow("no");
});
```

- [ ] **Step 2: 跑测试确认失败** — `npm test` → FAIL(模块不存在)

- [ ] **Step 3: 写 types.ts**

```ts
export type SenderKind = "user" | "fellow" | "system";
export interface MessageRow {
  id?: string; seq?: number; conversation_id?: string;
  sender_kind?: SenderKind; sender_ref?: string;
  body_md?: string; client_trace_id?: string; trace_json?: string;
  created_at?: string; attachments?: unknown[]; mentions?: unknown[];
}
export interface Conversation {
  id: string; name?: string; title?: string; type?: string;
  last_message_text?: string; last_activity_at?: string; updated_at?: string; created_at?: string;
}
export interface Member { member_kind?: string; member_ref?: string; fellow_name?: string }
export interface Fellow { id?: string; key?: string; name?: string }
export interface Friend { id?: string; username?: string }
export interface WsEnvelope { type?: string; seq?: number; [k: string]: any }

export const PermissionDecision = { AllowOnce: "allow_once", AllowAlways: "allow_always", Deny: "deny" } as const;
export type PermissionDecisionT = typeof PermissionDecision[keyof typeof PermissionDecision];
export function decisionToHermesChoice(d: PermissionDecisionT): "once" | "always" | "deny" {
  if (d === PermissionDecision.AllowAlways) return "always";
  if (d === PermissionDecision.AllowOnce) return "once";
  return "deny";
}
```

- [ ] **Step 4: 写 client.ts**

```ts
type FetchImpl = (url: string, opts: any) => Promise<{ ok: boolean; status: number; json: () => Promise<any> }>;
interface Deps { apiBase: string; fetchImpl?: FetchImpl; getToken: () => string; idFactory?: () => string }

function defaultId() {
  return `op_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export function createCloudClient(deps: Deps) {
  const apiBase = (deps.apiBase || "").replace(/\/+$/, "");
  const fetchImpl: FetchImpl = deps.fetchImpl || ((globalThis as any).fetch?.bind(globalThis));
  const getToken = deps.getToken;
  const idFactory = deps.idFactory || defaultId;
  if (!fetchImpl) throw new Error("cloud-client: no fetch");

  async function api(path: string, options: any = {}) {
    const headers: any = { "Content-Type": "application/json", ...(options.headers || {}) };
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    let body = options.body;
    const method = String(options.method || "GET").toUpperCase();
    const mutating = ["POST", "PUT", "PATCH", "DELETE"].includes(method);
    if (mutating && body && typeof body === "object" && !body.clientOpId) body = { ...body, clientOpId: idFactory() };
    const res = await fetchImpl(`${apiBase}${path}`, { ...options, headers, body: body && typeof body !== "string" ? JSON.stringify(body) : body });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }
  return { api, apiBase };
}
```

- [ ] **Step 5: 跑测试确认通过** — `npm test` → 3 PASS;`npx tsc --noEmit` 通过

- [ ] **Step 6: 提交** — `git commit -m "feat(rn): REST client + domain types"`

---

## Task 3: api/events.ts(WebSocket,TDD)

**Files:** Create `src/api/events.ts`、`__tests__/events.test.ts`

- [ ] **Step 1: 失败测试**

```ts
import { eventsUrlFor, backoffMs, createEventsClient } from "../src/api/events";

test("url + backoff", () => {
  expect(eventsUrlFor("https://c.test", 7)).toBe("wss://c.test/api/events?since_seq=7");
  expect(eventsUrlFor("http://c.test", 0)).toBe("ws://c.test/api/events?since_seq=0");
  expect(backoffMs(0)).toBe(1000);
  expect(backoffMs(2)).toBe(4000);
  expect(backoffMs(10)).toBe(30000);
});

test("连接用 mia-token subprotocol,分发 message,断线调度重连", () => {
  const sockets: any[] = [];
  class FakeWS { url: string; protocols: any; l: any = {};
    constructor(u: string, p: any) { this.url = u; this.protocols = p; sockets.push(this); }
    addEventListener(t: string, fn: any) { (this.l[t] ||= []).push(fn); }
    close() { (this.l.close || []).forEach((f: any) => f({})); }
    emit(t: string, e: any) { (this.l[t] || []).forEach((f: any) => f(e)); }
  }
  const scheduled: any[] = []; const got: any[] = [];
  const c = createEventsClient({ apiBase: "https://c.test", getToken: () => "TK",
    WebSocketImpl: FakeWS as any, scheduleReconnect: (fn) => scheduled.push(fn) });
  c.connect({ sinceSeq: () => 3, onEvent: (e) => got.push(e) });
  expect(sockets[0].url).toBe("wss://c.test/api/events?since_seq=3");
  expect(sockets[0].protocols).toEqual(["mia-token.TK"]);
  sockets[0].emit("message", { data: JSON.stringify({ type: "x", seq: 4 }) });
  expect(got[0].type).toBe("x");
  sockets[0].emit("close", {});
  expect(scheduled.length).toBe(1);
});
```

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 写 events.ts**(移植 cloud-client.js 的 WS 部分)

```ts
import type { WsEnvelope } from "./types";

export function eventsUrlFor(apiBase: string, sinceSeq: number) {
  const base = (apiBase || "").replace(/\/+$/, "").replace(/^http:/, "ws:").replace(/^https:/, "wss:");
  return `${base}/api/events?since_seq=${Number(sinceSeq) || 0}`;
}
export function backoffMs(attempt: number) {
  return Math.min(30000, 1000 * Math.pow(2, Math.max(0, attempt)));
}

interface Deps {
  apiBase: string; getToken: () => string;
  WebSocketImpl?: any; scheduleReconnect?: (fn: () => void, ms: number) => void;
}
interface ConnectOpts { sinceSeq: () => number; onEvent: (e: WsEnvelope) => void; onStatus?: (s: string) => void }

export function createEventsClient(deps: Deps) {
  const WS = deps.WebSocketImpl || (globalThis as any).WebSocket;
  const schedule = deps.scheduleReconnect || ((fn: () => void, ms: number) => setTimeout(fn, ms));
  let socket: any = null, stopped = false, attempt = 0;

  function connect(opts: ConnectOpts) {
    stopped = false;
    const token = deps.getToken();
    if (!token || !WS) return;
    disconnect();
    let s: any;
    try { s = new WS(eventsUrlFor(deps.apiBase, opts.sinceSeq()), ["mia-token." + token]); }
    catch { if (!stopped) schedule(() => connect(opts), backoffMs(attempt++)); return; }
    socket = s;
    opts.onStatus?.("connecting");
    s.addEventListener("open", () => { attempt = 0; opts.onStatus?.("open"); });
    s.addEventListener("message", (ev: any) => {
      if (socket !== s) return;
      let env: WsEnvelope; try { env = JSON.parse(ev.data); } catch { return; }
      opts.onEvent(env);
    });
    const down = () => { if (socket !== s) return; socket = null; opts.onStatus?.("down"); if (!stopped) schedule(() => connect(opts), backoffMs(attempt++)); };
    s.addEventListener("close", down); s.addEventListener("error", down);
  }
  function disconnect() { const s = socket; socket = null; if (s) try { s.close(); } catch {} }
  function stop() { stopped = true; disconnect(); }
  return { connect, disconnect, stop };
}
```

- [ ] **Step 4: 跑测试确认通过** — 2 PASS

- [ ] **Step 5: 提交** — `git commit -m "feat(rn): WebSocket events client"`

---

## Task 4-7: logic/*(纯函数,TDD,移植)

每个 Task 同形:写 `__tests__/<name>.test.ts` → 跑红 → 写 `src/logic/<name>.ts` → 跑绿 → 提交。

- [ ] **Task 4 — logic/sendPipeline.ts**:`prepareOutgoingMessage({text,attachments?},{members?})` → `{bodyMd,mentions,attachments,clientTraceId}`;空消息抛 `EMPTY_MESSAGE`;>maxLength 抛 `MESSAGE_TOO_LONG`;`parseMentions` 按成员解析 `@token`。移植 `src/shared/send-pipeline.js`。测试覆盖:正常、空、超长。
- [ ] **Task 5 — logic/conversationList.ts**:`buildConversationListItems({conversations,unreadByConversation})` → 按 last_activity 倒序、`{id,title,subtitle,unread}`,缺字段降级。移植 `conversation-list-model.js`。测试覆盖:排序+未读、降级。
- [ ] **Task 6 — logic/approvalQueue.ts**:`createApprovalQueue()` → `onRequest/onResponded/resolve/active/size`,同 runId 去重,FIFO。移植 `approval-queue.js`。测试覆盖:入队/前进/responded/去重。
- [ ] **Task 7 — logic/optimisticSend.ts**:`buildPendingMessage(input,ctx)`、`reconcilePending(list,serverRow)` 按 clientTraceId 替换或追加。移植 `optimistic-send.js`(依赖注入 sendPipeline,避免循环)。测试覆盖:pending 生成、空抛错、对账替换、无匹配追加。

每个 Task 末:`git commit -m "feat(rn): logic/<name>"`。

> 这四个模块的实现与测试断言**直接照搬已写好的 JS 版**(`src/mobile/lib/*`、`src/shared/send-pipeline.js`),仅改 TS 语法 + import/export。

---

## Task 8: state/auth.tsx(secure-store + Context)

**Files:** Create `src/state/auth.tsx`

- [ ] **Step 1: 写 AuthProvider**

```tsx
import React, { createContext, useContext, useEffect, useState } from "react";
import * as SecureStore from "expo-secure-store";

const KEY = "mia.session";
const DEFAULT_API_BASE = "https://aiweb.buytb01.com";

interface Session { token: string; user: any; apiBase: string }
interface AuthCtx { session: Session | null; ready: boolean; setSession: (s: Session | null) => void; apiBase: string }
const Ctx = createContext<AuthCtx>(null as any);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSessionState] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    SecureStore.getItemAsync(KEY).then((raw) => {
      if (raw) { try { setSessionState(JSON.parse(raw)); } catch {} }
      setReady(true);
    });
  }, []);
  const setSession = (s: Session | null) => {
    setSessionState(s);
    if (s) SecureStore.setItemAsync(KEY, JSON.stringify(s)); else SecureStore.deleteItemAsync(KEY);
  };
  return <Ctx.Provider value={{ session, ready, setSession, apiBase: session?.apiBase || DEFAULT_API_BASE }}>{children}</Ctx.Provider>;
}
export const useAuth = () => useContext(Ctx);
export { DEFAULT_API_BASE };
```

- [ ] **Step 2: typecheck + 提交** — `npx tsc --noEmit`;`git commit -m "feat(rn): auth context with secure-store"`

---

## Task 9: state/queries.ts(react-query hooks)+ client 单例

**Files:** Create `src/state/clientProvider.tsx`、`src/state/queries.ts`

- [ ] **Step 1: client 单例(随 auth 变化)** `clientProvider.tsx`

```tsx
import React, { createContext, useContext, useMemo } from "react";
import { createCloudClient } from "../api/client";
import { useAuth } from "./auth";

const Ctx = createContext<ReturnType<typeof createCloudClient>>(null as any);
export function ApiProvider({ children }: { children: React.ReactNode }) {
  const { apiBase, session } = useAuth();
  const client = useMemo(() => createCloudClient({ apiBase, getToken: () => session?.token || "" }), [apiBase, session?.token]);
  return <Ctx.Provider value={client}>{children}</Ctx.Provider>;
}
export const useApi = () => useContext(Ctx);
```

- [ ] **Step 2: queries.ts**

```ts
import { useQuery } from "@tanstack/react-query";
import { useApi } from "./clientProvider";

export function useConversations() {
  const api = useApi();
  return useQuery({ queryKey: ["conversations"], queryFn: () => api.api("/api/conversations").then((d) => d.conversations || []) });
}
export function useMessages(conversationId: string) {
  const api = useApi();
  return useQuery({
    queryKey: ["messages", conversationId],
    enabled: !!conversationId,
    queryFn: () => api.api(`/api/conversations/${encodeURIComponent(conversationId)}/messages?limit=200`).then((d) => d.messages || []),
  });
}
export function useFellows() { const api = useApi(); return useQuery({ queryKey: ["fellows"], queryFn: () => api.api("/api/me/fellows?compact=1").then((d) => d.fellows || []) }); }
export function useFriends() { const api = useApi(); return useQuery({ queryKey: ["friends"], queryFn: () => api.api("/api/social/friends").then((d) => d.friends || []) }); }
```

- [ ] **Step 3: typecheck + 提交** — `git commit -m "feat(rn): api provider + react-query hooks"`

---

## Task 10: state/events.tsx(WS 生命周期 + 分发)

**Files:** Create `src/state/events.tsx`

- [ ] **Step 1: 写 EventsProvider**(连接 WS,事件写入 query cache + 审批队列;暴露 approvals + connStatus)

```tsx
import React, { createContext, useContext, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { createEventsClient } from "../api/events";
import { createApprovalQueue } from "../logic/approvalQueue";
import { reconcilePending } from "../logic/optimisticSend";
import { useAuth } from "./auth";

interface EventsCtx { connStatus: string; approvalActive: any; decideRefresh: number }
const Ctx = createContext<EventsCtx>({ connStatus: "open", approvalActive: null, decideRefresh: 0 });

export function EventsProvider({ children }: { children: React.ReactNode }) {
  const { apiBase, session } = useAuth();
  const qc = useQueryClient();
  const queue = useRef(createApprovalQueue()).current;
  const [connStatus, setConn] = useState("open");
  const [tick, setTick] = useState(0);
  const lastSeq = useRef(0);
  useEffect(() => {
    if (!session?.token) return;
    const c = createEventsClient({ apiBase, getToken: () => session.token });
    c.connect({
      sinceSeq: () => lastSeq.current,
      onStatus: setConn,
      onEvent: (env) => {
        if (typeof env.seq === "number" && env.seq > lastSeq.current) lastSeq.current = env.seq;
        if (env.type === "message" || env.type === "message.created") {
          const row = env.message || env.data || {};
          const cid = row.conversation_id || env.conversation_id;
          if (cid) qc.setQueryData(["messages", cid], (old: any) => reconcilePending(old || [], row));
        } else if (env.type === "approval.request") {
          queue.onRequest({ conversationId: env.conversation_id, runId: env.run_id || env.runId, preview: env.preview || env.tool_name || "请求执行操作" });
          setTick((t) => t + 1);
        } else if (env.type === "approval.responded") {
          queue.onResponded(env.run_id || env.runId); setTick((t) => t + 1);
        }
      },
    });
    return () => c.stop();
  }, [apiBase, session?.token]);
  // 经 tick 暴露队列与一个让 sheet 决策后刷新的接口
  (globalThis as any).__miaApprovals = queue;
  return <Ctx.Provider value={{ connStatus, approvalActive: queue.active(), decideRefresh: tick }}>{children}</Ctx.Provider>;
}
export const useEvents = () => useContext(Ctx);
```

- [ ] **Step 2: typecheck + 提交** — `git commit -m "feat(rn): WS events provider wiring cache + approvals"`

---

## Task 11: 导航(RootNavigator + Tabs)

**Files:** Create `src/navigation/RootNavigator.tsx`、`src/navigation/Tabs.tsx`;改 `App.tsx`

- [ ] **Step 1: Tabs.tsx**(底部 Tab:消息 stack / 联系人 / 我)

```tsx
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import ConversationListScreen from "../screens/ConversationListScreen";
import ChatScreen from "../screens/ChatScreen";
import ContactsScreen from "../screens/ContactsScreen";
import MeScreen from "../screens/MeScreen";

const Stack = createNativeStackNavigator();
const Tab = createBottomTabNavigator();

function MessagesStack() {
  return (
    <Stack.Navigator>
      <Stack.Screen name="Conversations" component={ConversationListScreen} options={{ title: "消息" }} />
      <Stack.Screen name="Chat" component={ChatScreen} options={({ route }: any) => ({ title: route.params?.title || "" })} />
    </Stack.Navigator>
  );
}
export default function Tabs() {
  return (
    <Tab.Navigator>
      <Tab.Screen name="Messages" component={MessagesStack} options={{ headerShown: false, title: "消息" }} />
      <Tab.Screen name="Contacts" component={ContactsScreen} options={{ title: "联系人" }} />
      <Tab.Screen name="Me" component={MeScreen} options={{ title: "我" }} />
    </Tab.Navigator>
  );
}
```

- [ ] **Step 2: RootNavigator.tsx**(auth gate)

```tsx
import { NavigationContainer } from "@react-navigation/native";
import { useAuth } from "../state/auth";
import LoginScreen from "../screens/LoginScreen";
import Tabs from "./Tabs";

export default function RootNavigator() {
  const { session, ready } = useAuth();
  if (!ready) return null;
  return <NavigationContainer>{session?.token ? <Tabs /> : <LoginScreen />}</NavigationContainer>;
}
```

- [ ] **Step 3: App.tsx**(组装 providers)

```tsx
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthProvider } from "./src/state/auth";
import { ApiProvider } from "./src/state/clientProvider";
import { EventsProvider } from "./src/state/events";
import RootNavigator from "./src/navigation/RootNavigator";

const qc = new QueryClient();
export default function App() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <QueryClientProvider client={qc}>
          <AuthProvider>
            <ApiProvider>
              <EventsProvider>
                <RootNavigator />
              </EventsProvider>
            </ApiProvider>
          </AuthProvider>
        </QueryClientProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
```

- [ ] **Step 4: typecheck + 提交** — `git commit -m "feat(rn): navigation shell + provider assembly"`

---

## Task 12: 屏幕(Login / ConversationList / Chat / Contacts / Me)

**Files:** Create `src/screens/*.tsx`

各屏完整实现(登录走 `/api/auth/login|register` 写 session;列表用 useConversations + buildConversationListItems;Chat 用 useMessages + 乐观发送 + TraceBlock + ApprovalSheet;Contacts 用 useFellows/useFriends;Me 显示用户名 + 退出)。每屏写完 `npx tsc --noEmit` 通过后提交。关键交互代码:

- **LoginScreen**:服务器/用户名/密码输入 → `createCloudClient({apiBase}).api("/api/auth/login",{method:"POST",body})` → `setSession({token,user,apiBase})`。
- **ChatScreen 发送**:`buildPendingMessage` 乐观插入 query cache → POST `/messages` → `reconcilePending` 落定;失败标红。
- **ChatScreen 渲染**:`FlatList` 渲染 `MessageBubble`;assistant 消息若有 `trace_json` 渲染 `TraceBlock`。
- 提交粒度:每屏一个 commit,`git commit -m "feat(rn): <Screen>"`。

---

## Task 13: 组件(MessageBubble / TraceBlock / ApprovalSheet / Avatar / ConnBanner)

**Files:** Create `src/components/*.tsx`

- **MessageBubble**:own 右对齐紫底、pending 半透明、failed 红边;正文 `react-native-markdown-display`。
- **TraceBlock**:`<Pressable>` 切换展开;收起显示"思考 · N 步"chip,展开显示 reasoning + 工具列表。
- **ApprovalSheet**:`@gorhom/bottom-sheet`,active 时弹出,三键(拒绝/允许/始终)→ `api.api(".../runs/:run/approval",{method:"POST",body:{decision,choice:decisionToHermesChoice(decision)}})` → `queue.resolve(runId)`。
- **Avatar**:首字母圆形占位。
- **ConnBanner**:connStatus !== "open" 时顶部"连接中"。
每个组件 typecheck 通过后提交。

---

## Task 14: app.config.ts + eas.json(构建/发布,交付步骤)

**Files:** Create `apps/mobile-rn/app.config.ts`、`eas.json`

- [ ] **Step 1: app.config.ts**(android package、updates、插件 reanimated/secure-store)

```ts
export default {
  expo: {
    name: "Mia", slug: "mia-mobile",
    android: { package: "app.mia.mobile" },
    plugins: ["expo-secure-store"],
    extra: { apiBase: "https://aiweb.buytb01.com" },
  },
};
```

- [ ] **Step 2: eas.json**

```json
{
  "cli": { "version": ">= 12.0.0" },
  "build": {
    "development": { "developmentClient": true, "distribution": "internal" },
    "preview": { "distribution": "internal", "android": { "buildType": "apk" } },
    "production": {}
  }
}
```

- [ ] **Step 3: 全量校验** — `cd apps/mobile-rn && npm test && npx tsc --noEmit`
Expected: jest 全绿 + 无类型错误

- [ ] **Step 4: 提交** — `git commit -m "feat(rn): expo app config + eas build profiles"`

- [ ] **Step 5: 交付步骤(需你的 Expo 账号,不在本环境)**
```bash
cd apps/mobile-rn
npx eas login                 # 你的 Expo 账号登录(交互)
npx eas build -p android --profile preview   # 云构建 APK,完事给安装二维码
npx eas update --branch preview              # 以后改 JS 走 OTA 热更
```

---

## Self-Review 记录

- **Spec 覆盖**:登录(T12)、Tab(T11)、聊天+trace(T12/T13)、乐观发送(T7/T12)、WS 实时(T3/T10)、权限 sheet(T6/T13)、REST/WS 唯一网络层(T2/T3)、EAS 构建+OTA(T14)。推送/iOS/Capacitor 退役在 spec「不在范围」内,未建任务。
- **占位扫描**:`extra.apiBase` 是配置值非占位;无 TODO/TBD。
- **类型一致**:`createCloudClient`/`createEventsClient`/`createApprovalQueue`/`buildPendingMessage`/`reconcilePending`/`buildConversationListItems`/`prepareOutgoingMessage`/`decisionToHermesChoice` 命名在测试、provider、screen 调用处一致。
- **环境边界**:Task 1-13 可在本机做到 jest 全绿 + tsc 通过;Task 14 的 EAS 云构建/OTA 需 Expo 账号(交互登录),作为交付步骤标注。
