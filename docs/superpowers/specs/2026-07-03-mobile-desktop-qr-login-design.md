# Mobile Desktop QR Login Design

## Scope

This design adds mobile login by scanning a desktop-generated QR code and approving the login on the desktop. It applies to the Electron desktop app, the Mia Cloud auth service, and the Expo React Native mobile app.

The mobile app should make QR scan login the primary path. The existing WeChat login stays available as a secondary fallback behind a weak `其他登录方式` entry.

This work does not change web login, local-only auth, or the existing desktop WeChat login path.

## Existing Boundaries

- Desktop cloud auth already flows through `src/main/cloud/desktop-sync-client.js`, `IpcChannel.CloudLogin`, and `src/preload.js`.
- Desktop account UI already exists in `src/renderer/index.html` and `src/renderer/settings/settings-remote.js`.
- Mobile session persistence already uses `setSession({ token, user, apiBase })` in `apps/mobile-rn/src/state/auth.tsx`.
- Cloud auth routes already live in `scripts/serve-cloud.js` and existing session issuance already lives in `src/cloud/sqlite-store.js`.

The new flow should extend those boundaries instead of creating a parallel auth stack.

## Product Behavior

1. A signed-in desktop user opens `设置 -> 账号与同步`.
2. Mia shows a `手机扫码登录` card with a QR code.
3. The mobile login screen opens directly into a QR scanner.
4. The user scans the desktop QR code.
5. The mobile app submits a login request and switches to a simple `等待电脑确认` state.
6. The desktop app shows a small in-app confirmation modal:
   - `允许这台手机登录当前账号？`
   - If the mobile app provides a device label, use it: `允许 iPhone 登录当前账号？`
   - Actions: `允许` and `取消`
7. If the desktop user allows the request, the mobile app receives a normal Mia Cloud session and enters the app immediately.
8. If the desktop user cancels, the request expires, or the QR code is invalid, the mobile app returns to a scannable state with a concise error.

This flow intentionally does not add a PIN, a second confirmation page on mobile, or a post-login success screen.

## QR Payload And Environment

The QR code should encode a full URL on the desktop's current Mia Cloud origin:

`<cloudBase>/mobile-scan?grant=<grant>`

Important consequences:

- The QR code carries a short-lived one-time grant, never a long-lived bearer token.
- The mobile app parses both the `grant` and the scanned origin.
- The scanned origin becomes the mobile `apiBase` for this login, so a dev phone connected to a non-production cloud logs into the same environment as the desktop that generated the QR code.

The QR card should refresh the current grant automatically when expired and also expose a small manual `刷新` action.

## Architecture

Add a small cloud-side module dedicated to this flow, for example `src/cloud/mobile-scan-login.js`.

That module owns two in-memory records:

- `grant`
  - `grantId`
  - `userId`
  - `cloudBase`
  - `createdAt`
  - `expiresAt`
  - `activeRequestId`
  - `consumedAt`
- `request`
  - `requestId`
  - `grantId`
  - `userId`
  - `deviceLabel`
  - `platform`
  - `createdAt`
  - `expiresAt`
  - `status` as `pending`, `approved`, `denied`, or `expired`
  - `sessionResult` only after approval

Behavior rules:

- A grant is short-lived, recommended 5 minutes.
- A request is shorter-lived, recommended 90 seconds or the grant expiry, whichever comes first.
- Only one active request may exist for a grant at a time.
- Creating a new desktop QR invalidates previous unconsumed grants for that same desktop account. This keeps the visible QR code authoritative and avoids approval races.
- Approving a request consumes both the request and the grant.
- Denying a request ends that request but leaves the grant reusable until its normal expiry.
- Cloud process restart invalidates all outstanding grants and requests. That is acceptable for this flow.

Session issuance should reuse the existing cloud session creation path so the approved mobile login returns the same session shape already used elsewhere.

## Cloud API

Add the following routes beside the existing `/api/auth/*` routes.

Authenticated desktop routes:

- `POST /api/auth/mobile-scan/start`
  - Requires the current desktop cloud token.
  - Returns `{ ok, grant, qrUrl, expiresAt }`.
- `GET /api/auth/mobile-scan/pending`
  - Requires the current desktop cloud token.
  - Returns the current pending request for that desktop account, or `null`.
- `POST /api/auth/mobile-scan/decision`
  - Requires the current desktop cloud token.
  - Body: `{ requestId, decision }` where decision is `approve` or `deny`.
  - Returns `{ ok, status }`.

Anonymous mobile routes:

