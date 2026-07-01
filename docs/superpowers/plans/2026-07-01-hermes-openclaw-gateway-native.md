# Hermes/OpenClaw Gateway-Native Plan

## Goal

Move Mia's Hermes and OpenClaw integrations toward native gateway/session ownership while preserving Mia's product layer:

- multiple bot personas
- per-bot and per-conversation memory isolation
- per-conversation agent session isolation
- model, effort, and permission controls in the composer
- conversation/history switching in the chat UI
- scheduler, skills, MCP, attachments, permissions, and streaming events

Mia remains the IM/product gateway and source of visible conversation truth. Hermes/OpenClaw own native runtime context for active agent execution.

## References

### AION

AION's ACP path warms a native runtime for each conversation, then sends current-turn events and renders runtime stream events. Model, mode, and thought-level changes are applied through runtime config APIs rather than prompt text. When a new conversation is created from an existing one, ACP session fields are cleared so the new conversation does not inherit stale native context.

Mia adoption:

- keep model/effort/permission as runtime controls, not prompt text
- bind native session ids to Mia conversation ids
- clear or regenerate native session bindings when a Mia conversation is forked or reset
- keep response stream, tool, permission, and status events mapped through Mia's existing UI event vocabulary

### LobsterAI

LobsterAI's Cowork layer is the product/session abstraction, while OpenClaw is a swappable runtime. Its OpenClaw adapter sends `chat.send` to Gateway, converts gateway events into product events, applies `sessions.patch` for runtime changes, and treats gateway-not-ready as an explicit error instead of silently falling back. It also uses managed session keys such as `agent:{agentId}:lobsterai:{sessionId}` and only bridges visible history when native history is missing.

Mia adoption:

- use stable native session keys derived from `engine + botId + Mia conversation session`
- apply model/effort/permission through native session metadata or patch APIs where supported
- reject unsafe fallback paths by default
- bridge a bounded visible-history snapshot only for compatibility/fork recovery, not every normal turn
- add prompt/context telemetry before broader rollout

## Target Architecture

```text
Mia conversation DB
  owns visible messages, chat switching, search, titles, UI history

Mia bot runtime binding
  owns selected engine, model, effort, permission, skills, MCP, scheduler scopes

Mia native-session store
  maps engine + botId + conversation session -> native session key/id

Hermes/OpenClaw Gateway
  owns agent runtime context, tool execution, native memory/session lifecycle
```

## Isolation Rules

- Persona scope: `botId` is always passed as native profile/persona key.
- Session scope: native session keys must include the Mia bot and conversation session.
- Memory scope: Mia memory stays scoped by `botId + sessionId`; native memory must not become a global shared store unless it is wrapped by a Mia scope.
- Group scope: each bot in a group gets an independent native session; group context is event/session metadata, not shared agent state.
- Runtime controls: model, effort, and permission remain per bot/runtime binding and must still be applied on the turn.

## Phases

### Phase 1: Stop Replaying History On Native Sessions

- Hermes: default persistent bot turns to native session history; do not send `conversation_history`.
- Hermes: remove explicit `hermesHistoryMode: "bridge"` compatibility behavior; only non-persistent one-shot turns may bridge visible history.
- OpenClaw: keep ACP/Gateway as the default path; local embedded fallback remains explicit only.
- Tests: prove history policy, runtime control preservation, and OpenClaw fallback guard.

### Phase 2: Runtime Context Budget Telemetry

Add per-turn debug metrics:

- engine
- bot id
- session id
- native session id/key
- current user chars
- system/persona chars
- memory chars
- skill index chars
- loaded skill chars
- visible history chars included
- attachment count/bytes

This must be diagnostic only and must not log secrets or full prompt bodies.

### Phase 3: Gateway-Native Session Patching

- Hermes: prefer native run/session config for model, effort, and permission where the Hermes API supports it.
- OpenClaw: continue syncing Mia-managed model provider config and agent profile, but move per-turn model changes toward `sessions.patch`/session metadata when available.
- Keep existing composer controls unchanged.

