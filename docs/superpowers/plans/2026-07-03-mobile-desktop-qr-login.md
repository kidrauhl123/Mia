# Mobile Desktop QR Login Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让手机端以“扫描电脑端二维码 + 电脑端小弹窗确认”为主登录路径，扫码成功后直接进入对应桌面账号。

**Architecture:** Mia Cloud 增加一个内存态的二维码登录状态机，负责 grant、pending request、批准/拒绝和 session 发放；桌面端复用现有 `cloudLogin` IPC 出入口展示二维码并轮询待确认请求；手机端把登录页改成扫码优先，只在弱入口里保留微信登录兜底。

**Tech Stack:** Node.js CommonJS、Electron renderer/main IPC、Expo React Native、TypeScript、Node `node:test`、Jest、`expo-camera`

## Global Constraints

- 当前仓库分支是 `main`，且工作区已存在未提交改动；执行前必须先进入隔离 worktree，或得到用户明确允许后原地修改。
- 手机端主入口是扫描桌面二维码登录；现有微信登录保留为弱入口 `其他登录方式`。
- 登录链路必须加一个桌面端二次确认小弹窗；不加 PIN、不加额外确认页、不加登录成功过渡页。
- 二维码只承载短时一次性 grant，不承载长期 bearer token。
- 二维码 URL 必须带当前桌面连接的 cloud origin，让手机端登录到和桌面一致的环境。
- grant 和 request 先做内存态 `Map + TTL + consume-once`；不做数据库持久化。
- 用户可见文案默认中文。
- 移动端改 auth/login 行为时，必须补或更新 Jest 测试，并运行 `npm run typecheck`。

---

## File Map

- Create: `src/cloud/mobile-scan-login.js`
  - 云端二维码登录状态机，封装 grant / request 生命周期和 session 发放。
- Modify: `scripts/serve-cloud.js`
  - 注册 `/api/auth/mobile-scan/*` 路由并接入 `mobile-scan-login.js`。
- Modify: `src/main/cloud/desktop-sync-client.js`
  - 扩展 `login({ action })` 以支持二维码启动、查询待确认请求、批准/拒绝请求。
- Modify: `src/main.js`
  - 复用现有 `IpcChannel.CloudLogin` 调度新的 mobile-scan action。
- Modify: `src/renderer/index.html`
  - `账号与同步` 区域增加二维码卡片和全局确认弹窗骨架。
- Modify: `src/renderer/settings/settings-remote.js`
  - 渲染二维码卡片、刷新按钮和错误/过期状态。
- Modify: `src/renderer/app.js`
  - 拉取二维码、轮询 pending request、驱动确认弹窗 allow/deny。
- Modify: `src/renderer/styles.css`
  - 二维码卡片和确认弹窗样式。
- Create: `apps/mobile-rn/src/logic/mobileScanLogin.ts`
  - 扫码 URL 解析、状态文案映射、请求/轮询输入归一化的纯函数。
- Modify: `apps/mobile-rn/src/screens/LoginScreen.tsx`
  - 把登录页改成扫码优先，保留微信弱入口。
- Modify: `apps/mobile-rn/app.config.ts`
  - 增加相机权限文案配置。
- Modify: `apps/mobile-rn/package.json`
  - 引入 `expo-camera`。
- Create: `apps/mobile-rn/__tests__/mobileScanLogin.test.ts`
  - 纯逻辑测试二维码解析和状态映射。
- Modify: `tests/serve-cloud-bridge.test.js`
  - 覆盖 cloud API 和 session 发放边界。
- Modify: `tests/main-cloud-desktop-sync-client.test.js`
  - 覆盖 desktop sync client 新 action。
- Modify: `tests/renderer-settings-remote.test.js`
  - 覆盖设置页二维码卡片和确认弹窗骨架。

### Task 1: Cloud Mobile-Scan Auth Flow

**Files:**
- Create: `src/cloud/mobile-scan-login.js`
- Modify: `scripts/serve-cloud.js`
- Test: `tests/serve-cloud-bridge.test.js`

