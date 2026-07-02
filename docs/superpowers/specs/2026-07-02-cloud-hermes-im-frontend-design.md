# Cloud Hermes IM Frontend Design

## Scope

This design applies only to Mia Cloud conversations whose runtime binding is `cloud-hermes`. The local desktop AgentSession/AION alignment plan remains separate and should not be changed by this work.

Mia Cloud should treat Hermes as the agent platform and Mia as the IM frontend. Hermes owns agent sessions, model/provider execution, tools, skills, memory, transcript persistence, approval state, and runtime artifacts. Mia owns user accounts, bot membership, visible conversation rows, push/broadcast, message ordering, and attachment delivery into Mia clients.

## Source Of Truth

The alignment source is upstream `https://github.com/nousresearch/hermes-agent`, specifically the latest `origin/main` checked locally at:

- `/Users/jung/GitHub/mia-reference/hermes-agent/tui_gateway/server.py`
- `/Users/jung/GitHub/mia-reference/hermes-agent/tui_gateway/ws.py`
- `/Users/jung/GitHub/mia-reference/hermes-agent/apps/shared/src/json-rpc-gateway.ts`
- `/Users/jung/GitHub/mia-reference/hermes-agent/apps/desktop/src/hermes.ts`
- `/Users/jung/GitHub/mia-reference/hermes-agent/apps/desktop/src/app/session/hooks/use-prompt-actions/submit.ts`
- `/Users/jung/GitHub/mia-reference/hermes-agent/apps/desktop/src/app/session/hooks/use-message-stream/`
- `/Users/jung/GitHub/mia-reference/hermes-agent/web/src/lib/gatewayClient.ts`

The important upstream fact is that Hermes desktop and web surfaces do not use `/v1/runs` as the primary IM protocol. They use `tui_gateway` JSON-RPC over WebSocket. Client requests are JSON-RPC frames with `{ jsonrpc: "2.0", id, method, params }`. Streaming UI events arrive as `{ method: "event", params: { type, session_id, payload } }`.

## Problem

Mia Cloud currently drives Hermes through `src/cloud-agent/hermes-runs-client.js`, which creates `/v1/runs` and consumes `/v1/runs/{run_id}/events`. That path is useful for automation but is not Hermes' full IM client contract.

The observed failure mode in the cloud Mia conversation was consistent with this mismatch:

- The selected LaTeX skill was visible in Mia metadata, but Hermes did not get a reliable desktop-style skill/session UX.
- Hermes generated or attempted file work in a read-only/containerized environment, but Mia did not receive a first-class artifact delivery event.
- The next user turn asked for the file and Hermes could not reliably recover the prior context through the current `/v1/runs` path.

The cloud worker also runs with a read-only root and tmpfs-style constraints, so "install LaTeX now" style behavior is not a reliable artifact strategy. The IM integration must assume Hermes owns the agent state but Mia must explicitly bridge inputs, streaming events, approvals, and output artifacts.

## Target Architecture

Add a cloud-only Hermes IM adapter:

- `CloudHermesImClient`: connects to a worker's Hermes `tui_gateway` WebSocket endpoint and speaks JSON-RPC.
- `CloudHermesSessionBridge`: maps Mia `(userId, botId, conversationId)` to a Hermes session. It creates, resumes, and records the current Hermes runtime session id and stored session id.
- `CloudHermesEventBridge`: converts Hermes gateway events into Mia conversation events, trace blocks, approval prompts, and final assistant messages.
- `CloudHermesAttachmentBridge`: stages Mia message attachments into Hermes before `prompt.submit`.
- `CloudHermesArtifactBridge`: parses final assistant text for Hermes media/file references and archives deliverable files into Mia attachments.

`src/cloud-agent/dispatcher.js` should keep the `cloud-hermes` branch, but that branch should become a thin orchestrator around these bridges. It should stop self-materializing a parallel agent experience when Hermes already owns it.

## Protocol Choice

Primary path:

1. Ensure the cloud worker starts a Hermes backend exposing `tui_gateway` WebSocket, equivalent to the upstream `hermes serve` / `/api/ws` path.
2. Connect using a small Node JSON-RPC client modeled on `apps/shared/src/json-rpc-gateway.ts`.
3. Create or resume a session:
   - new conversation: `session.create`
   - existing mapped Hermes session: `session.resume`
4. Stage attachments through Hermes-native RPCs.
5. Send user input via `prompt.submit`.
6. Consume `method: "event"` frames until `message.complete`, `error`, or cancellation.

Compatibility path:

`/v1/runs` may remain behind a feature flag or fallback for workers that do not yet expose `tui_gateway`, but it should not be the default IM path. If fallback is used, Mia must pass explicit `conversation_history` or use `/api/sessions/{id}/chat/stream`; otherwise the current context-loss problem remains.

## Session Model

Mia keeps a durable mapping:

- `conversationId`
- `botId`
- `userId`
- `workerId`
- `hermesRuntimeSessionId`
- `hermesStoredSessionId`
- `lastSeenAt`

Hermes stored session is the agent transcript source. Mia visible messages remain the product transcript, but they are not replayed into Hermes on every turn.

If a worker restarts or loses live in-memory sessions, Mia should call `session.resume` with the stored Hermes session id. If resume succeeds and returns a new live session id, Mia updates the mapping and retries the pending `prompt.submit` once.

## Input Flow

For each user message:

