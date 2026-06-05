const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const MIA_BRIDGE_COMMANDS = [
  {
    command: "/resume",
    name: "/resume",
    description: "在 Mia 聊天里选择并恢复外部 agent session",
    source: "mia",
    type: "bridge"
  }
];

const CODEX_CURATED_NATIVE_COMMANDS = [
  {
    command: "/goal",
    name: "/goal",
    description: "Set or inspect the current Codex goal",
    source: "native-curated",
    type: "native"
  }
];

function normalizeCommandName(value = "") {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return raw.startsWith("/") ? raw : `/${raw}`;
}

function normalizeCommandRow(item = {}, defaults = {}) {
  const command = normalizeCommandName(item.command || item.name);
  if (!command) return null;
  return {
    ...item,
    ...defaults,
    command,
    name: command,
    description: String(item.description || defaults.description || ""),
    argumentHint: String(item.argumentHint || item.argument_hint || defaults.argumentHint || ""),
    source: String(item.source || defaults.source || ""),
    type: String(item.type || defaults.type || "native")
  };
}

function mergeCommandRows(groups = []) {
  const rows = [];
  const seen = new Set();
  for (const group of groups) {
    for (const item of group || []) {
      const row = normalizeCommandRow(item);
      if (!row || seen.has(row.command)) continue;
      seen.add(row.command);
      rows.push(row);
    }
  }
  return rows;
}

function parseCommandFrontmatter(markdown = "") {
  const raw = String(markdown || "");
  if (!raw.startsWith("---\n") && !raw.startsWith("---\r\n")) return { data: {}, content: raw };
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { data: {}, content: raw };
  const data = {};
  for (const line of match[1].split(/\r?\n/)) {
    const item = line.match(/^\s*([A-Za-z0-9_-]+)\s*:\s*(.*?)\s*$/);
    if (!item) continue;
    let value = item[2] || "";
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    data[item[1]] = value;
  }
  return { data, content: raw.slice(match[0].length) };
}

function commandFromMarkdownFile(filePath, baseDir, namespace) {
  const content = fs.readFileSync(filePath, "utf8");
  const parsed = parseCommandFrontmatter(content);
  const relativePath = path.relative(baseDir, filePath);
  const command = `/${relativePath.replace(/\.md$/i, "").replace(/\\/g, "/")}`;
  const firstLine = parsed.content.trim().split(/\r?\n/)[0] || "";
  const description = String(parsed.data.description || firstLine.replace(/^#+\s*/, "").trim() || "自定义 Claude Code 命令");
  return {
    command,
    name: command,
    path: filePath,
    relativePath,
    description,
    namespace,
    source: "custom",
    type: "custom",
    metadata: parsed.data
  };
}

function scanAgentCommandsDirectory(dir, baseDir, namespace, appendEngineLog = null) {
  const commands = [];
  try {
    if (!fs.existsSync(dir)) return commands;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        commands.push(...scanAgentCommandsDirectory(fullPath, baseDir, namespace, appendEngineLog));
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        try {
          commands.push(commandFromMarkdownFile(fullPath, baseDir, namespace));
        } catch (error) {
          if (typeof appendEngineLog === "function") appendEngineLog(`Agent command parse failed: ${fullPath}: ${error.message}`);
        }
      }
    }
  } catch (error) {
    if (error.code !== "ENOENT" && error.code !== "EACCES" && typeof appendEngineLog === "function") {
      appendEngineLog(`Agent command scan failed: ${dir}: ${error.message}`);
    }
  }
  return commands;
}

function createAgentCommandProvider(deps = {}) {
  const normalizeBotAgentEngine = deps.normalizeBotAgentEngine || ((engine) => String(engine || ""));
  const shellCommandPath = deps.shellCommandPath || (() => "");
  const claudeAgentSdk = deps.claudeAgentSdk || null;
  const appendEngineLog = deps.appendEngineLog || null;
  const cwd = deps.cwd || (() => process.cwd());
  const homeDir = deps.homeDir || (() => os.homedir());

  function agentCommandRoots(engine, projectPath = cwd()) {
    const normalized = normalizeBotAgentEngine(engine);
    if (normalized !== "claude-code") return [];
    const roots = [];
    const project = String(projectPath || "").trim() || cwd();
    if (project) roots.push({ namespace: "project", root: path.join(project, ".claude", "commands") });
    roots.push({ namespace: "user", root: path.join(homeDir(), ".claude", "commands") });
    return roots;
  }

  async function loadClaudeNativeCommands(projectPath) {
    if (typeof claudeAgentSdk !== "function") return [];
    const commandPath = shellCommandPath("claude");
    if (!commandPath) return [];
    let queryResult = null;
    try {
      const sdk = await claudeAgentSdk();
      if (typeof sdk?.query !== "function") return [];
      queryResult = sdk.query({
        prompt: "/help",
        options: {
          cwd: String(projectPath || "").trim() || cwd(),
          maxTurns: 1,
          pathToClaudeCodeExecutable: commandPath
        }
      });
      const commands = typeof queryResult?.supportedCommands === "function"
        ? await queryResult.supportedCommands()
        : [];
      return (Array.isArray(commands) ? commands : [])
        .map((item) => normalizeCommandRow(item, { source: "native", type: "native" }))
        .filter(Boolean);
    } catch (error) {
      if (typeof appendEngineLog === "function") appendEngineLog(`Claude Code command discovery failed: ${error.message}`);
      return [];
    } finally {
      try { await queryResult?.interrupt?.(); } catch { /* ignore */ }
    }
  }

  function loadCustomCommands(engine, projectPath) {
    const custom = [];
    for (const root of agentCommandRoots(engine, projectPath)) {
      custom.push(...scanAgentCommandsDirectory(root.root, root.root, root.namespace, appendEngineLog));
    }
    return custom.sort((a, b) => a.command.localeCompare(b.command));
  }

  async function loadExternalAgentCommands(input = {}) {
    const engine = normalizeBotAgentEngine(input.engine);
    const projectPath = String(input.projectPath || cwd()).trim() || cwd();
    const native = engine === "claude-code"
      ? await loadClaudeNativeCommands(projectPath)
      : engine === "codex"
        ? CODEX_CURATED_NATIVE_COMMANDS.map((item) => ({ ...item, engine }))
        : [];
    const custom = loadCustomCommands(engine, projectPath).map((item) => ({ ...item, engine }));
    const bridge = MIA_BRIDGE_COMMANDS.map((item) => ({ ...item, engine }));
    const rows = mergeCommandRows([bridge, native.map((item) => ({ ...item, engine })), custom]);
    return { native, builtIn: bridge, bridge, custom, count: rows.length, rows };
  }

  return {
    agentCommandRoots,
    loadExternalAgentCommands
  };
}

module.exports = {
  MIA_BRIDGE_COMMANDS,
  CODEX_CURATED_NATIVE_COMMANDS,
  createAgentCommandProvider,
  mergeCommandRows,
  normalizeCommandRow,
  parseCommandFrontmatter,
  scanAgentCommandsDirectory
};