**Interfaces:**
- Consumes: `cloudStore.authenticateToken(token)`, `cloudStore.authenticateToken(token)?.user`, existing session issuance inside `src/cloud/sqlite-store.js`
- Produces:
  - `createMobileScanLoginFlow({ cloudStore, now, randomId, publicOriginFromContext })`
  - flow methods:
    - `startGrant({ userId, cloudBase }): { grant, qrUrl, expiresAt }`
    - `createRequest({ grant, deviceLabel, platform }): { requestId, status, expiresAt }`
    - `getPendingRequestForUser(userId): PendingRequest | null`
    - `decideRequest({ userId, requestId, decision }): { status }`
    - `completeRequest({ requestId }): PendingResult`

- [ ] **Step 1: Write the failing cloud auth regression tests**

```js
test("mobile scan request stays pending until desktop approval then returns a normal session", async () => {
  const dataDir = tempDataDir();
  const server = createMiaCloudServer({ dataDir });
  const baseUrl = await listen(server);
  try {
    const account = createAccount(server, "mia-mobile-scan");

    const started = await jsonFetch(baseUrl, "/api/auth/mobile-scan/start", {
      method: "POST",
      headers: { Authorization: `Bearer ${account.token}` },
      body: {}
    });

    const requested = await jsonFetch(baseUrl, "/api/auth/mobile-scan/request", {
      method: "POST",
      body: { grant: started.grant, deviceLabel: "iPhone", platform: "ios" }
    });

    const pending = await jsonFetch(baseUrl, "/api/auth/mobile-scan/complete", {
      method: "POST",
      body: { requestId: requested.requestId }
    });
    assert.equal(pending.status, "pending");

    const queue = await jsonFetch(baseUrl, "/api/auth/mobile-scan/pending", {
      method: "GET",
      headers: { Authorization: `Bearer ${account.token}` }
    });
    assert.equal(queue.requestId, requested.requestId);

    await jsonFetch(baseUrl, "/api/auth/mobile-scan/decision", {
      method: "POST",
      headers: { Authorization: `Bearer ${account.token}` },
      body: { requestId: requested.requestId, decision: "approve" }
    });

    const approved = await jsonFetch(baseUrl, "/api/auth/mobile-scan/complete", {
      method: "POST",
      body: { requestId: requested.requestId }
    });
    assert.equal(approved.status, "approved");
    assert.equal(typeof approved.token, "string");
    assert.equal(server.mia.cloudStore.authenticateToken(approved.token).user.id, account.user.id);
  } finally {
    await close(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the cloud auth test and verify RED**

Run:

```bash
cd /Users/jung/GitHub/Mia && node --test tests/serve-cloud-bridge.test.js
```

Expected:

```text
not ok ... /api/auth/mobile-scan/start
```

- [ ] **Step 3: Implement the minimal grant/request state machine**

```js
function createMobileScanLoginFlow({ cloudStore, now = () => Date.now(), randomId = defaultRandomId }) {
  const grants = new Map();
  const requests = new Map();

  function startGrant({ userId, cloudBase }) {
    const grant = randomId("ms");
    const expiresAt = new Date(now() + 5 * 60 * 1000).toISOString();
    grants.set(grant, { grant, userId, cloudBase, expiresAt, activeRequestId: "", consumedAt: "" });
    return { grant, qrUrl: `${String(cloudBase).replace(/\/+$/, "")}/mobile-scan?grant=${encodeURIComponent(grant)}`, expiresAt };
  }

  function createRequest({ grant, deviceLabel = "", platform = "" }) {
    const record = grants.get(String(grant || ""));
    if (!record) throw new Error("二维码已过期，请在电脑上刷新");
    const requestId = randomId("msr");
    const expiresAt = new Date(Math.min(Date.parse(record.expiresAt), now() + 90 * 1000)).toISOString();
    const pending = { requestId, grant, userId: record.userId, deviceLabel, platform, expiresAt, status: "pending", sessionResult: null };
    requests.set(requestId, pending);
    record.activeRequestId = requestId;
    return { requestId, status: "pending", expiresAt };
  }

  function decideRequest({ userId, requestId, decision }) {
    const pending = requests.get(String(requestId || ""));
    if (!pending || pending.userId !== userId) throw new Error("登录请求不存在。");
    if (decision === "deny") {
      pending.status = "denied";
      return { status: "denied" };
    }
    const sessionResult = cloudStore.createSessionForUser
      ? cloudStore.createSessionForUser(userId)
      : (() => { throw new Error("cloudStore.createSessionForUser missing"); })();
    pending.status = "approved";
    pending.sessionResult = sessionResult;
    return { status: "approved" };
  }
}
```

- [ ] **Step 4: Wire the HTTP routes in `scripts/serve-cloud.js`**

```js
if (req.method === "POST" && url.pathname === "/api/auth/mobile-scan/start") {
  const auth = cloudStore.authenticateToken(tokenFromRequest(req));
  if (!auth) return writeError(res, 401, "请先登录。");
  return writeJson(res, 200, { ok: true, ...context.mobileScanLogin.startGrant({
    userId: auth.user.id,
    cloudBase: publicOriginFromContext(context)
  }) });
}

