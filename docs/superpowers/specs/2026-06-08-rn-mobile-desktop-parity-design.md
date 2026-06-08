# RN Mobile Desktop Parity Design

Status: planning baseline. This document defines the React Native mobile parity target for Mia 0.1.3 before implementation planning.

## Goal

Mia Mobile should be a native iOS and Android client that reproduces the logged-in Electron desktop experience from Mia 0.1.3 on a small screen. The mobile app is not a simplified chat client and not a separate product surface. It should expose the same account data, the same conversation model, the same Bot and Agent concepts, the same permission workflow, and the same operational states as the desktop app.

The canonical reference is the Electron desktop app at package version `0.1.3`, current local baseline commit `7d2cbc3` (`fix(onboarding): 设置引导界面用窄小窗口展示 + bump 0.1.3`).

## Non-Goal

Mia Mobile must not reproduce the desktop pre-login and local-runtime startup path. The mobile app opens into Mia Cloud login and then renders account data.

Mobile does not probe local `PATH`, detect local Hermes / Claude Code / Codex CLIs, start local Agent runtimes, register LaunchAgents, or perform Electron-specific onboarding. Local execution remains a desktop responsibility. Mobile can display and operate desktop-connected state through Cloud / Bridge when the account has a desktop device online.

## Product Rule

"One-to-one parity" means functional, state, information hierarchy, and operation parity. It does not mean pixel-level desktop layout copying.

Desktop panes become mobile navigation stacks, tabs, sheets, drawers, and bottom panels. A desktop operation can move to a long press, overflow menu, sheet, or dedicated screen, but it cannot disappear.

## Architecture Direction

The only mobile app entry is `apps/mobile-rn/`. Web responsive views remain browser surfaces and are not the mobile app reference.

React Native should own native presentation and navigation. Shared protocol and product semantics must live behind shared modules or typed API adapters:

- Conversation kinds, sender kinds, message rows, permission decisions, trace shape, send pipeline, unread state, avatar and group tile logic should come from `packages/shared` or explicit mobile adapters.
- React Native must not import `src/renderer`, `src/web`, or desktop implementation files directly.
- Desktop-only behavior should be mapped to Cloud / Bridge API operations instead of copied into mobile.

## Current RN Inventory

The existing `apps/mobile-rn` app is an Expo / React Native project with real product scaffolding, not a blank app.

Implemented or partially implemented today:

- Auth: `LoginScreen` supports server URL, login, register, busy state, error display, and session persistence through `expo-secure-store`.
- Navigation: `RootNavigator` switches between login and a tab app; current tabs are Messages, Contacts, and Me.
- Data access: React Query fetches conversations, messages, members, Bots, friends, and full current-user profile from Mia Cloud APIs.
- Realtime: the events provider uses the shared Cloud events client, tracks WebSocket status, merges appended/deleted messages, and handles Cloud Agent approval events.
- Conversation list: list items aggregate conversations, resolve Bot / friend / self / group avatars, fetch DM/group members, support pull refresh, and show unread values when provided.
- Chat: `ChatScreen` fetches messages and members, renders an inverted message list, sends optimistic messages, reconciles or marks failure, supports copy/resend/delete actions, and includes the approval sheet.
- Message rendering: `MessageBubble` supports Markdown, code fences, pending/failed states, long press, and a basic trace block.
- Approval: `ApprovalSheet` supports deny / allow once / allow always and posts decisions to the Cloud run approval route.
- Contacts: `ContactsScreen` lists friends and Bots with resolved avatars.
- Account: `MeScreen` shows current user identity, avatar, API base, and logout.
- Shared logic/tests: mobile has Jest coverage for approval queue, avatar, client, conversation list, events, normalize message, optimistic send, send pipeline, and session history.

Not implemented today:

- Mobile destinations for Agents, Skills, Tasks/Runs, Bot detail/edit/capabilities, group detail, friend request actions, model/provider settings, effort selection, permission mode defaults, attachments, notifications, and full settings.
- Native iOS/Android rendered QA evidence for the 0.1.3 desktop parity target.

## Mobile Information Architecture

The first parity implementation should contain these mobile surfaces:

- `AuthStack`: Cloud login and account creation.
- `MessagesStack`: conversation list, conversation detail, session/history selector, message search and context actions.
- `ContactsStack`: friends, friend requests, groups, Bot contacts, Bot detail, Bot edit and Bot capabilities.
- `AgentsStack`: runtime/device/Bot status, active runs, permission waits, desktop Bridge state, task/run history.
- `SkillsStack`: skill library, skill detail, enable skill on Bot.
- `SettingsStack`: account/sync, appearance, model/provider settings, permission defaults, bridge/cloud status.
- Global overlays: permission approval sheet, composer option sheets, model selector, attachment picker, message action sheet, runtime/offline banner.

The exact tab count can change during implementation, but every surface above must remain reachable without relying on hidden developer-only paths.

## Desktop Parity Matrix