1. Mia persists and broadcasts the user message as it does today.
2. The dispatcher resolves the bot's `cloud-hermes` binding and ensures a worker.
3. The session bridge creates or resumes the Hermes session.
4. The attachment bridge stages attachments:
   - image attachments: `image.attach_bytes` when Mia only has bytes/object storage; `image.attach` only when the file is already visible inside the worker.
   - non-image file attachments: `file.attach` with `data_url` when the worker cannot see the original path.
5. The submitted prompt text is built from:
   - Hermes returned attachment `ref_text` values such as `@file:...`
   - optional short Mia conversation context for bot identity/group roster
   - the user's message body
6. The IM client calls `prompt.submit`.

Mia should not inject the full visible conversation history. Hermes session persistence owns that.

## Event Mapping

Mia should map these Hermes events first:

- `session.info`: update trace/runtime metadata, model/provider labels, and running state.
- `message.start`: create an in-progress assistant response and clear stale per-turn state.
- `message.delta`: append assistant text to the in-progress response.
- `message.complete`: finalize the assistant response, parse artifacts, and persist the final Mia bot message.
- `thinking.delta`, `reasoning.delta`, `reasoning.available`: display in trace/reasoning surfaces, not as normal assistant text.
- `tool.start`, `tool.progress`, `tool.complete`, `tool.generating`: append ordered trace blocks.
- `approval.request`: create a Mia approval prompt tied to the Hermes session.
- `clarify.request`: create a Mia lightweight question prompt if the client supports it; otherwise persist as a system trace and let the next user reply act as normal text.
- `error`: fail the in-progress response with a visible error message.

The event bridge should keep event order stable and coalesce high-frequency deltas before broadcasting to clients, similar to Hermes' own WebSocket coalescing behavior.

## Approvals

Hermes approval events should remain Hermes-native. Mia should only render and answer them.

When Hermes emits `approval.request`, Mia stores a pending approval record with:

- Mia run/message id
- Hermes live session id
- request payload
- allowed choices

When the user responds, Mia calls `approval.respond` on the same Hermes gateway session. The UI choices should map to Hermes choices:

- allow once -> `once`
- allow session -> `session`
- always allow -> `always`
- deny -> `deny`

Mia should not resolve approvals by mutating worker files or bypassing Hermes' approval registry.

## Output Artifacts

Hermes API server does not send files for HTTP clients; its `send()` is intentionally a no-op. Therefore Mia must handle artifacts at the IM frontend layer.

For cloud Hermes IM, the artifact bridge should parse final assistant text for Hermes media/file references:

- `MEDIA:/absolute/path`
- quoted `MEDIA:"/path with spaces/file.pdf"`
- markdown links that point to worker-local deliverable paths
- plain worker-local absolute paths with known document/image/audio/video extensions

For each safe deliverable path, Mia copies the file from the worker's mounted user root or artifact directory into Mia Cloud attachment storage, then attaches it to the final bot message. The user-visible assistant text should remove raw `MEDIA:` directives and keep a clean mention of the delivered file.

If a referenced file does not exist, Mia should leave a trace warning and keep the assistant text. It should not silently replace the response with "file attached".

## Skills

Mia's skill market can still show and select Mia skills, but for `cloud-hermes` the runtime should prefer Hermes-native skill installation and execution semantics.

Short term:

- Mia may still pass selected skill context as an instruction prefix when no Hermes-native equivalent exists.
- Selected skills should be treated as user-facing hints, not as a parallel execution engine.

Medium term:

- The skill market for `cloud-hermes` should read Hermes `/v1/skills` or gateway-backed skill metadata when available.
- Installing a skill for a cloud Hermes bot should install or enable it in the worker's Hermes home, then reflect it in Mia.

## Non-Goals

- Do not change local desktop AgentSession/AION alignment in this design.
- Do not replace Mia Cloud conversations, message storage, or push/broadcast infrastructure.
- Do not implement a new generic AgentSession abstraction for every local engine here.
- Do not rely on apt-get or runtime package installation inside read-only cloud workers.
- Do not make `/v1/runs` the default cloud Hermes IM path.

## Failure Handling

- WebSocket connect failure: mark the turn failed with a concise error and keep the user message persisted.
- `session.resume` not found: create a new Hermes session only when no stored session can be recovered, and append a trace warning that Hermes context was reset.
- `prompt.submit` returns session-not-found: resume stored session and retry once.
- Attachment staging failure: fail the turn before `prompt.submit` if the attachment is essential to the user message; otherwise submit the text and leave a trace warning.
- Artifact copy failure: keep assistant text, add trace warning, and do not invent an attachment.
- Approval timeout: leave the Hermes turn pending until Hermes times out or user denies; Mia should not auto-approve.

## Testing

Unit tests should cover:

- JSON-RPC request/response and `method:"event"` parsing.
- `session.create` versus `session.resume` mapping behavior.
- `prompt.submit` retry after session-not-found.
- Event mapping for `message.delta`, `message.complete`, tool events, approval events, and errors.
- Attachment staging payloads for image bytes and non-image files.
- Artifact parsing for `MEDIA:` directives and plain paths.
- No full Mia visible history replay in the default `cloud-hermes` IM path.

Integration-style tests should use a fake Hermes gateway WebSocket server and a temporary worker filesystem. They should not call production Hermes, production Mia Cloud, or real third-party networks.
