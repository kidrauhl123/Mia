const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { parseCommandFrontmatter } = require("./agent-command-provider.js");
const { listExternalAgentSessions: defaultListExternalAgentSessions } = require("./agent-session-index.js");
const { adapterForEngine } = require("./chat-engine-registry.js");

const EXTERNAL_AGENT_BUILT_IN_COMMANDS = [
  { command: "/help", name: "/help", description: "显示本地外部 Agent 命令帮助", namespace: "builtin", type: "builtin" },
  { command: "/clear", name: "/clear", description: "清空当前对话历史", namespace: "builtin", type: "builtin" },
  { command: "/model", name: "/model", description: "查看当前本地引擎模型", namespace: "builtin", type: "builtin" },
  { command: "/cost", name: "/cost", description: "查看本次 GUI 可见的用量信息", namespace: "builtin", type: "builtin" },
  { command: "/memory", name: "/memory", description: "查看当前项目 CLAUDE.md 记忆文件状态", namespace: "builtin", type: "builtin" },
  { command: "/config", name: "/config", description: "查看当前 Bot 的本地引擎配置入口", namespace: "builtin", type: "builtin" },
  { command: "/status", name: "/status", description: "查看本地 CLI、模型、权限和外部会话", namespace: "builtin", type: "builtin" },
  { command: "/permissions", name: "/permissions", description: "查看当前本地引擎权限", namespace: "builtin", type: "builtin" },
  { command: "/resume", name: "/resume", description: "把当前 Mia 会话绑定到指定外部 session", namespace: "builtin", type: "builtin" },
  { command: "/rewind", name: "/rewind", description: "提示如何回退当前对话", namespace: "builtin", type: "builtin" }
];

function isChildPath(parentPath, targetPath) {
  const parent = path.resolve(parentPath);
  const target = path.resolve(targetPath);
  const relative = path.relative(parent, target);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function commandInvocation(text = "") {
  const input = String(text || "").trim();
  const command = input.split(/\s+/)[0]?.toLowerCase() || "";
  const argText = input.slice(command.length).trim();
  const args = argText ? argText.split(/\s+/).filter(Boolean) : [];
  return { command, argText, args };
}

function agentSessionEntryId(entry) {
  if (!entry) return "";
  if (typeof entry === "string") return entry.trim();
  return String(entry.id || "").trim();
}

function looksLikeUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ""));
}

function localEngineInfoFor(engine, info = {}) {
  if (engine === "claude-code") return info.claudeCode || {};
  if (engine === "codex") return info.codex || {};
  return {};
}

function localEngineLabel(engine) {
  return adapterForEngine(engine).label || engine;
}

function defaultModelLabel(engine) {
  return `${localEngineLabel(engine)} 默认模型`;
}

