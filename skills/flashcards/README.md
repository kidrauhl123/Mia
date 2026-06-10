# Generating STEM Flashcards

A Claude skill for generating atomic, cognitively-principled flashcards from technical source material.

## What It Does

Upload lecture notes, textbooks, or technical documentation. Get flashcards organised into three cognitive layers, delivered as an interactive artifact, an Anki-ready TSV file, or pushed directly to Anki via MCP:

| Layer | Tests | Example |
|-------|-------|---------|
| **L1: Recall** | Facts, definitions, formulas | "Define the Jacobian matrix" |
| **L2: Understanding** | Why/how, intuitions | "Why is the Jacobian useful for coordinate transforms?" |
| **L3: Boundaries** | Limitations, edge cases | "When does the Jacobian become singular?" |

The skill enforces atomicity (one concept per card), refuses to generate cards for inappropriate content (proofs, worked examples), and handles mathematical notation (KaTeX for Claude Artifacts, MathJax for Anki).

---

## Why This Skill?

Most AI flashcard generators produce low-quality cards: compound questions, no cognitive framework, no quality control.

This skill encodes learning science directly into generation:

- **Bloom's Taxonomy** → Three-Layer Structure
- **Cognitive Load Theory** → Atomicity Rules
- **Minimum Information Principle** → Refusal Policy

See [THEORY.md](THEORY.md) for the full scientific foundation with citations.

---

## Table of Contents

