# Bot Runtime Reply Recovery Design

Status: ready for user review.

## Context

Desktop-local bot conversations currently combine three regressions:

- the renderer sends `targetIntent` and `controlIntent`, while the Cloud runtime
  endpoint only reads `config` and replaces the stored config wholesale;
- Electron resolves Cloud-owned desktop bindings through a local Core bot lookup,
  even when the bot identity only exists in Cloud;
- a non-mock runtime plan with no launch command can return an empty successful
  response after the user message has already been persisted.

The visible result is one failure chain: the binding loses engine/device/model
metadata, runtime controls disappear, send becomes blocked by the empty model
catalog, and an accepted turn can finish without an assistant message or a
visible error.

This repair is a focused compatibility slice. It does not attempt to complete
the broader AION-style native ACP session migration.

## Considered Approaches

### 1. Cloud-only hotfix

Teach the Cloud endpoint to retain existing config when receiving an intent.
This prevents future corruption, but leaves the silent runtime response and the
catalog-gated composer behavior intact.

### 2. Targeted end-to-end repair (selected)

Fix the contract at the Cloud boundary, make Electron use the canonical Cloud
binding for Cloud-owned bots, make a missing runtime command an explicit
failure, and decouple send availability from selector catalogs. This is the
smallest approach that addresses every observed symptom.

### 3. Full AION runtime lifecycle port

Port AION's task manager, native ACP session lifecycle, stream relay, recovery,
and configuration handshake now. This is the long-term direction already
covered by the Rust native ACP design, but is too broad for this regression.

## Design

### Cloud runtime contract

Add a focused pure Cloud helper for runtime intent application. The Cloud `PUT
/api/me/bots/:id/runtime` route will use the same semantics as Rust Core:

- a legacy request with only `config` remains a full replacement;
- a request containing `targetIntent`, `syncIntent`, or `controlIntent` starts
  from the existing binding config;
- `config` is merged as a patch before applying intents;
- target intent updates engine/device fields without deleting unrelated model
  or permission fields;
- changing engine clears incompatible model-selection fields;
- control intent updates only the requested model, effort, or permission field;
- the resulting config is sanitized once before persistence.

This keeps Cloud and Core compatible without moving more business logic into
the already-wide Cloud entry file.

Existing corrupted rows will not infer an engine from a partner display name.
Lost data cannot be reconstructed safely. They remain visibly repairable via
the existing runtime-target selector, and the next explicit target save writes
a valid binding through the repaired endpoint.

### Binding ownership at the Electron boundary

Desktop-local message assembly for a Cloud-owned bot will resolve the binding
through the compatibility lookup that prefers Cloud and only falls back to
Core. It will not treat an unrelated default Core bot binding as authoritative.
Explicit per-send runtime controls remain the highest-precedence overrides.

### Runtime failure contract

A runtime plan is executable only when it has a command or is an intentional
mock plan with a mock response. A Native ACP plan with neither is an error.

The Cloud Bridge route will:

- release the conversation runtime claim;
- return a non-success response;
- never return `ok: true` with empty text and no assistant message for this
  condition.

The existing renderer send pipeline already marks its optimistic outgoing
message as failed when the post returns an error. This repair makes the Core
condition reach that established visible failure path.

### Composer controls

Selector availability is presentation state, not send readiness:

- only an explicit Core `sendBlocked` response disables send;
- loading or an empty `modelOptions` list does not disable send;
- a missing model list shows a disabled `使用 CLI 模型` control;
- missing effort and permission choices show their selected value when known,
  otherwise a disabled `CLI 默认` control;
- a selector becomes interactive only when Core supplies choices.

This follows AION's read-only fallback behavior while preserving Mia's engine
policy and existing control-save API.

## Testing

Use red-green cycles for each boundary:

1. Cloud API integration: seed a complete Codex binding, send only an effort
   control intent, and prove engine/device/model/permission are retained.
2. Cloud API compatibility: prove a legacy full `config` request still replaces
   the old config.
3. Electron adapter: prove a Cloud-owned desktop bot reads the Cloud binding
   before the local Core fallback.
4. Rust Core: prove a Native ACP plan with no command and no mock response
   returns an error and releases its runtime claim.
5. Renderer: prove empty control catalogs render read-only fallbacks and do not
   block send, while explicit `sendBlocked` still blocks it.
6. Run the focused Cloud, preload/renderer, and Rust Core suites, followed by
   `npm run check` if the focused suites pass.

## Non-Goals

- No deployment, release, signing, or production-data mutation.
- No inference of a lost engine from bot names.
- No reintroduction of `npx`, `codex exec`, or other ACP fallbacks.
- No broad port of AION task-manager or stream-relay modules in this repair.
- No unrelated cleanup of the current Rust migration worktree.
