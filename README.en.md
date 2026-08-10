# Mia

Treat a roomful of AIs like coworkers.

Mia is a desktop app that puts Claude, Codex, Hermes and other AI tools into one chat window. No app switching, no commands to memorize — just talk to them like you would on a messenger, and they get things done.

Bot identities are Cloud-backed account objects. Runtime labels such as `desktop-local` and `cloud-claude-code` describe where a Bot run executes; they are not separate local-vs-cloud Bot identities.

## What it does

- **Chat is the entry point.** Friends, group chats, message history — except some of your "friends" happen to be AIs.
- **AIs as coworkers, not black boxes.** Each Bot has a name, avatar, persona, skills and permissions. @-mention whoever you need.
- **AIs that actually touch your machine.** Writing code, reading files, running commands, generating images — they always ask first. If you don't approve, they don't move.
- **Synced across devices.** Desktop, web and phone all work. Pick up wherever you left off.
- **Official IM entry points.** Publish an existing Bot to Feishu, a WeChat Official Account, or WeChat ClawBot. The WeChat account that completes ClawBot QR login becomes the sole permitted direct-message sender automatically; users never have to find or type an opaque WeChat ID. QR login, tokens, cursors, and reply context remain in the bound desktop Core; the cloud stores the conversation plus routing and durable delivery state, but never those credentials. The first release supports text direct messages.

## Who it's for

- People who want AIs to feel like teammates you can call on, instead of starting from a blank chat every time.
- People already using Claude Code, Codex and similar CLIs who want one GUI for all of them.
- People who want AI to do real work, but only after explicit approval for anything sensitive.

## Get started

- macOS (Apple Silicon): [Download DMG](https://mia.gifgif.cn/downloads/mia-macos-apple-silicon-latest.dmg)
- macOS Intel: [Download DMG](https://mia.gifgif.cn/downloads/mia-macos-intel-latest.dmg)
- Windows x64: [Download installer](https://mia.gifgif.cn/downloads/mia-windows-latest.exe)
- Web: <https://mia.gifgif.cn>

On first launch, Mia scans Hermes, Claude Code and Codex. If none is available, it automatically prepares a managed Claude Code runtime in Mia's private app-data directory; it does not overwrite your global CLI or change your PATH. Then choose a local or cloud setup and start chatting with your first Bot.

## FAQ

**How is this different from the ChatGPT desktop app?**
Mia isn't a single-model client. It brings multiple AIs into one chat surface so you can pick the right one for the job — and let them work together.

**Does my conversation go to the cloud?**
Accounts, friends, groups, Bot identities and conversations sync through the cloud so you can switch devices. When an AI runtime reads your local files or runs commands through `desktop-local`, that execution stays on your machine.

**Do I need to know how to code?**
No. Mia provides the chat, identity, sync and permission layer. Claude Code and Codex reuse local CLIs when present, while Hermes remains an explicit runtime setup. On a first run with no local engine, Mia can prepare its private managed Claude Code runtime without changing global system configuration.

---

> Looking for technical details or want to contribute? See `CLAUDE.md` and `AGENTS.md`.