- [What It Does](#what-it-does)
- [Why This Skill?](#why-this-skill)
- [Installation](#installation)
- [Usage](#usage)
- [Best Practices](#best-practices)
  - [Claude Projects](#projects)
  - [Complementary Skills](#complementary-skills)
- [Output](#output)
  - [Interactive Artifact](#interactive-artifact-default)
  - [Anki TSV Import](#anki-tsv-import)
  - [Anki Direct Push (via MCP)](#anki-direct-push-via-mcp)
- [File Structure](#file-structure)
- [License](#license)

---

## Installation

### Quick Install (recommended)

1. Download `flashcards-vX.X.X.zip` from the [latest release](https://github.com/jalliet/flashcards/releases/latest)
2. Upload to Claude.ai: **Settings > Capabilities > Skills > Upload Skill**

That's it.

---

## Usage

### Basic

Upload a PDF, paste lecture notes, or describe a topic:

> "Generate flashcards spanning topics from all the project files."

> "Create flashcards covering gradient descent, including failure modes"

> "Make revision cards for chapters 3-5 of the uploaded PDF"

### With Layer Filtering

> "Generate only L3 (boundary) cards for this material"

> "Focus on L1 recall cards for definitions and formulas"

### Iterative Refinement

> "Card 12's formula is missing the inverse; fix it"

> "Split card 7 into two separate cards"

> "Add more L2 cards for the eigenvalue section"

---

## Best Practices

### Projects

Create a Claude Project for your course/subject. Add:

1. The skill (upload the `.zip` from releases via "Add Content" > "Upload Skill")
2. Your lecture notes & transcripts, readings, exercise sheets, solution sheets
3. Project instructions like: "Always use the flashcard skill when I ask for revision materials". You could also place this instruction in Claude's global default instructions at **Settings** > **General** > **What personal preferences should Claude consider in responses?**


### Complementary Skills

For best results with complex documents, also install from directly inside the Claude Desktop app or at [anthropics/skills](https://github.com/anthropics/skills):

| Skill | Why |
|-------|-----|
| `pdf` | Better extraction from scanned/complex PDFs |
| `docx` | Preserves formatting from Word documents |
| `frontend-design` | Improves React artifact rendering and styling for academic content in Artifact Mode|

The flashcard skill works without these, but they improve source parsing.

---

## Output

<details open>
<summary><strong>Interactive Claude Artifact (default)</strong></summary>

An interactive and shareable Claude Artifact component with:

- Layer filtering (L1/L2/L3 tabs)
- Topic filtering
- Star/favourite cards
- Shuffle mode
- Responsive design

**[View Example Artifact](https://claude.ai/public/artifacts/6c97797f-3b9d-4245-a5b5-5a4d5da02fcf)**

</details>

<details>
<summary><strong>Anki TSV Import (Manual)</strong></summary>

The exported `.txt` file can be imported directly into Anki. You have two options:

#### Option 1: Quick Import (Basic note type)

Import the file as-is using Anki's built-in **Basic** note type. You get Front/Back cards with layer and topic info in the Tags column. No setup required, just **File → Import** and go.

#### Option 2: Advanced Import (using a custom note type)

For styled cards with a layer badge on the front and topic metadata on the back, create a custom note type first:

1. Open Anki → **Tools → Manage Note Types**
2. Click **Add** → choose **Add: Basic** → name it **"3-Layer Card"**
3. Click **Fields...** and add two new fields: **Layer** and **Topic** (Front and Back already exist)
4. Click **Cards...** and paste the templates below into the corresponding editors
5. Click **Save**

Then import: **File → Import** → select the `.txt` file → choose **"3-Layer Card"** as the note type → verify the 5-column field mapping → **Import**.

<details>
<summary><strong>Front Template</strong> (paste into front template editor)</summary>

```html
<div class="layer-badge">{{Layer}}</div>
<div class="question">{{Front}}</div>
```

</details>

<details>
<summary><strong>Back Template</strong> (paste into back template editor)</summary>

```html
{{FrontSide}}
<hr id="answer">
<div class="answer">{{Back}}</div>
<div class="metadata">
  Topic: {{Topic}}
</div>
```

</details>

<details>
<summary><strong>Styling</strong> (paste into styling editor)</summary>

```css
.card {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  font-size: 20px;
  text-align: center;
  color: #1a1a1b;
  background-color: #ffffff;
  padding: 20px;
}

.layer-badge {
  display: inline-block;
  padding: 6px 14px;
  border-radius: 4px;
  font-size: 0.8em;
  font-weight: 600;
  margin-bottom: 20px;
  background: #f0f0f0;
  color: #555;
}

.question {
  font-size: 1.1em;
  margin: 30px 0;
  line-height: 1.5;
}

.answer {
  margin: 30px 0;
  line-height: 1.6;
  text-align: left;
}

.metadata {
  margin-top: 25px;
  padding-top: 15px;
  border-top: 1px solid #e0e0e0;
  font-size: 0.8em;
  color: #888;
}

hr#answer {
  border: none;
  border-top: 2px solid #e0e0e0;
  margin: 20px 0;
}
```

</details>

</details>

<details>
<summary><strong>Anki Direct Push (via MCP)</strong></summary>

With the [Anki MCP Server addon](https://ankiweb.net/shared/info/124672614) by [anatoly314](https://github.com/anatoly314), cards are created directly in Anki, including automatic note type and deck setup. No file export or manual import.

> "Push these flashcards directly to my Anki"

> "Send the cards to my STEM deck in Anki"

### Prerequisites & Setup

To use this mode, you need the Anki MCP Server addon and a properly configured MCP client (e.g. Claude Desktop).

#### 1. Install the Anki MCP Server addon

| Resource | Link |
|----------|------|
| AnkiWeb addon page | [ankiweb.net/shared/info/124672614](https://ankiweb.net/shared/info/124672614) |
| GitHub repo | [github.com/ankimcp/anki-mcp-server-addon](https://github.com/ankimcp/anki-mcp-server-addon) |
| Project homepage | [ankimcp.ai](https://ankimcp.ai/) |

1. **Anki 25.x or later** must be installed and running
2. In Anki: **Tools → Add-ons → Get Add-ons...** → enter code `124672614` → restart Anki
3. The MCP server auto-starts on `http://127.0.0.1:3141/` when Anki opens

Verify the server is running:

```bash
curl -s http://127.0.0.1:3141/ \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"initialize","id":1,"params":{"capabilities":{},"clientInfo":{"name":"test"},"protocolVersion":"2024-11-05"}}'
```

You should get a JSON response containing `"serverInfo"`, which confirms the server is running.

#### 2. Configure Claude Desktop

The addon uses **Streamable HTTP** transport. Claude Desktop requires `mcp-remote` to bridge stdio ↔ HTTP.

Edit your Claude Desktop config file:

- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

Add the `"anki"` entry under `"mcpServers"`:

```json
{
  "mcpServers": {
    "anki": {
      "command": "/bin/bash",
      "args": [
        "-c",
        "npx -y mcp-remote http://127.0.0.1:3141/ --allow-http"
      ]
    }
  }
}
```

Restart Claude Desktop. You should see **anki: running** in the MCP server indicator (🔌 icon).

> **Node.js ≥ 20** is required. `mcp-remote` depends on `undici` which needs Node 20.18.1+. If you hit connection errors, see [Troubleshooting](#mcp-troubleshooting).

#### 3. What the skill auto-configures

The skill will automatically create the **"3-Layer Card"** note type and target deck if they don't exist. No manual Anki configuration needed beyond installing the addon and connecting Claude Desktop.

<details>
<summary><strong>Troubleshooting</strong></summary>

If the MCP connection between Claude Desktop and Anki isn't working, work through these steps in order.

#### 1. Verify the Anki MCP Server is running

Make sure Anki is open first, then test the server from a terminal:

```bash
curl -s http://127.0.0.1:3141/ \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"initialize","id":1,"params":{"capabilities":{},"clientInfo":{"name":"test"},"protocolVersion":"2024-11-05"}}'
```

If you get a JSON response with `"serverInfo"`, the server is healthy. If you get `connection refused`, the addon isn't loaded; check **Tools → Add-ons** in Anki and restart.

#### 2. Check your Node.js version

`mcp-remote` depends on `undici@7.x`, which requires **Node.js ≥ 20.18.1**. Check your version:

```bash
node --version
```

If it's below v20, install a newer version. With [nvm](https://github.com/nvm-sh/nvm):

```bash
# If nvm isn't found, load it first:
export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh"

nvm install 22
nvm use 22
node --version  # should show v22.x
```

#### 3. macOS: Claude Desktop doesn't inherit your shell environment

macOS GUI apps don't see shell-only tools like `nvm`. Even if `node --version` shows v22 in your terminal, Claude Desktop may still use an older Node.

**Fix:** Use an absolute path or a `/bin/bash` wrapper in your config to explicitly set `PATH`:

```json
{
  "mcpServers": {
    "anki": {
      "command": "/bin/bash",
      "args": [
        "-c",
        "export PATH=$HOME/.nvm/versions/node/v22.22.0/bin:$PATH && npx -y mcp-remote http://127.0.0.1:3141/ --allow-http"
      ]
    }
  }
}
```

Replace `v22.22.0` with your actual installed Node version. Find it with:

```bash
ls ~/.nvm/versions/node/
```

**Alternative:** Claude Desktop has a **"Use Built-in Node.js for MCP"** toggle under **Settings → Extensions**. Enabling this can bypass the PATH issue entirely.

#### 4. Clear the stale npx cache

If you upgraded Node but `mcp-remote` still crashes, the npx cache may contain a build from the old Node version:

```bash
rm -rf ~/.npm/_npx/*
```

Then restart Claude Desktop. The package will be re-downloaded and built against the correct Node version.

#### 5. Common error messages

| Error | Cause | Fix |
|-------|-------|-----|
| `Server disconnected` | Node.js too old, or stale cache | Steps 2–4 |
| `ReferenceError: File is not defined` | Node < 20 (missing `File` global) | Upgrade Node (step 2) |
| `"command" Required` | Claude Desktop doesn't support `"url"` transport | Use the `mcp-remote` bridge config (step 3) |
| `connection refused` on curl | Anki not running or addon not installed | Step 1 |

#### 6. Still stuck?

- Check the [addon GitHub issues](https://github.com/ankimcp/anki-mcp-server-addon/issues) for known problems
- View Claude Desktop MCP logs: **Help → Diagnostics → MCP Log**
- Claude Desktop log files are at `~/Library/Logs/Claude/` (macOS)

</details>

</details>

---

## File Structure

```
flashcards/
├── README.md                   # This file
├── THEORY.md                   # Scientific foundations (Bloom, CLT, etc.)
├── SKILL.md                    # Main skill instructions
├── references/
│   ├── COGNITIVE_LAYERS.md     # L1/L2/L3 definitions
│   ├── ATOMICITY.md            # Quality rules, refusal policy
│   └── LATEX_SYNTAX.md         # KaTeX reference
├── anki/
│   ├── WORKFLOW.md             # TSV export build steps
│   ├── MCP_WORKFLOW.md         # MCP direct push steps
│   ├── RENDERING.md            # MathJax delimiter rules
│   ├── IMPORT_GUIDE.md         # User-facing import instructions (TSV only)
│   └── NOTE_TYPE_TEMPLATE.md   # Note type, templates, and CSS
├── artifact/
│   ├── WORKFLOW.md             # Artifact build steps
│   ├── RENDERING.md            # KaTeX rendering rules
│   └── template.jsx            # React artifact template
└── assets/
    └── flashcard_template.jsx
```

**Note**: Only the skill files inside `flashcards/` (SKILL.md, references/, anki/, artifact/) are packaged in releases. README.md and THEORY.md are GitHub documentation only. Releases are built automatically via GitHub Actions when a version tag is pushed.

---

## License

MIT