if (req.method === "GET" && url.pathname === "/api/auth/mobile-scan/pending") {
  const auth = cloudStore.authenticateToken(tokenFromRequest(req));
  if (!auth) return writeError(res, 401, "请先登录。");
  return writeJson(res, 200, context.mobileScanLogin.getPendingRequestForUser(auth.user.id));
}

if (req.method === "POST" && url.pathname === "/api/auth/mobile-scan/request") {
  const body = await readJson(req);
  return writeJson(res, 200, { ok: true, ...context.mobileScanLogin.createRequest(body) });
}
```

- [ ] **Step 5: Run the targeted cloud tests and verify GREEN**

Run:

```bash
cd /Users/jung/GitHub/Mia && node --test tests/serve-cloud-bridge.test.js
```

Expected:

```text
# pass ... mobile scan request stays pending until desktop approval then returns a normal session
```

- [ ] **Step 6: Expand coverage for deny / expired / reused grant**

```js
test("mobile scan deny returns denied and reused grant is rejected", async () => {
  // add a second request after deny, then assert complete() returns denied and
  // a consumed grant cannot mint another approved session
});
```

### Task 2: Desktop QR Card And Confirmation Modal

**Files:**
- Modify: `src/main/cloud/desktop-sync-client.js`
- Modify: `src/main.js`
- Modify: `src/renderer/index.html`
- Modify: `src/renderer/settings/settings-remote.js`
- Modify: `src/renderer/app.js`
- Modify: `src/renderer/styles.css`
- Test: `tests/main-cloud-desktop-sync-client.test.js`
- Test: `tests/renderer-settings-remote.test.js`

**Interfaces:**
- Consumes:
  - Cloud API:
    - `POST /api/auth/mobile-scan/start`
    - `GET /api/auth/mobile-scan/pending`
    - `POST /api/auth/mobile-scan/decision`
  - Existing renderer API `window.mia.cloudLogin(payload)`
- Produces:
  - `client.login({ action: "mobile-scan-start" | "mobile-scan-pending" | "mobile-scan-decision", ... })`
  - DOM ids:
    - `cloudMobileScanCard`
    - `cloudMobileScanQr`
    - `cloudMobileScanRefresh`
    - `cloudLoginApproveDialog`

- [ ] **Step 1: Write the failing desktop sync client tests**

```js
test("desktop sync client starts qr login, reads pending request, and sends approval decisions", async () => {
  const { client, calls } = setup({
    responses: [
      jsonResponse({ grant: "ms_1", qrUrl: "https://cloud.example/mobile-scan?grant=ms_1", expiresAt: "2026-07-03T00:05:00.000Z" }),
      jsonResponse({ requestId: "msr_1", deviceLabel: "iPhone", status: "pending" }),
      jsonResponse({ status: "approved" })
    ]
  });

  const started = await client.login({ action: "mobile-scan-start" });
  const pending = await client.login({ action: "mobile-scan-pending" });
  const decided = await client.login({ action: "mobile-scan-decision", requestId: "msr_1", decision: "approve" });

  assert.equal(started.grant, "ms_1");
  assert.equal(pending.requestId, "msr_1");
  assert.equal(decided.status, "approved");
  assert.deepEqual(calls.fetch.map((entry) => [entry.method, entry.url]), [
    ["POST", "https://cloud.example/api/auth/mobile-scan/start"],
    ["GET", "https://cloud.example/api/auth/mobile-scan/pending"],
    ["POST", "https://cloud.example/api/auth/mobile-scan/decision"]
  ]);
});
```

- [ ] **Step 2: Run the desktop client test and verify RED**

Run:

```bash
cd /Users/jung/GitHub/Mia && node --test tests/main-cloud-desktop-sync-client.test.js
```

Expected:

```text
not ok ... mobile-scan-start
```

- [ ] **Step 3: Implement the new `cloudLogin` actions**

```js
async function startMobileScanLogin() {
  return cloudApi("/api/auth/mobile-scan/start", { method: "POST", body: {} });
}