### Phase 4: Memory And Skills As Scoped Resources

- Keep Mia memory as the authoritative scoped store.
- Expose memory through scoped MCP/resource access instead of injecting full memory blocks every turn.
- Keep skills index lightweight and load full skill bodies only on explicit activation or engine request.

### Phase 5: Fork, Reset, And History Switching

- Chat history switching must not switch native session by accident.
- Forked/new conversations must get a new native session binding unless the user explicitly resumes a native session.
- Recovery bridge may inject a bounded summary/recent-turn bridge once when native history is missing.

## Current Phase 1 Changes

- Hermes run payload now accepts `includeConversationHistory`.
- Hermes chat adapter defaults persistent sessions to native history and disables `conversation_history`.
- Hermes native run session ids now default to `mia:{botId}:{conversationSession}` so multiple personas and group bots do not share a runtime session by accident.
- Hermes keeps an explicit compatibility scope (`hermesSessionScope: "conversation"`) for older conversation-only native sessions.
- Explicit bridge mode and non-persistent turns still preserve compatibility history.
- OpenClaw existing branch work already disables implicit local fallback for Mia-managed models and uses Gateway/ACP session keys for normal turns.

## Current Phase 2 Changes

- Added `src/main/agent-context-budget.js` for structured context budget logging without prompt bodies.
- Hermes logs per-turn budget fields: engine, bot, session, native session, history mode, native history flag, submitted prompt chars, current user chars, system chars, memory chars, skill index chars, loaded skill chars, visible history chars, included history chars, and attachment stats.
- OpenClaw logs the same budget shape and records visible history as observed-but-not-injected (`includedHistoryChars=0`) for native ACP/CLI turns.
- Tests assert that budget logs do not contain user text, memory text, persona text, or skill body text.
- Tests assert OpenClaw does not inject prior visible messages into the ACP prompt while still sending the current user turn.

## Current Phase 4 Changes

- Added `src/main/native-skill-context.js` to make skill index injection native-session aware.
- Hermes/OpenClaw persistent native sessions now inject the available skill index once per `engine + bot + native session + index fingerprint`.
- Explicitly loaded skill bodies still inject on every turn so composer skill chips and internal `LOAD_SKILL` retries keep working.
- Non-persistent turns and `skillIndexMode: "always"`/`nativeSkillIndexMode: "always"` preserve legacy every-turn skill index injection.
- `skillIndexMode: "none"`/`nativeSkillIndexMode: "none"` can disable skill index injection for gateways that expose skills through native resources.
- Budget telemetry reports actual injected skill index chars, so repeated native turns show `skillIndexChars=0` while loaded skill chars remain visible.
- Added `src/main/native-memory-context.js` to make Mia memory injection native-session aware while keeping Mia as the authoritative memory store.
- Hermes/OpenClaw still read memory through `memoryBlock({ botId, sessionId })`, preserving Mia's per-bot and per-conversation memory scope.
- Persistent native sessions now inject the Mia memory block on first use and whenever the bounded memory block changes; repeated unchanged turns do not resend the same memory.
- Non-persistent turns and `memoryInjectionMode: "always"`/`nativeMemoryInjectionMode: "always"` preserve legacy every-turn memory injection.
- `memoryInjectionMode: "none"`/`nativeMemoryInjectionMode: "none"` can disable prompt memory injection for gateways that expose Mia memory through native resources or MCP.
- Budget telemetry reports actual injected memory chars, so repeated unchanged native turns show `memoryChars=0`.

## Current Phase 5 Changes

- Native memory and skill index caches are keyed by engine, bot id, and native conversation session, so chat history switching and multiple personas do not share injected context state.
- Helper tests prove that identical memory/skill content reinjects for a different bot id or a different conversation session.
- OpenClaw `openclawResetSession: true` now invalidates native memory/skill injection caches for that session before sending the reset turn.
- OpenClaw adapter tests prove reset turns pass `resetSession: true` to ACP and reinject Mia memory plus skill index after the native session has been reset.
- New/forked Mia bot conversations already receive independent native context because Hermes session ids default to `mia:{botId}:{conversationSession}` and OpenClaw ACP session keys include `openclaw:mia:{botId}:{conversationSession}` (or `agent:{agentId}:mia:{botId}:{conversationSession}` for Mia-managed OpenClaw).

