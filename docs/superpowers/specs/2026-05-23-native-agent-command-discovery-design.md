# Native Agent Command Discovery Design

## Context

Mia currently supports slash commands through two separate paths:

- Hermes commands are loaded from Hermes' own command registry through `telegram_menu_commands(100)`, so the composer suggestions mostly reflect the engine's native command list.
- Claude Code and Codex commands are loaded from Mia's hard-coded `externalAgentBuiltInCommands` plus Claude custom command files under `.claude/commands`. This list is incomplete, so native commands such as Claude Code `/goal` can execute when typed manually but do not appear in the slash-command suggestions.

The desired behavior is that users who type `/` in a Claude Code, Codex, or Hermes fellow see the commands that engine actually supports. Mia should not maintain a fake exhaustive list of another engine's native commands.

## Goals

1. Prefer native command discovery for slash-command suggestions.
2. Preserve execution of native commands even when Mia does not have a custom renderer for them.
3. Keep Mia-specific wrappers explicit and minimal.
4. Let commands such as `/resume` return an in-chat selectable list when Mia can provide a better GUI affordance than the terminal picker.
5. Avoid brittle terminal TUI embedding or screen scraping.

## Non-Goals

- Do not implement a full terminal emulator for Claude Code or Codex pickers.
- Do not claim every CLI subcommand is a chat slash command.
- Do not block native command execution just because a command is missing from Mia's suggestion cache.
- Do not redesign Hermes `/goal`; Hermes already supports it through the gateway path.

## Reference Findings

### AionUi

AionUi handles session resume at the ACP session layer. It stores an ACP session id and resumes by calling `resumeSession()`. Claude-style resume uses `_meta.claudeCode.options.resume`; other ACP backends use `resumeSessionId`. AionUi also receives and caches available slash command updates, but it avoids rendering those updates directly into chat because they are noisy.

Useful pattern: engine/session-layer resume and command capability caching.

Not directly reusable: chat-message command result UI.

### ClaudeCodeUI

ClaudeCodeUI intercepts slash commands in the composer and executes a small set of built-ins itself. It scans `.claude/commands` and `~/.claude/commands` for Claude custom commands. It also indexes Claude and Codex session history for resume flows.

Useful pattern: command execution route and session indexers for Claude/Codex history.

Gap: it does not implement `/goal` or `/resume` as native in-chat selectable command results.

## Design

### Command Sources

Mia will load commands from a prioritized set of sources:

1. Native engine discovery.
2. Engine custom command directories or extension points.
3. Mia bridge commands.
4. Last-resort fallback commands when discovery fails.

For Claude Code:

- Use `@anthropic-ai/claude-agent-sdk` `supportedCommands()` as the primary source.
- Continue scanning project and user `.claude/commands` for custom commands.
- Keep Mia bridge entries only for commands whose GUI behavior is intentionally different or richer, such as a structured `/resume` list.

For Codex:

- Use any stable SDK or local state capability that becomes available for native chat commands.
- Until Codex exposes a `supportedCommands()` equivalent, use a small version-tolerant curated native list for known chat commands and thread abilities, clearly marked as `source: "native-curated"`.
- Do not treat all `codex --help` top-level subcommands as chat slash commands. `codex resume` and `codex fork` are CLI commands; they can inform Mia wrappers but should not automatically appear as `/resume` and `/fork` unless Mia implements that chat behavior.

For Hermes:

- Continue using Hermes' registry-backed loader.
- Preserve current gateway execution behavior.
- Structured UI can be added later without changing discovery.

### Command Model

Each loaded command should normalize to:

```js
{
  command: "/goal",
  description: "Set a goal",
  engine: "claude-code",
  source: "native" | "native-curated" | "custom" | "mia" | "fallback",
  type: "native" | "custom" | "bridge",
  argumentHint: "<condition>",
  metadata: {}
}
```

Deduplication is by `(engine, command)`.

Priority order:

1. Mia bridge, only when it intentionally wraps the native command.
2. Native discovery.
3. Custom command files.
4. Curated native fallback.
5. Generic fallback.

When a bridge and native command share a name, the bridge must preserve the native command's user-facing meaning. For example, `/resume` may show Mia's selectable session list, but selecting a row must resume/bind the underlying external session rather than doing an unrelated Mia-only action.

### Execution Flow

Composer suggestions are advisory, not authoritative. A user may type any slash command manually.

Execution flow for Claude Code and Codex:

1. If the command is a recognized Mia bridge, execute the bridge.
2. If the command is a recognized custom command file, expand and submit it as today.
3. Otherwise pass the slash command through to the native engine.

This keeps commands such as Claude Code `/goal` working even if discovery fails.

Execution flow for Hermes:

1. Send slash commands through `runHermesSlashCommand()` as today.
2. Later, selected Hermes responses may be upgraded to structured command results.

### Structured Command Results

Plain text remains the default command result. Mia may return structured results for commands where GUI interaction is materially better than terminal text:

```js
{
  kind: "command-result",
  command: "/resume",
  engine: "claude-code",
  content: "Choose a session to resume.",
  blocks: [
    {
      type: "session-list",
      rows: [...]
    }
  ],
  actions: [...]
}
```

Initial structured targets:

- `/resume` for Claude Code and Codex: show recent sessions in the chat bubble and let the user select one.
- `/commands` or `/help`: show the loaded command registry with source labels.

`/goal` should first be made discoverable and passed through natively. A structured `/goal` UI can be added later if the engine exposes stable state/action APIs.

### Session Listing for `/resume`

Mia can build session lists from local engine state:

- Claude Code: scan `~/.claude/projects` and `~/.claude/history.jsonl`.
- Codex: scan `~/.codex/sessions` and `~/.codex/session_index.jsonl`.
- Hermes: use Hermes session APIs or current gateway/session store if needed later.

Rows should include title, preview, last active time, cwd/project when available, and external session/thread id. Selecting a row updates the current Mia session's external agent binding and confirms in chat.

### Error Handling

- If native command discovery fails, log the failure and fall back to the minimal curated list for that engine.
- If a listed native command fails during execution, show the native error as a chat message.
- If a bridge command needs local state that cannot be read, show a concise recovery message and keep typed command passthrough available where safe.
- If a command has destructive or account-level effects, do not execute it as a chat bridge without explicit confirmation.

### Testing

Unit coverage:

- Command merge and dedupe priority.
- Claude Code native command normalization, including `/goal`.
- Fallback behavior when native discovery fails.
- Composer filtering by active engine.
- Passthrough behavior for slash commands that are not Mia built-ins.

Integration coverage:

- Claude Code fellow: typing `/` includes native commands from `supportedCommands()`.
- Claude Code fellow: manual `/goal` still reaches native execution.
- Codex fellow: suggestions come from the Codex command provider, not Hermes fallback.
- Hermes fellow: existing command suggestions and command execution still work.

Manual verification:

- Type `/` under Hermes, Claude Code, and Codex fellows and compare source labels.
- Type `/goal` under Claude Code and Codex and confirm it executes even if no structured renderer is involved.
- Type `/resume` and verify the in-chat list appears once the bridge is implemented.

## Implementation Order

1. Introduce a command-provider layer in the main process.
2. Replace Claude/Codex hard-coded suggestion loading with provider-based discovery.
3. Add Claude Code `supportedCommands()` discovery.
4. Add Codex curated native provider with clear source metadata.
5. Preserve custom `.claude/commands` scanning.
6. Update renderer command menu to display normalized command rows.
7. Add structured command-result rendering for `/resume`.
8. Add session indexers for Claude Code and Codex resume lists.
9. Add tests around discovery, passthrough, and bridge execution.