async function pendingMobileScanLogin() {
  return cloudApi("/api/auth/mobile-scan/pending", { method: "GET" });
}

async function decideMobileScanLogin({ requestId = "", decision = "deny" } = {}) {
  return cloudApi("/api/auth/mobile-scan/decision", {
    method: "POST",
    body: { requestId: String(requestId || ""), decision: decision === "approve" ? "approve" : "deny" }
  });
}

async function login(options = {}) {
  if (options?.action === "mobile-scan-start") return startMobileScanLogin();
  if (options?.action === "mobile-scan-pending") return pendingMobileScanLogin();
  if (options?.action === "mobile-scan-decision") return decideMobileScanLogin(options);
  if (options?.action === "start") return startWechatLogin(options);
  if (options?.action === "complete") return completeWechatLogin(options);
  return loginWithWechat(options);
}
```

- [ ] **Step 4: Add the renderer card and modal wiring**

```html
<section id="cloudMobileScanCard" class="cloud-mobile-scan-card hidden">
  <header class="cloud-mobile-scan-head">
    <strong>手机扫码登录</strong>
    <button id="cloudMobileScanRefresh" class="text-button" type="button">刷新</button>
  </header>
  <div id="cloudMobileScanQr" class="cloud-mobile-scan-qr" aria-live="polite"></div>
  <p id="cloudMobileScanMeta" class="cloud-mobile-scan-meta"></p>
</section>

<section id="cloudLoginApproveDialog" class="cloud-login-approve-dialog hidden" role="dialog" aria-modal="true">
  <div class="cloud-login-approve-panel">
    <p id="cloudLoginApproveCopy">允许这台手机登录当前账号？</p>
    <footer class="cloud-login-approve-actions">
      <button id="cloudLoginApproveDeny" type="button">取消</button>
      <button id="cloudLoginApproveAllow" type="button">允许</button>
    </footer>
  </div>
</section>
```

```js
async function refreshCloudMobileScanCard() {
  const started = await window.mia.cloudLogin({ action: "mobile-scan-start" });
  state.cloudMobileScan = started;
  window.miaSettingsRemote.renderCloudAccount(state.runtime.cloud || {});
}

async function pollCloudMobileScanRequests() {
  const pending = await window.mia.cloudLogin({ action: "mobile-scan-pending" });
  if (!pending?.requestId) return closeCloudLoginApproveDialog();
  openCloudLoginApproveDialog(pending);
}
```

- [ ] **Step 5: Add renderer coverage for the QR card**

```js
test("settings account card exposes the mobile scan qr card and approval dialog shell", () => {
  const html = fs.readFileSync(path.join(root, "src/renderer/index.html"), "utf8");
  assert.match(html, /id="cloudMobileScanCard"/);
  assert.match(html, /id="cloudMobileScanRefresh"/);
  assert.match(html, /id="cloudLoginApproveDialog"/);
  assert.match(html, /允许这台手机登录当前账号/);
});
```

- [ ] **Step 6: Run targeted desktop tests and verify GREEN**

Run:

```bash
cd /Users/jung/GitHub/Mia && node --test tests/main-cloud-desktop-sync-client.test.js tests/renderer-settings-remote.test.js
```

Expected:

```text
# pass ... desktop sync client starts qr login
# pass ... settings account card exposes the mobile scan qr card and approval dialog shell
```

### Task 3: Mobile Scanner-First Login Screen

**Files:**
- Create: `apps/mobile-rn/src/logic/mobileScanLogin.ts`
- Create: `apps/mobile-rn/__tests__/mobileScanLogin.test.ts`
- Modify: `apps/mobile-rn/src/screens/LoginScreen.tsx`
- Modify: `apps/mobile-rn/package.json`
- Modify: `apps/mobile-rn/app.config.ts`

**Interfaces:**
- Consumes:
  - `createCloudClient({ apiBase, getToken })`
  - `setSession({ token, user, apiBase })`
  - Cloud API:
    - `POST /api/auth/mobile-scan/request`
    - `POST /api/auth/mobile-scan/complete`
- Produces:
  - `parseMobileScanQr(raw: string): { apiBase: string; grant: string }`
  - `mobileScanErrorMessage(code: "invalid" | "expired" | "denied" | "used" | "network"): string`

- [ ] **Step 1: Add failing pure logic tests for QR parsing and error mapping**

```ts
import { mobileScanErrorMessage, parseMobileScanQr } from "../src/logic/mobileScanLogin";

