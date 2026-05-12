# Aimashi

Aimashi is a fresh Electron desktop app for an app-owned Hermes runtime.

This demo intentionally does not inspect, modify, or reuse a user's existing
Hermes installation. On first launch it creates its own runtime area under the
app data directory:

```text
~/Library/Application Support/Aimashi/runtime/
  hermes-engine/
    README.md
    .venv/
      ...
  engine-home/
    config.yaml
    SOUL.md
    api-server.key
    fellows/
      manifest.json
      aimashi.fellow.json
      aimashi.md
    souls/
      aimashi.md
```

`fellows/` is the product-facing structure. Each Fellow has metadata in
`<id>.fellow.json` and a persona seed in `<id>.md`. `souls/` is a compatibility
mirror for older Hermes/Aimashi layouts.

## Run

From Finder on macOS, double-click:

```text
open-aimashi.command
```

Or run from a terminal:

```bash
npm install
npm start
```

## Current Demo Scope

- Creates a private Aimashi runtime home from zero.
- Seeds a default Fellow manifest, metadata file, and persona seed.
- Installs the official NousResearch Hermes source archive into Aimashi's private runtime.
- Starts/stops the private Hermes API server on an available loopback port.
- Sends chat through Hermes `POST /v1/runs` plus `GET /v1/runs/{run_id}/events` SSE, with `fellow_key`, `account_id`, `route_profile`, and `X-Aimashi-Fellow`.
- Provides a desktop UI for model presets, API key storage, OpenAI Codex OAuth, chat, and adding Fellows.
- Keeps model credentials inside Aimashi's private runtime. Existing Hermes installs are not read.

By default, Aimashi installs Hermes from the official NousResearch repository
archive, without using the local `hermes-team-dev` checkout:

```bash
python3.11 -m venv ~/Library/Application\ Support/Aimashi/runtime/hermes-engine/.venv
~/Library/Application\ Support/Aimashi/runtime/hermes-engine/.venv/bin/python -m pip install --upgrade \
  "hermes-agent[web] @ https://github.com/NousResearch/hermes-agent/archive/main.tar.gz"
```

Aimashi requires Python 3.11 or newer for the official Hermes package. It will
try `python3.13`, `python3.12`, `python3.11`, then `python3`. Override the
interpreter with:

```bash
AIMASHI_PYTHON=/path/to/python3.11 npm start
```

Pin a specific official branch, tag, or commit with:

```bash
AIMASHI_ENGINE_REF=<tag-or-commit-sha> npm start
```

Aimashi defaults to the official `web` extra because the desktop app needs the
local Hermes API server. Override extras when building a broader Hermes bundle:

```bash
AIMASHI_ENGINE_EXTRAS=all npm start
```

For local Hermes development only, override the official package install with a
source checkout:

```bash
AIMASHI_ENGINE_SOURCE=/path/to/hermes-agent npm start
```

## Use

1. Launch the app with `npm start`.
2. Wait for the Runtime status to show a running local Hermes API.
3. In Model, choose a preset such as xAI, Anthropic, OpenRouter, OpenAI Codex OAuth, DeepSeek, Gemini, or LM Studio.
4. Paste the API key for an API-key provider and save, or use the OpenAI Codex panel to sign in through the browser with a ChatGPT/Codex subscription account.
5. Chat with the current Fellow or create a new Fellow from the right-side editor.

Aimashi starts Hermes through `python -m aimashi_plugins gateway run`. The
plugin layer loads `engine-home/fellows/<id>.md` from the current
`X-Aimashi-Fellow` header and injects it into vanilla Hermes without modifying
Hermes core. Chat sessions use Hermes run IDs and structured SSE events
internally, while the current renderer still receives a compatibility
`choices[0].message.content` response.

OpenAI Codex OAuth uses Hermes's `openai-codex` provider and stores tokens in
Aimashi's private `engine-home/auth.json`, not in the user's existing Hermes
home.

A packaged product should pin an official package version or vendor a signed
official build artifact instead of depending on a developer machine path.