| Area | Desktop reference | Required RN equivalent | Current RN state | Parity gap | Acceptance |
| --- | --- | --- | --- | --- | --- |
| Cloud auth | Web/Cloud account login and desktop synced account state | Login, register, persisted token, restore session, logout, account error states | `LoginScreen` has server URL, login/register, busy/error states; `AuthProvider` persists token in SecureStore | Needs parity copy, validation polish, account recovery/error state coverage | Fresh install opens login; valid account loads account data; logout clears session; invalid credentials show actionable error |
| App shell | Desktop main shell after startup, sidebar/workspace/settings/task surfaces | Native root navigator with all logged-in desktop surfaces reachable | `Tabs` has Messages / Contacts / Me only | Missing Agents, Skills, Settings depth, runtime/status surfaces | User can reach every desktop 0.1.3 logged-in surface from mobile navigation |
| Conversation list | Desktop conversation/sidebar card rendering, unread, pins, preview, active state | Conversation list with same ordering, unread, pins, titles, avatars, conversation type indicators, status preview | `ConversationListScreen` fetches conversations/Bots/friends/me, fetches members for DM/group, resolves avatars/group tiles, supports pull refresh | No search, pin management, active run/status summary, rich metadata, complete unread source, error states | List matches desktop account data and ordering; unread/pin/status states are visible and actionable |
| Conversation context menu | Desktop right-click and overflow actions | Long press / overflow sheet for pin, hide/delete, rename where supported, open related detail | Not present | Need mobile action mapping | Every desktop row action has a mobile equivalent |
| Chat message stream | Desktop message bubbles, Markdown, code blocks, streaming, deleted/hidden states | Native message list with desktop-equivalent rendering and states | `ChatScreen` fetches messages/members, renders inverted list, sends optimistic messages; `MessageBubble` supports Markdown, code fences, pending/failed, basic trace | Needs streaming state, code block polish, attachment rendering, deleted/hidden, system messages, grouping/time/status | Same conversation renders the same semantic message content as desktop |
| Message actions | Desktop message menu and social message menu | Long press action sheet for copy, reply where supported, delete/hide, retry, inspect trace/source where supported | `MessageActions` supports copy, resend for failed, delete/hide | Needs reply, inspect trace/source, per-message availability, desktop social action coverage | Long pressing every message type exposes the same allowed operations as desktop |
| Composer | Desktop composer with text input, add button, model, effort, permission controls | Native composer with text input, add/attachment, model selector, effort selector, permission mode selector, send state | Basic input + send exists | Most desktop composer controls missing | User can configure the same send-time controls before sending on mobile |
| Model selection | Desktop model/provider quick switch and model settings | Model/provider selector with icons, current model label, unavailable states, settings handoff | Not present | Need model catalog API/data path and native UI | Selected model matches desktop account/runtime state and persists through shared settings |
| Effort selection | Desktop effort options by engine | Effort selector with engine-specific values and labels | Not present | Need shared engine options and UI | Effort state can be viewed/changed with same allowed values as desktop |
| Permission mode | Desktop permission mode selector and labels | Permission mode selector and current label in composer/settings | Approval decision constants exist; no default permission mode UI/state | Need mode state, options, persistence | Mobile can view/change default permission mode and send runs with same mode semantics |
| Tool / trace rendering | Desktop trace, reasoning, tools, collapsible blocks | Native collapsible trace/tool/reasoning blocks inside messages | `TraceBlock` renders reasoning/tools as a basic collapsible chip | Needs desktop parity for all trace block types, tool states, long content, copy/expand affordances | Tool calls and reasoning visible with same collapsed/expanded semantics as desktop |
| Permission approval | Desktop approval UI for Agent tool decisions | Global bottom sheet + approval inbox for allow once / always / deny and queued requests | Events provider queues `cloud_agent_run_event` approval requests; `ApprovalSheet` posts deny/allow once/always | Needs queue visibility, per-conversation routing, stale/error states, decision failure feedback | Incoming approval blocks user visibly; decisions post to Cloud/Bridge and update in real time |
| Bot contacts | Desktop Bot contact list, Bot detail, engine badge, pin/edit/delete, message | Bot list/detail with avatar, engine, bio, capabilities, edit/delete/pin, start chat | `ContactsScreen` lists Bots with avatars and "智能体" subtitle only | Need Bot-specific detail/actions/capability UI | A desktop Bot profile can be fully viewed and managed on mobile |
| Friends and requests | Desktop social friends, friend requests, DM | Friends list, request inbox, accept/reject, open DM | `useFriends` and `ContactsScreen` list friends with avatars | Need request inbox, accept/reject, open DM, friend actions | Friend request lifecycle matches desktop behavior |
| Groups | Desktop group list/info/dialog, group avatar, members, group chat | Group list/detail, member list, group avatar, open group chat, group info actions | Not complete | Need group info and member operations | Existing desktop group can be inspected and used from mobile |
| Bot creation/edit | Desktop Bot dialog/directory/store flows | Native create/edit Bot forms for name, avatar, bio, prompt/persona, engine, capabilities | Not present | Need full forms and validation | A Bot created/edited on mobile appears equivalent on desktop |
| Bot capabilities | Desktop per-Bot skills/capabilities panel | Native capability panel and skill toggles | Not present | Need skill library linkage and Bot save flow | Enabling/disabling skills on mobile changes the same Bot capabilities as desktop |
| Skills library | Desktop skill library, skill cards, use-on-Bot actions | Skill library tab/stack with details and enable-on-Bot action | Not present | Need skill catalog API/query and native UI | User can browse and assign skills with the same data as desktop |
| Tasks / runs | Desktop task panel and Agent run state surfaces | Agents/Tasks screen showing active runs, waits, failures, completion, history | Not present | Need API/state wiring and UI | Mobile can see what desktop shows as active/past task or run state |
| Runtime / Bridge status | Desktop runtime/engine/Cloud/Bridge status surfaces | Device and bridge status screen, offline/reconnect banners, per-Bot runtime labels | `ConnBanner` only | Need device/runtime details and failure states | User can tell whether account, Cloud, desktop Bridge, and relevant Agent paths are available |
| Attachments | Desktop chat attachments and materialization | Image/file picker, upload, attachment preview, message attachment rendering | Not present | Need native file/image selection and Cloud upload path | Files/images sent from mobile show correctly on desktop and vice versa |
| Appearance | Desktop appearance settings | Mobile settings for appearance values that affect shared account/UI where applicable | Not present | Need account settings read/write and native mapping | Shared appearance settings are visible and persisted without breaking mobile readability |
| Account/sync settings | Desktop account, Cloud sync, logout, device/bridge info | Account settings, sync status, logout, device status | `MeScreen` shows avatar, username, API base, and logout | Needs full account details, sync status, device/Bridge status, settings rows | Mobile shows same account identity and sync/device health as desktop |
| Provider/model settings | Desktop provider/model settings | Mobile settings for account-scoped model/provider config supported by Cloud, plus read-only visibility for desktop-local provider state | Not present | Need Cloud-backed editor and read-only desktop-local status presentation | Mobile exposes Cloud-backed provider settings; desktop-local secrets remain desktop-only but their availability/status is visible |
| Error and empty states | Desktop recoverable errors, empty lists, loading states | Native loading/error/empty states for every screen | Minimal | Need systematic state coverage | No major screen appears blank or silently fails under loading/offline/error data |
| Notifications | Desktop visual state plus mobile-specific alerting | Push/local notification surface for messages, approvals, task completions | Not present | Need native notification design | iOS/Android can notify for parity-critical blocking events |