- `POST /api/auth/mobile-scan/request`
  - Body: `{ grant, deviceLabel, platform }`.
  - Validates the grant, creates a pending request, and returns `{ ok, requestId, status: "pending", expiresAt }`.
- `POST /api/auth/mobile-scan/complete`
  - Body: `{ requestId }`.
  - Returns one of:
    - `{ ok: true, status: "pending", expiresAt }`
    - `{ ok: true, status: "approved", token, user }`
    - `{ ok: false, status: "denied", error }`
    - `{ ok: false, status: "expired", error }`
    - `{ ok: false, status: "used", error }`

The mobile app should never receive a session token before the desktop approval step completes.

## Desktop Design

Desktop transport should stay behind the existing cloud auth boundary:

- Extend `src/main/cloud/desktop-sync-client.js` with mobile-scan actions.
- Continue exposing the flow through `window.mia.cloudLogin(...)` rather than adding a broad new renderer escape hatch.
- Keep the renderer/main split narrow: `src/shared/ipc-channels.js` -> `src/preload.js` -> `src/main.js` -> `desktop-sync-client.js`.

Desktop UI has two responsibilities:

1. `账号与同步` renders the QR card.
2. The main renderer shell owns the approval modal so it can appear even when the user is not actively looking at the settings tab.

The approval UI should reuse the app's existing lightweight in-app dialog pattern rather than opening a native OS modal.

Desktop request detection should stay simple:

- While cloud login is enabled, the renderer polls `window.mia.cloudLogin({ action: "mobile-scan-pending" })` on a short interval.
- When a new pending request appears, show the confirmation modal.
- If the user clicks `允许`, call `window.mia.cloudLogin({ action: "mobile-scan-decision", requestId, decision: "approve" })`.
- If the user clicks `取消`, call the same path with `deny`.

Closing the confirmation modal should behave like `取消` so request state is explicit and does not linger invisibly.

## Mobile Design

The mobile login screen should be restructured around scanning first.

Primary path:

- Add camera-based QR scanning support for the login screen.
- The initial screen is the scanner, not the WeChat QR image.
- On successful scan, parse the URL:
  - verify it is a Mia mobile-scan URL
  - extract `grant`
  - derive `apiBase` from the scanned origin
- Call `/api/auth/mobile-scan/request`.
- Switch to a simple waiting state and poll `/api/auth/mobile-scan/complete`.
- On `approved`, call the existing `setSession({ token, user, apiBase })`.

Fallback path:

- Keep the existing WeChat login flow inside a collapsed `其他登录方式` section.
- Do not show the WeChat block by default.
- Do not make `打开微信` the primary button anymore.

Permission behavior:

- Request camera permission when the screen opens.
- If permission is denied, show a simple empty state:
  - `请开启相机以扫描桌面二维码`
  - primary action: open system settings
  - secondary weak action: `其他登录方式`

## Failure Handling

Mobile should handle only these user-visible terminal errors:

- invalid code: `这不是 Mia 登录码`
- expired grant: `二维码已过期，请在电脑上刷新`
- denied request: `电脑端已取消本次登录`
- used or already consumed code: `这个二维码已经用过了，请重新生成`
- network failure: `网络异常，请重试`

All of these errors should stay inside the login surface and return the user to a state where they can scan again or open `其他登录方式`.

Desktop should handle:

- expired pending request: dismiss the modal if still open
- lost cloud auth: hide the QR card and stop pending-request polling
- start failure: show a concise error inside the QR card instead of a separate flow

## Testing

Unit tests should cover:

- grant lifecycle: create, invalidate previous, expire, consume once
- request lifecycle: create, approve, deny, expire, reject duplicate or reused requests
- cloud API auth boundaries:
  - desktop `start`, `pending`, and `decision` require auth
  - mobile `request` and `complete` are anonymous but only accept valid state transitions
- desktop sync client action dispatch for `mobile-scan-start`, `mobile-scan-pending`, and `mobile-scan-decision`
- mobile login screen states:
  - permission denied
  - successful scan -> waiting
  - approval success
  - denied request
  - expired code
  - invalid QR
  - collapsed and expanded `其他登录方式`
- desktop renderer states:
  - QR card visible only when cloud account is enabled
  - approval modal appears for a pending request
  - allow and deny actions clear the modal correctly

## Non-Goals

- Do not replace the existing desktop WeChat login flow.
- Do not add PIN entry, device trust, or persistent allowlists in this pass.
- Do not add photo-album QR import for the new primary mobile path.
- Do not persist grants or requests to the database.
- Do not redesign unrelated account or sync settings surfaces.
