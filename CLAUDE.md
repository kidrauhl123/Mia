# aimashi — Notes for Claude

## Reference projects

When designing chat UX, streaming, tool-use rendering, or multi-engine adapters, look at these first. They each cover the space from a different angle — read what's relevant, don't blindly copy.

### Open-source code references

**Cherry Studio** — Electron + React multi-provider chat client.
Local clone: `Alkaka-reference/cherry-studio`
Worth reading for: streaming architecture across many providers (Vercel AI SDK `fullStream` adapter), unified chunk schema, thinking/reasoning UI, MCP tool rendering, abort flow over Electron IPC.

**ClaudeCodeUI (siteboon/claudecodeui)** — React + Node.js web UI wrapping Claude Code / Cursor CLI / Codex / Gemini CLI.
Local clone: `Alkaka-reference/claudecodeui`
Worth reading for: one-file-per-CLI provider layout, `normalizeMessage` adapter pattern, agent status bar with rotating verbs, tool renderer routing.

**Telegram open source** — chat UX reference.
Not cloned. Main candidates: tdesktop (https://github.com/telegramdesktop/tdesktop, C++/Qt), telegram-web (https://github.com/Ajaxy/telegram-tt, TS/React).
Worth reading for: typing/recording/status indicator animations, message list virtualization, reply/quote/forward UX, animated stickers, polished chat-level details.

### UX references (closed-source, observe behavior)

**WeChat (微信)** — already partially modeled in alkaka-qt's WeChat-style UI.
Worth observing: session list density, narrow-window back-nav pattern, avatar+name+preview row, China-market conventions for chat surfaces.

**Codex desktop app** — OpenAI's Codex.app (Electron, `app.asar` internals previously inspected).
Worth observing: agent-style chat (long-running, tool-heavy), todo/plan rendering, avatar overlay system, status feedback during multi-step work.

**Claude desktop app** — Anthropic's Claude.app.
Worth observing: streaming token rendering, tool-use cards (inline, collapsible), project/files panel, code block UX.

### How to use this list

Treat the list as a starting point, not a spec. Pull the idea from wherever fits the current task — UI polish often lives in Telegram/WeChat/Claude; streaming + tool plumbing often lives in Cherry Studio / ClaudeCodeUI. When you find something worth remembering across sessions, add a one-line pointer here (file path + one-line "useful for").