test("parseMobileScanQr reads grant and apiBase from Mia desktop qr url", () => {
  expect(parseMobileScanQr("https://mia.example/mobile-scan?grant=ms_123")).toEqual({
    apiBase: "https://mia.example",
    grant: "ms_123"
  });
});

test("mobileScanErrorMessage keeps invalid qr copy concise", () => {
  expect(mobileScanErrorMessage("invalid")).toBe("这不是 Mia 登录码");
});
```

- [ ] **Step 2: Run the mobile helper test and verify RED**

Run:

```bash
cd /Users/jung/GitHub/Mia/apps/mobile-rn && npm test -- mobileScanLogin.test.ts
```

Expected:

```text
Cannot find module '../src/logic/mobileScanLogin'
```

- [ ] **Step 3: Implement the helper module and minimal camera config**

```ts
export function parseMobileScanQr(raw: string) {
  const url = new URL(String(raw || ""));
  if (!/\/mobile-scan$/.test(url.pathname)) throw new Error("invalid");
  const grant = String(url.searchParams.get("grant") || "").trim();
  if (!grant) throw new Error("invalid");
  return { apiBase: url.origin, grant };
}

export function mobileScanErrorMessage(code: "invalid" | "expired" | "denied" | "used" | "network") {
  if (code === "expired") return "二维码已过期，请在电脑上刷新";
  if (code === "denied") return "电脑端已取消本次登录";
  if (code === "used") return "这个二维码已经用过了，请重新生成";
  if (code === "network") return "网络异常，请重试";
  return "这不是 Mia 登录码";
}
```

```ts
plugins: [
  "expo-secure-store",
  "expo-sqlite",
  "expo-video",
  "expo-notifications",
  "expo-camera",
  "./modules/mia-android-updater/plugin/withMiaAndroidUpdater",
],
ios: {
  // ...
  infoPlist: {
    LSApplicationQueriesSchemes: ["weixin"],
    NSCameraUsageDescription: "用于扫描电脑端二维码登录 Mia"
  }
}
```

- [ ] **Step 4: Replace the login screen primary flow with scanner + waiting state**

```tsx
const [mode, setMode] = useState<"scanner" | "waiting" | "wechat">("scanner");
const [requestId, setRequestId] = useState("");
const [scanApiBase, setScanApiBase] = useState(DEFAULT_API_BASE);

async function handleScan(rawValue: string) {
  try {
    const parsed = parseMobileScanQr(rawValue);
    setScanApiBase(parsed.apiBase);
    const client = createCloudClient({ apiBase: parsed.apiBase, getToken: () => "" });
    const requested = await client.api("/api/auth/mobile-scan/request", {
      method: "POST",
      body: { grant: parsed.grant, deviceLabel: Device.modelName || "手机", platform: Platform.OS }
    });
    setRequestId(requested.requestId);
    setMode("waiting");
  } catch (error) {
    setError(mobileScanErrorMessage(error instanceof Error ? "invalid" : "network"));
  }
}

useEffect(() => {
  if (mode !== "waiting" || !requestId) return;
  const timer = setInterval(async () => {
    const client = createCloudClient({ apiBase: scanApiBase, getToken: () => "" });
    const next = await client.api("/api/auth/mobile-scan/complete", {
      method: "POST",
      body: { requestId }
    });
    if (next.status === "approved" && next.token) {
      setSession({ token: next.token, user: next.user || null, apiBase: scanApiBase });
    }
  }, 1500);
  return () => clearInterval(timer);
}, [mode, requestId, scanApiBase, setSession]);
```

- [ ] **Step 5: Run mobile Jest and typecheck to verify GREEN**

Run:

```bash
cd /Users/jung/GitHub/Mia/apps/mobile-rn && npm test -- mobileScanLogin.test.ts && npm run typecheck
```

Expected:

```text
PASS __tests__/mobileScanLogin.test.ts
Found 0 errors.
```

- [ ] **Step 6: Run the focused root regression suite**

Run:

```bash
cd /Users/jung/GitHub/Mia && node --test tests/serve-cloud-bridge.test.js tests/main-cloud-desktop-sync-client.test.js tests/renderer-settings-remote.test.js
```

Expected:

```text
# all selected tests pass
```