## Current Phase 6 Changes

- OpenClaw context injection now uses the same native key shape as the actual ACP session key, including the Mia-managed `agent:{agentId}:mia:{botId}:{conversationSession}` prefix and the MCP fingerprint.
- This prevents a same Mia conversation from incorrectly skipping context injection after switching between default OpenClaw sessions and Mia-managed OpenClaw agent sessions.
- Added `src/main/native-persona-context.js`; OpenClaw now injects Mia runtime/persona context on first use of a native session and whenever the persona block changes, instead of sending the same persona block every turn.
- `openclawResetSession: true` also invalidates persona injection state, so reset turns rebuild persona, memory, and skill index context together.
- Budget telemetry now reports OpenClaw `nativeSession` and separates `personaChars` from `memoryChars`, making 16k-prompt regressions easier to spot without logging prompt bodies.
- Tests cover native persona isolation, reset reinjection, changed-only persona injection, and context reinjection when the actual ACP session key changes.

## Current Phase 7 Changes

- Added a local daemon/Core read-only `GET /api/mia/context` route guarded by the existing daemon token.
- Added a built-in `mia-app` MCP tool named `context_snapshot` that resolves the current MCP `{ botId, sessionId, originMessageId }` context and reads the scoped Mia context through the daemon route.
- The context snapshot returns the current bot id, conversation session id, origin message id, generated timestamp, persona text, and Mia memory block scoped by `botId + sessionId`.
- Both Electron main and node Core wire this route to the same Mia-owned stores (`botManifest.readBotPersona` and `miaMemoryService.memoryBlock`) instead of letting the MCP server read local stores directly.
- This creates the native tool/resource path needed to move future Hermes/OpenClaw turns from prompt-injected memory/persona toward gateway-native context reads while keeping Mia's multi-persona and session isolation.
- Tests cover daemon authorization, Core runtime persona/memory reads, MCP tool exposure, and existing OpenClaw/Hermes/runtime-control regressions.

## Current Phase 8 Changes

- Added `src/main/native-context-snapshot.js` for a shared native context mode: `auto` is now the default, `prompt` keeps the compatibility path, `mcp`/`context_snapshot` forces Mia's scoped tool path, and `none` disables native context injection.
- Hermes auto-selects `context_snapshot` when `mia-app` MCP is available from the runtime bridge; otherwise it falls back to the existing prompt memory path. Electron main and Core now pass `getMiaAppMcpSpec` into the Hermes adapter so the adapter can make this decision per turn.
- OpenClaw now delays prompt construction until after ACP initialization/newSession has produced the real `mcpServers` list. If the session includes the built-in `mia-app` server, default `auto` uses the small `context_snapshot` instruction instead of prompt-injecting Mia runtime/persona and memory text; if ACP cannot provide per-session MCP, default `auto` falls back to the prompt path.
- In `context_snapshot` mode, Mia still writes the current `{ botId, sessionId, originMessageId }` MCP context before the turn, so the native agent can only read the persona and memory for the current Mia bot and conversation.
- Prompt injection remains available for compatibility and as a fallback while Gateway/MCP support is rolled out engine by engine, and can be forced with `nativeContextMode: "prompt"` / engine-specific context mode keys.
- Tests cover Hermes preserving model/effort/permission controls in `context_snapshot` mode, Hermes/OpenClaw auto-selecting scoped MCP when available, OpenClaw adding the built-in `mia-app` MCP server for the scoped session, and both engines avoiding direct persona/memory prompt injection in that mode.

## Non-Goals For Phase 1

- Do not redesign renderer controls.
- Do not replace Mia memory storage.
- Do not remove visible conversation history from Mia.
- Do not force cloud Hermes behavior until local gateway-native behavior is stable.