function createExternalAgentCommandService(deps = {}) {
  const agentCommandProvider = deps.agentCommandProvider;
  if (!agentCommandProvider || typeof agentCommandProvider.loadExternalAgentCommands !== "function") {
    throw new Error("agentCommandProvider dependency is required.");
  }

  const cwd = typeof deps.cwd === "function" ? deps.cwd : () => process.cwd();
  const homeDir = typeof deps.homeDir === "function" ? deps.homeDir : () => os.homedir();
  const normalizeBotAgentEngine = deps.normalizeBotAgentEngine || ((engine) => String(engine || ""));
  const normalizeBotEngineConfig = deps.normalizeBotEngineConfig || (() => ({}));
  const normalizeEffortLevel = deps.normalizeEffortLevel || ((level) => String(level || "medium"));
  const localAgentEngines = deps.localAgentEngines || (() => ({}));
  const getAgentSessionId = deps.getAgentSessionId || (() => "");
  const enginePermissionMode = deps.enginePermissionMode || (() => "default");
  const setAgentSessionId = deps.setAgentSessionId || (() => {});
  const setAgentSessionEntry = deps.setAgentSessionEntry || (() => {});
  const loadAgentSessionMap = deps.loadAgentSessionMap || (() => ({}));
  const listExternalAgentSessions = deps.listExternalAgentSessions || defaultListExternalAgentSessions;
  const sourceDeviceId = deps.sourceDeviceId || (() => "");

  function agentCommandRoots(engine, projectPath = cwd()) {
    if (typeof agentCommandProvider.agentCommandRoots !== "function") return [];
    return agentCommandProvider.agentCommandRoots(engine, projectPath);
  }

  async function loadCommands(input = {}) {
    return agentCommandProvider.loadExternalAgentCommands(input);
  }

  function assertAllowedAgentCommandPath(commandPath, engine, projectPath = cwd()) {
    const resolved = path.resolve(String(commandPath || ""));
    if (!resolved || !fs.existsSync(resolved)) throw new Error("Command file not found.");
    const roots = agentCommandRoots(engine, projectPath).map((item) => path.resolve(item.root));
    if (!roots.some((root) => isChildPath(root, resolved))) {
      throw new Error("Command must be inside an allowed .claude/commands directory.");
    }
    return resolved;
  }

  function executeCommand(input = {}) {
    const engine = normalizeBotAgentEngine(input.engine);
    const command = String(input.commandName || input.command || "").trim().toLowerCase();
    const args = Array.isArray(input.args) ? input.args.map(String) : [];
    const projectPath = String(input.context?.projectPath || input.projectPath || cwd()).trim() || cwd();
    if (EXTERNAL_AGENT_BUILT_IN_COMMANDS.some((item) => item.command === command)) {
      const result = runSlashCommand({
        text: [command, ...args].join(" "),
        bot: input.context?.bot || {},
        engine,
        sessionId: input.context?.sessionId || ""
      });
      if (result && typeof result === "object" && !Array.isArray(result)) {
        return {
          type: "builtin",
          command,
          content: String(result.content || ""),
          commandResult: result.commandResult || null
        };
      }
      return {
        type: "builtin",
        command,
        content: result
      };
    }

    const commandPath = assertAllowedAgentCommandPath(input.commandPath, engine, projectPath);
    const raw = fs.readFileSync(commandPath, "utf8");
    const parsed = parseCommandFrontmatter(raw);
    let content = parsed.content;
    const argsString = args.join(" ");
    content = content.replace(/\$ARGUMENTS/g, argsString);
    args.forEach((arg, index) => {
      content = content.replace(new RegExp(`\\$${index + 1}\\b`, "g"), arg);
    });
    return {
      type: "custom",
      command,
      content,
      metadata: parsed.data,
      hasFileIncludes: content.includes("@"),
      hasBashCommands: content.includes("!")
    };
  }

  function externalAgentStatus({ bot, engine, sessionId }) {
    const info = localAgentEngines();
    const engineInfo = localEngineInfoFor(engine, info);
    const config = normalizeBotEngineConfig(bot.engineConfig);
    const model = config.model || defaultModelLabel(engine);
    const permission = enginePermissionMode(engine) || "default";
    const effort = normalizeEffortLevel(config.effortLevel || "medium", engine);
    const workspacePath = cwd();
    const externalSessionId = getAgentSessionId(engine, bot.key, sessionId, workspacePath) || "尚未创建";
    const label = localEngineLabel(engine);
    return [
      `${bot.name || "当前 Bot"} 使用 ${label} 本地引擎。`,
      `模型：${model}`,
      `推理强度：${effort}`,
      `权限：${permission}`,
      `CLI：${engineInfo?.path || "未检测到"}`,
      engineInfo?.version ? `版本：${engineInfo.version}` : "",
      `外部会话：${externalSessionId}`
    ].filter(Boolean).join("\n");
  }

  function miaConversationTitleForAgentBinding(localConversationId, bot) {
    const id = String(localConversationId || "").trim();
    const botKey = String(bot?.key || "").trim();
    if (!id || id.startsWith("title:") || id.startsWith("utility:")) return null;
    if (id.startsWith("group:")) return null;
    return {
      title: id.startsWith("bot:") ? "Mia 云端对话" : "Mia 对话",
      preview: `${bot?.name || botKey || "当前 Bot"} 的 Mia 对话`,
      updatedAt: 0
    };
  }

  function listBoundExternalAgentSessions({ engine, bot, limit = 10 } = {}) {
    const normalizedEngine = normalizeBotAgentEngine(engine);
    const botKey = String(bot?.key || "").trim();
    if (!botKey) return [];
    const prefix = `${normalizedEngine}:${botKey}:`;
    const metadata = new Map(listExternalAgentSessions(normalizedEngine, { homeDir: homeDir(), limit: 160 })
      .map((item) => [item.id, item]));
    const rowsByExternalId = new Map();
    for (const [key, entry] of Object.entries(loadAgentSessionMap())) {
      if (!key.startsWith(prefix)) continue;
      const localConversationId = key.slice(prefix.length);
      const externalId = agentSessionEntryId(entry);
      if (!externalId || rowsByExternalId.has(externalId)) continue;
      const local = miaConversationTitleForAgentBinding(localConversationId, bot);
      if (!local) continue;
      const external = metadata.get(externalId) || {};
      rowsByExternalId.set(externalId, {
        id: externalId,
        title: local.title,
        preview: [local.preview, external.project || ""].filter(Boolean).join(" · "),
        project: external.project || "",
        updatedAt: local.updatedAt || external.updatedAt || 0
      });
    }
    return [...rowsByExternalId.values()]
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .slice(0, limit);
  }

  function usefulExternalSessionRow(row) {
    const title = String(row?.title || "").trim();
    const preview = String(row?.preview || "").trim();
    const text = `${title}\n${preview}`;
    if (!title && !preview) return false;
    if (looksLikeUuid(title) && !preview) return false;
    if (/<command-name>|<command-message>|<command-args>/i.test(text)) return false;
    if (/^\/(?:goal|clear|usage|context|compact|resume|export)\b/i.test(title)) return false;
    return true;
  }

  function commandResultDeviceMeta() {
    return {
      sourceDeviceId: String(sourceDeviceId() || "").trim()
    };
  }

  function runSlashCommand({ text, bot, engine, sessionId }) {
    const { command, argText } = commandInvocation(text);
    if (command === "/status") return externalAgentStatus({ bot, engine, sessionId });
    if (command === "/model") {
      const config = normalizeBotEngineConfig(bot.engineConfig);
      return `当前模型：${config.model || defaultModelLabel(engine)}。\n可以用底部模型选择器切换这个 Bot 的本地引擎模型。`;
    }
    if (command === "/permissions" || command === "/permission") {
      return `当前权限模式：${enginePermissionMode(engine) || "default"}。\n可以用底部权限选择器切换当前本地引擎权限。`;
    }
    if (command === "/clear") {
      return "Mia 还没有把 /clear 接到当前会话清空动作。现在可以用顶部新对话按钮开启干净会话。";
    }
    if (command === "/cost") {
      return "当前 GUI 通道暂未保存外部 CLI 的 token/cost 汇总。Claude Code 或 Codex CLI 自己的用量以本机 CLI 配置为准。";
    }
    if (command === "/memory") {
      const memoryPath = path.join(cwd(), "CLAUDE.md");
      return fs.existsSync(memoryPath)
        ? `当前项目记忆文件：${memoryPath}`
        : `当前项目未找到 CLAUDE.md：${memoryPath}`;
    }
    if (command === "/config") {
      return "本地外部引擎的模型和权限在输入框下方选择器里查看和切换；更底层的账号、默认模型、权限策略仍以用户本机 CLI 配置为准。";
    }
    if (command === "/resume") {
      const workspacePath = cwd();
      const current = getAgentSessionId(engine, bot.key, sessionId, workspacePath);
      const next = argText.split(/\s+/).filter(Boolean)[0] || "";
      if (!next) {
        const boundRows = listBoundExternalAgentSessions({ engine, bot, limit: 10 })
          .filter((item) => item.id !== current)
          .slice(0, 10);
        const rows = (boundRows.length ? boundRows : listExternalAgentSessions(engine, { homeDir: homeDir(), limit: 30 })
          .filter(usefulExternalSessionRow)
          .filter((item) => item.id !== current)
          .slice(0, 10))
          .map((item) => ({
            id: item.id,
            title: item.title || item.id,
            preview: item.preview || "",
            project: item.project || "",
            updatedAt: item.updatedAt || 0
          }));
        if (!rows.length) {
          return [
            `当前绑定的外部会话：${current || "尚未创建"}`,
            "没有找到可恢复的本地外部会话。",
            "用法：/resume <session-id>"
          ].join("\n");
        }
        return {
          content: `当前绑定的外部会话：${current || "尚未创建"}\n选择一个会话继续：`,
          commandResult: {
            type: "session-list",
            command: "/resume",
            engine,
            ...commandResultDeviceMeta(),
            rows
          }
        };
      }
      if (!looksLikeUuid(next)) {
        return "session-id 看起来不是有效 UUID。用法：/resume <session-id>";
      }
      if (engine === "claude-code") {
        setAgentSessionEntry(engine, bot.key, sessionId, next, "", workspacePath);
      } else {
        setAgentSessionId(engine, bot.key, sessionId, next, workspacePath);
      }
      return `已把当前 Mia 会话绑定到外部 session：${next}\n下一条消息会从这个 session 继续。`;
    }
    if (command === "/rewind") {
      return `Mia 还没有把 /rewind 接到会话回退动作。参数：${argText || "默认 1 步"}。`;
    }
    if (command === "/help") {
      return [
        "当前是本地外部 Agent 引擎，可用命令：",
        "/status - 查看本地 CLI、模型、权限和外部会话",
        "/model - 查看当前模型",
        "/permissions - 查看当前权限模式",
        "/clear - 提示如何开启干净会话",
        "/cost - 查看 GUI 可见的用量状态",
        "/memory - 查看当前项目 CLAUDE.md 状态",
        "/config - 查看当前配置入口",
        "/resume <session-id> - 切换当前 Mia 会话绑定的外部 session",
        "/rewind - 提示如何回退对话",
        "Claude Code 自定义命令会从 .claude/commands 和 ~/.claude/commands 扫描。"
      ].join("\n");
    }
    return null;
  }

  return {
    builtInCommands: () => EXTERNAL_AGENT_BUILT_IN_COMMANDS.map((item) => ({ ...item })),
    agentCommandRoots,
    assertAllowedAgentCommandPath,
    executeCommand,
    listBoundExternalAgentSessions,
    loadCommands,
    runSlashCommand,
    usefulExternalSessionRow
  };
}

module.exports = {
  EXTERNAL_AGENT_BUILT_IN_COMMANDS,
  agentSessionEntryId,
  createExternalAgentCommandService,
  isChildPath,
  looksLikeUuid
};
