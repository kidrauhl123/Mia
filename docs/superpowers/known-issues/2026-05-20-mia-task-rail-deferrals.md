# Mia Task Rail — Deferred Issues

Tracked from Codex adversarial review on 2026-05-20 (commit range `29d91e6..HEAD` on `main`). The following issues were not fixed before push; they are intentional deferrals or acceptable risk for V1.

## Tracked

| Severity | Issue | File:Line | Plan |
|---|---|---|---|
| Critical (acc. risk) | `tasks-store` has no lock/version check on read-modify-write. Daemon is currently the only writer, so race is theoretical for V1. | `src/main/tasks-store.js:80-164` | Add file lock or per-task mutex if a second writer (e.g., direct desktop edits) is ever introduced. |
| Critical (acc. risk) | `runRemoteChatRequest` captures `history` before `await sendChat()` and the original write is overwrite-style. Concurrent writes to the same session can drop messages. A reload-then-append attempt (commit `8b46069`) actually dropped messages for newly-created sessions (new session not yet on disk → fresh-store lookup missed it → saved store excluded the session entirely). Reverted in commit `1eaf24d` back to in-memory append. | `src/main.js:runRemoteChatRequest` | Real fix: serialize per-session chat writes via a mutex/queue, or persist new sessions to disk in `resolveRemoteChatSession` before the await so reload-then-append works. |
| Important | `runNow` calls `fireRunner.fire()` directly, bypassing the scheduler's per-task `inflight` set. Manual "run now" while a scheduled run is in progress can overlap. | `src/main.js:initSchedulerSubsystem` | Move `inflight` into `createFireRunner` so all fire entry points share it. |
| Important | Scheduler awaits one task's `onFire` before scheduling the next due task — a slow fire delays every other task globally. | `src/main/scheduler.js:fireAndReschedule` | Reschedule before awaiting the fire work; serialize only per task id. |
| Important | `mia-scheduler` MCP server is created but not registered with the bridge — `schedule.*` tools are unreachable from Claude Code / Codex. | `src/main.js:initSchedulerSubsystem` TODO | Implement stdio MCP server contract and register via the existing `ensureClaudeBridgePlugin` path (or via plugin.json `mcpServers`). |
| Important | All task-detail input fields share one debounced save — quick edits across fields can overwrite earlier pending patches. | `src/renderer/app.js:attachTaskDetailHandlers` | Merge pending patches into a single object before flushing, or use independent debouncers per field. |
| Minor | `taskAt` datetime input throws on invalid/empty values via `new Date(value).toISOString()`. | `src/renderer/app.js:taskAt input handler` | Guard before calling `.toISOString()`. |
| Minor | `pause` / `resume` routes don't wrap `store.pause/resume` in try/catch — missing tasks become 500 instead of 404. | `src/main/tasks-routes.js:75-86` | Add try/catch returning 400 on error. |
| Minor | Route regex matches raw `req.url` (not pathname). Query strings or percent-encoded IDs would break tasks routing. | `src/main/tasks-routes.js:handle` | Parse `new URL(req.url, base).pathname` first. |
| Minor | `Access-Control-Allow-Methods` advertises only `GET, POST, OPTIONS` while task API uses `PATCH` and `DELETE`. Doesn't affect Electron localhost calls but would fail from a browser context. | `src/main.js:writeControlJson` | Add `PATCH, DELETE`. |

## Spec gap

| Severity | Issue | File:Line | Plan |
|---|---|---|---|
| Important | `orphanBySession` exists in store but no IPC handler calls it. Mia currently doesn't expose per-session deletion. | `src/main/tasks-store.js:131` | When a per-session delete IPC is added, call `orphanBySession(sessionId)` from that handler. |

## Test gaps

- `sweepExpiredOneshotTasks` has no test coverage. Function is correctness-critical (V1 §9). Consider adding a test that creates an expired oneshot, runs the sweep, asserts status → failed.
- SSE reconnect logic (`subscribeDaemonTaskEvents`) has no test for backoff or auth-failure cases.
- `callDaemonTasks` IPC<->HTTP wrapper has no failure-mode tests.