## Implementation Phases

Phases are internal only. Public "first version" should not ship until the parity matrix above is complete enough for the 0.1.3 desktop baseline.

### Phase 1: Navigation And Data Coverage

Create every required mobile surface and wire read-only data for conversations, messages, Bots, friends, groups, skills, tasks/runs, settings, bridge status, and account state.

Success means no desktop 0.1.3 logged-in surface lacks a mobile destination.

### Phase 2: Chat And Agent Workflow Parity

Complete chat rendering, composer controls, trace/tool rendering, permission mode, approval queue, message actions, streaming/realtime states, and attachment rendering.

Success means a normal Agent conversation can be followed and operated from mobile without returning to desktop for UI reasons.

### Phase 3: Management Parity

Complete Bot create/edit/delete/pin, Bot capabilities, skill assignment, friends/requests, groups, settings, and account/device status.

Success means account management and Bot/skill management no longer require desktop for supported Cloud-backed operations.

### Phase 4: Native Mobile Completeness

Add iOS/Android push notifications, deep links, keyboard handling, file/image pickers, platform permission prompts, safe-area polish, and parity QA screenshots.

Success means iOS and Android feel like native small-screen Mia clients, not a reduced web/chat wrapper.

## Data Flow

Mobile starts with Cloud auth and token persistence. After login, React Query and WebSocket event subscriptions hydrate and update all account state. Mutating operations go through Cloud APIs. Desktop-local effects are requested through Cloud / Bridge and reflected back through event streams.

Mobile never assumes it can execute local Agent work itself. It can start or control work only through account-scoped Cloud/Bridge APIs.

## Testing And Acceptance

Every parity item should have one or more of:

- Shared logic tests in `packages/shared` or `apps/mobile-rn/src/logic`.
- Screen/component tests for native UI state where feasible.
- API/adapter tests for Cloud contract handling.
- Manual iOS and Android screenshots for navigation, chat, composer, approval, settings, and error states.
- Cross-client smoke: create or mutate data on desktop, verify mobile; mutate on mobile, verify desktop.

The parity matrix is the release gate. A row can be marked done only when desktop 0.1.3 behavior is identified, the mobile equivalent exists, the shared state or API path is verified, and iOS/Android rendering has been checked.

## Decisions

- RN is the only mobile app path.
- Desktop 0.1.3 logged-in Electron experience is the canonical reference.
- Web responsive UI is not the mobile reference.
- Mobile starts at Cloud login and does not do desktop local Agent detection.
- One-to-one parity means capability and state parity, not desktop pixel layout parity.
