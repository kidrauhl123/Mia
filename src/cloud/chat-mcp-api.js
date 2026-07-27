"use strict";

const crypto = require("node:crypto");
const ids = require("../shared/ids.js");
const {
  botConversationId,
  manualBotDefaultCapabilities
} = require("../shared/bot-identity.js");

const SERVER_NAME = "mia-chat";
const LATEST_PROTOCOL_VERSION = "2025-11-25";
const SUPPORTED_PROTOCOL_VERSIONS = new Set([
  "2025-11-25",
  "2025-06-18",
  "2025-03-26"
]);
const TOOL_NAMES = Object.freeze([
  "list_bots",
  "create_bot",
  "list_conversations",
  "create_conversation",
  "send_message",
  "get_messages"
]);

class ChatMcpToolError extends Error {
  constructor(message, code = "invalid_request", details = null) {
    super(message);
    this.name = "ChatMcpToolError";
    this.code = code;
    this.details = details;
  }
}

function cleanText(value) {
  return String(value == null ? "" : value).trim();
}

function boundedInteger(value, min, max, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
}

function requiredText(args, key, maxLength) {
  const value = cleanText(args?.[key]);
  if (!value) throw new ChatMcpToolError(`${key} is required`);
  if (value.length > maxLength) {
    throw new ChatMcpToolError(`${key} must be at most ${maxLength} characters`);
  }
  return value;
}

function optionalText(args, key, maxLength) {
  const value = cleanText(args?.[key]);
  if (value.length > maxLength) {
    throw new ChatMcpToolError(`${key} must be at most ${maxLength} characters`);
  }
  return value;
}

function requiredMessageText(args, key, maxLength) {
  const value = String(args?.[key] == null ? "" : args[key]);
  if (!value.trim()) throw new ChatMcpToolError(`${key} is required`);
  if (value.length > maxLength) {
    throw new ChatMcpToolError(`${key} must be at most ${maxLength} characters`);
  }
  return value;
}

function normalizeAgentEngine(value, fallback = "") {
  const raw = cleanText(value || fallback).toLowerCase().replace(/_/g, "-");
  if (raw === "claude" || raw === "anthropic" || raw === "cloud-claude-code") return "claude-code";
  if (raw === "openai-codex") return "codex";
  if (["claude-code", "codex", "hermes"].includes(raw)) return raw;
  return "";
}

function toolAnnotations({ readOnly = false, idempotent = false, openWorld = false } = {}) {
  return {
    readOnlyHint: readOnly,
    destructiveHint: false,
    idempotentHint: idempotent,
    openWorldHint: openWorld
  };
}

function toolDefinitions() {
  return [
    {
      name: "list_bots",
      title: "List Mia bots",
      description: "List bots owned by the authenticated Mia account and show each bot's active runtime.",
      inputSchema: {
        type: "object",
        properties: {
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 200,
            default: 100,
            description: "Maximum number of bots to return."
          }
        },
        additionalProperties: false
      },
      annotations: toolAnnotations({ readOnly: true, idempotent: true })
    },
    {
      name: "create_bot",
      title: "Create a Mia bot",
      description: "Create a bot owned by the authenticated Mia account and bind it to Mia Cloud or a Mia desktop device.",
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            minLength: 1,
            maxLength: 80,
            description: "Display name for the bot."
          },
          persona: {
            type: "string",
            maxLength: 20000,
            description: "Instructions defining the bot's identity and behavior."
          },
          description: {
            type: "string",
            maxLength: 500,
            description: "Short description shown in Mia."
          },
          color: {
            type: "string",
            pattern: "^#[0-9a-fA-F]{6}$",
            description: "Optional six-digit CSS hex color."
          },
          runtime_kind: {
            type: "string",
            enum: ["cloud-claude-code", "desktop-local"],
            description: "Where the bot runs. Defaults to Mia Cloud when available."
          },
          agent_engine: {
            type: "string",
            enum: ["claude-code", "codex", "hermes"],
            description: "Desktop agent engine. Mia Cloud always uses claude-code."
          },
          device_id: {
            type: "string",
            maxLength: 96,
            description: "Desktop device id when runtime_kind is desktop-local."
          }
        },
        required: ["name"],
        additionalProperties: false
      },
      annotations: toolAnnotations()
    },
    {
      name: "list_conversations",
      title: "List Mia bot conversations",
      description: "List bot conversations visible to the authenticated Mia account, optionally restricted to one bot.",
      inputSchema: {
        type: "object",
        properties: {
          bot_id: {
            type: "string",
            description: "Only return conversations belonging to this bot."
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 200,
            default: 100,
            description: "Maximum number of conversations to return."
          }
        },
        additionalProperties: false
      },
      annotations: toolAnnotations({ readOnly: true, idempotent: true })
    },
    {
      name: "create_conversation",
      title: "Create a Mia bot conversation",
      description: "Create a new private conversation with one bot owned by the authenticated Mia account.",
      inputSchema: {
        type: "object",
        properties: {
          bot_id: {
            type: "string",
            minLength: 1,
            description: "Bot to open the conversation with."
          },
          title: {
            type: "string",
            maxLength: 80,
            description: "Optional conversation title. Defaults to the bot name."
          }
        },
        required: ["bot_id"],
        additionalProperties: false
      },
      annotations: toolAnnotations()
    },
    {
      name: "send_message",
      title: "Send a message to a Mia bot",
      description: "Send a user message in an existing Mia bot conversation and wait for the bot's canonical reply.",
      inputSchema: {
        type: "object",
        properties: {
          conversation_id: {
            type: "string",
            minLength: 1,
            description: "Existing Mia bot conversation id."
          },
          text: {
            type: "string",
            minLength: 1,
            maxLength: 100000,
            description: "Message to send."
          },
          wait_timeout_seconds: {
            type: "integer",
            minimum: 0,
            maximum: 300,
            default: 120,
            description: "How long to wait for a reply. Use 0 to return immediately and poll with get_messages."
          }
        },
        required: ["conversation_id", "text"],
        additionalProperties: false
      },
      annotations: toolAnnotations({ openWorld: true })
    },
    {
      name: "get_messages",
      title: "Get Mia conversation messages",
      description: "Read messages from an existing Mia bot conversation in chronological order.",
      inputSchema: {
        type: "object",
        properties: {
          conversation_id: {
            type: "string",
            minLength: 1,
            description: "Existing Mia bot conversation id."
          },
          since_seq: {
            type: "integer",
            minimum: 0,
            description: "Return messages with a sequence number greater than this value. Omit to get the latest page."
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 500,
            default: 100,
            description: "Maximum number of messages to return."
          }
        },
        required: ["conversation_id"],
        additionalProperties: false
      },
      annotations: toolAnnotations({ readOnly: true, idempotent: true })
    }
  ];
}

function jsonRpcError(id, code, message, data) {
  return {
    jsonrpc: "2.0",
    id: id === undefined ? null : id,
    error: {
      code,
      message,
      ...(data === undefined ? {} : { data })
    }
  };
}

function jsonRpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function toolCallResult(value, isError = false) {
  const structured = value && typeof value === "object"
    ? value
    : { value };
  return {
    content: [{ type: "text", text: JSON.stringify(structured, null, 2) }],
    structuredContent: structured,
    isError
  };
}

function normalizeBinding(binding) {
  if (!binding) return null;
  const config = binding.config && typeof binding.config === "object" ? binding.config : {};
  return {
    kind: cleanText(binding.runtimeKind),
    enabled: Boolean(binding.enabled),
    agent_engine: cleanText(config.agentEngine || config.agent_engine),
    device_id: cleanText(config.deviceId || config.device_id || config.targetDeviceId),
    device_name: cleanText(config.deviceName || config.device_name),
    updated_at: cleanText(binding.updatedAt)
  };
}

function normalizeBot(bot, binding, { includePersona = false } = {}) {
  return {
    id: cleanText(bot?.id),
    name: cleanText(bot?.displayName || bot?.name),
    description: cleanText(bot?.bio),
    color: cleanText(bot?.color),
    runtime: normalizeBinding(binding),
    created_at: cleanText(bot?.createdAt),
    updated_at: cleanText(bot?.updatedAt),
    ...(includePersona ? { persona: cleanText(bot?.personaText) } : {})
  };
}

function botIdForConversation(context, conversation, userId) {
  if (!conversation || conversation.type !== "bot") return "";
  const decoratedBotId = cleanText(conversation.decorations?.botId);
  if (decoratedBotId) {
    const decoratedBot = context.botsStore.getBot(decoratedBotId);
    if (decoratedBot && cleanText(decoratedBot.ownerUserId) === userId) return decoratedBotId;
  }
  const members = context.socialStore.listConversationMembers(conversation.id);
  const botMember = members.find((member) => {
    if (member.member_kind !== "bot" || !member.member_ref) return false;
    const bot = context.botsStore.getBot(member.member_ref);
    return bot && cleanText(bot.ownerUserId) === userId;
  });
  return cleanText(botMember?.member_ref);
}

function normalizeConversation(context, conversation, userId) {
  const botId = botIdForConversation(context, conversation, userId);
  const binding = botId ? context.runtimeBindingsStore.getActiveBinding(userId, botId) : null;
  return {
    id: cleanText(conversation?.id),
    title: cleanText(conversation?.name),
    bot_id: botId,
    runtime: normalizeBinding(binding),
    last_message: cleanText(conversation?.lastMessageText || conversation?.last_message_text).slice(0, 1000),
    last_message_seq: Number(conversation?.lastMessageSeq || conversation?.last_message_seq) || 0,
    last_activity_at: cleanText(conversation?.lastActivityAt || conversation?.last_activity_at),
    created_at: cleanText(conversation?.createdAt || conversation?.created_at),
    updated_at: cleanText(conversation?.updatedAt || conversation?.updated_at)
  };
}

function normalizeMessage(message) {
  const senderKind = cleanText(message?.sender_kind || message?.senderKind);
  const senderRef = cleanText(message?.sender_ref || message?.senderRef);
  return {
    id: cleanText(message?.id),
    seq: Number(message?.seq) || 0,
    role: senderKind === "bot" ? "assistant" : "user",
    sender_kind: senderKind,
    sender_id: senderRef,
    text: String(message?.body_md ?? message?.bodyMd ?? ""),
    status: cleanText(message?.status || "complete"),
    turn_id: cleanText(message?.turn_id || message?.turnId),
    trigger_message_id: cleanText(message?.trigger_message_id || message?.triggerMessageId),
    created_at: cleanText(message?.created_at || message?.createdAt)
  };
}

function ownedBot(context, userId, botId) {
  const bot = context.botsStore.getBot(botId);
  if (!bot) throw new ChatMcpToolError("bot not found", "not_found");
  if (cleanText(bot.ownerUserId) !== userId) {
    throw new ChatMcpToolError("you can only use bots owned by this Mia account", "forbidden");
  }
  return bot;
}

function ownedBotConversation(context, userId, conversationId) {
  const conversation = context.socialStore.getConversation(conversationId);
  if (!conversation) throw new ChatMcpToolError("conversation not found", "not_found");
  const membership = context.socialStore.getConversationMember(conversationId, "user", userId);
  if (!membership) throw new ChatMcpToolError("not a member of this conversation", "forbidden");
  if (conversation.type !== "bot") {
    throw new ChatMcpToolError("this tool only supports bot conversations", "invalid_conversation");
  }
  const botId = botIdForConversation(context, conversation, userId);
  if (!botId) {
    throw new ChatMcpToolError("conversation is not attached to a bot owned by this Mia account", "forbidden");
  }
  const bot = ownedBot(context, userId, botId);
  return { conversation, bot, botId };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createChatMcpApi(options = {}) {
  const context = options.context;
  if (!context) throw new Error("createChatMcpApi: context required");
  const broadcast = typeof options.broadcast === "function" ? options.broadcast : () => null;
  const dispatchMessage = typeof options.dispatchMessage === "function"
    ? options.dispatchMessage
    : async () => null;
  const listDevices = typeof options.listDevices === "function"
    ? options.listDevices
    : () => [];
  const getUserPublic = typeof options.getUserPublic === "function"
    ? options.getUserPublic
    : () => null;
  const serverVersion = cleanText(options.serverVersion || "1.0.0");

  function createUniqueBotId() {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const botId = ids.generatePrincipalId();
      if (!context.botsStore.getBot(botId)) return botId;
    }
    throw new ChatMcpToolError("could not allocate a unique bot id", "id_allocation_failed");
  }

  function createUniqueConversationId() {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const sessionId = crypto.randomUUID();
      const conversationId = botConversationId(sessionId);
      if (!context.socialStore.getConversation(conversationId)) {
        return { sessionId, conversationId };
      }
    }
    throw new ChatMcpToolError("could not allocate a unique conversation id", "id_allocation_failed");
  }

  function cloudRuntimeAvailable() {
    return Boolean(
      context.cloudAgentRuntime?.available
      && context.cloudAgentRuntime?.agentEngine
      && context.cloudAgentDispatcher
    );
  }

  function resolveDesktopDevice(userId, requestedDeviceId) {
    const devices = (listDevices(userId, { includeOffline: true }) || [])
      .filter((device) => device && device.id);
    const wanted = cleanText(requestedDeviceId);
    if (wanted) {
      const selected = devices.find((device) => cleanText(device.id) === wanted);
      if (!selected) {
        throw new ChatMcpToolError("desktop device not found", "device_not_found", {
          devices: devices.map((device) => ({
            id: cleanText(device.id),
            name: cleanText(device.deviceName),
            status: cleanText(device.status)
          }))
        });
      }
      return selected;
    }
    const online = devices.filter((device) => cleanText(device.status) === "online");
    if (online.length === 1) return online[0];
    if (!online.length && devices.length === 1) return devices[0];
    if (!devices.length) {
      throw new ChatMcpToolError(
        "no Mia desktop device is registered; connect Mia Desktop or use runtime_kind cloud-claude-code",
        "device_unavailable"
      );
    }
    throw new ChatMcpToolError("multiple Mia desktop devices are available; pass device_id", "device_required", {
      devices: devices.map((device) => ({
        id: cleanText(device.id),
        name: cleanText(device.deviceName),
        status: cleanText(device.status),
        engine: cleanText(device.engine)
      }))
    });
  }

  async function listBots(userId, args) {
    const limit = boundedInteger(args?.limit, 1, 200, 100);
    const bots = context.botsStore.listBots(userId)
      .slice(0, limit)
      .map((bot) => normalizeBot(
        bot,
        context.runtimeBindingsStore.getActiveBinding(userId, bot.id)
      ));
    return { bots, count: bots.length };
  }

  async function createBot(userId, args) {
    const name = requiredText(args, "name", 80);
    const persona = optionalText(args, "persona", 20000);
    const description = optionalText(args, "description", 500);
    const color = optionalText(args, "color", 20);
    if (color && !/^#[0-9a-f]{6}$/i.test(color)) {
      throw new ChatMcpToolError("color must be a six-digit CSS hex color");
    }

    const requestedRuntimeKind = cleanText(args?.runtime_kind);
    if (requestedRuntimeKind && !["cloud-claude-code", "desktop-local"].includes(requestedRuntimeKind)) {
      throw new ChatMcpToolError("runtime_kind must be cloud-claude-code or desktop-local");
    }
    const runtimeKind = requestedRuntimeKind || (cloudRuntimeAvailable() ? "cloud-claude-code" : "desktop-local");
    let runtimeConfig;
    let warning = "";
    if (runtimeKind === "cloud-claude-code") {
      if (!cloudRuntimeAvailable()) {
        throw new ChatMcpToolError("Mia Cloud agent runtime is unavailable", "runtime_unavailable");
      }
      runtimeConfig = {
        agentEngine: "claude-code",
        ...(cleanText(context.platformModelId) ? { model: cleanText(context.platformModelId) } : {})
      };
    } else {
      const device = resolveDesktopDevice(userId, args?.device_id);
      const agentEngine = normalizeAgentEngine(args?.agent_engine, device.engine);
      if (!agentEngine) {
        throw new ChatMcpToolError("agent_engine must be claude-code, codex, or hermes");
      }
      runtimeConfig = {
        agentEngine,
        deviceId: cleanText(device.id),
        deviceName: cleanText(device.deviceName)
      };
      if (cleanText(device.status) !== "online") {
        warning = "The selected desktop device is offline; messages will work after it reconnects.";
      }
    }

    const botId = createUniqueBotId();
    const bot = context.botsStore.upsertBot(userId, {
      id: botId,
      displayName: name,
      bio: description,
      personaText: persona,
      color,
      capabilities: manualBotDefaultCapabilities()
    });
    const binding = context.runtimeBindingsStore.upsertBinding({
      userId,
      botId,
      runtimeKind,
      enabled: true,
      activate: true,
      config: runtimeConfig
    });
    broadcast(userId, { type: "bot.upserted", bot });
    broadcast(userId, { type: "bot.runtime_updated", binding });
    return {
      bot: normalizeBot(bot, binding, { includePersona: true }),
      ...(warning ? { warning } : {})
    };
  }

  async function listConversations(userId, args) {
    const limit = boundedInteger(args?.limit, 1, 200, 100);
    const requestedBotId = cleanText(args?.bot_id);
    if (requestedBotId) ownedBot(context, userId, requestedBotId);
    const conversations = context.socialStore.listConversationsForUser(userId)
      .filter((conversation) => conversation?.type === "bot")
      .map((conversation) => normalizeConversation(context, conversation, userId))
      .filter((conversation) => conversation.bot_id)
      .filter((conversation) => !requestedBotId || conversation.bot_id === requestedBotId)
      .slice(0, limit);
    return { conversations, count: conversations.length };
  }

  async function createConversation(userId, args) {
    const botId = requiredText(args, "bot_id", 120);
    const title = optionalText(args, "title", 80);
    const bot = ownedBot(context, userId, botId);
    const binding = context.runtimeBindingsStore.getActiveBinding(userId, botId);
    if (!binding?.enabled) {
      throw new ChatMcpToolError("bot has no active runtime", "runtime_unavailable");
    }
    const { sessionId, conversationId } = createUniqueConversationId();
    const conversation = context.socialStore.createConversation({
      id: conversationId,
      type: "bot",
      name: title || cleanText(bot.displayName || bot.name),
      decorations: {
        botId,
        sessionId,
        runtimeKind: binding.runtimeKind
      }
    });
    context.socialStore.addConversationMember({
      conversationId,
      memberKind: "user",
      memberRef: userId
    });
    context.socialStore.addConversationMember({
      conversationId,
      memberKind: "bot",
      memberRef: botId,
      ownerId: userId
    });
    broadcast(userId, {
      type: "social.conversation_invited",
      conversation,
      invitedBy: getUserPublic(userId)
    });
    return {
      conversation: normalizeConversation(context, context.socialStore.getConversation(conversationId), userId)
    };
  }

  function findReply(conversationId, userId, userMessage) {
    return context.messagesStore
      .listMessagesSince(conversationId, Number(userMessage.seq) || 0, 500, userId)
      .find((message) => (
        cleanText(message.sender_kind) === "bot"
        && cleanText(message.trigger_message_id) === cleanText(userMessage.id)
      )) || null;
  }

  async function sendMessage(userId, args) {
    const conversationId = requiredText(args, "conversation_id", 200);
    const text = requiredMessageText(args, "text", 100000);
    const waitTimeoutSeconds = boundedInteger(args?.wait_timeout_seconds, 0, 300, 120);
    const { conversation, bot, botId } = ownedBotConversation(context, userId, conversationId);
    const binding = context.runtimeBindingsStore.getActiveBinding(userId, botId);
    if (!binding?.enabled) {
      throw new ChatMcpToolError("bot has no active runtime", "runtime_unavailable");
    }
    if (binding.runtimeKind === "cloud-claude-code" && !context.cloudAgentDispatcher) {
      throw new ChatMcpToolError("Mia Cloud agent runtime is unavailable", "runtime_unavailable");
    }

    const message = context.messagesStore.appendMessage({
      conversationId,
      senderKind: "user",
      senderRef: userId,
      bodyMd: text,
      turnId: `mcp_${crypto.randomUUID()}`,
      status: "complete"
    });
    broadcast(userId, {
      type: "conversation.message_appended",
      conversationId,
      message
    });

    let dispatchSettled = false;
    let dispatchError = null;
    Promise.resolve()
      .then(() => dispatchMessage({
        userId,
        conversationId,
        conversation,
        bot,
        botId,
        binding,
        message
      }))
      .catch((error) => {
        dispatchError = error;
      })
      .finally(() => {
        dispatchSettled = true;
      });

    const deadline = Date.now() + waitTimeoutSeconds * 1000;
    let reply = findReply(conversationId, userId, message);
    while (!reply && Date.now() < deadline) {
      if (dispatchSettled && dispatchError) {
        throw new ChatMcpToolError(
          dispatchError.message || "bot invocation failed",
          "bot_invocation_failed"
        );
      }
      await delay(Math.min(250, Math.max(1, deadline - Date.now())));
      reply = findReply(conversationId, userId, message);
    }
    if (!reply && dispatchSettled && dispatchError) {
      throw new ChatMcpToolError(
        dispatchError.message || "bot invocation failed",
        "bot_invocation_failed"
      );
    }
    return {
      conversation_id: conversationId,
      message: normalizeMessage(message),
      reply: reply ? normalizeMessage(reply) : null,
      timed_out: !reply
    };
  }

  async function getMessages(userId, args) {
    const conversationId = requiredText(args, "conversation_id", 200);
    ownedBotConversation(context, userId, conversationId);
    const limit = boundedInteger(args?.limit, 1, 500, 100);
    const hasSince = args && Object.prototype.hasOwnProperty.call(args, "since_seq");
    let messages;
    let hasMoreBefore = false;
    if (hasSince) {
      const sinceSeq = boundedInteger(args.since_seq, 0, Number.MAX_SAFE_INTEGER, 0);
      messages = context.messagesStore.listMessagesSince(conversationId, sinceSeq, limit, userId);
    } else {
      const page = context.messagesStore.listLatestMessages(conversationId, limit, userId);
      messages = page.messages;
      hasMoreBefore = page.hasMoreBefore;
    }
    return {
      conversation_id: conversationId,
      messages: messages.map(normalizeMessage),
      page_info: {
        oldest_seq: Number(messages[0]?.seq) || 0,
        newest_seq: Number(messages[messages.length - 1]?.seq) || 0,
        has_more_before: hasMoreBefore
      }
    };
  }

  async function callTool(userId, name, args = {}) {
    switch (name) {
      case "list_bots":
        return listBots(userId, args);
      case "create_bot":
        return createBot(userId, args);
      case "list_conversations":
        return listConversations(userId, args);
      case "create_conversation":
        return createConversation(userId, args);
      case "send_message":
        return sendMessage(userId, args);
      case "get_messages":
        return getMessages(userId, args);
      default:
        throw new ChatMcpToolError(`unknown tool: ${name}`, "unknown_tool");
    }
  }

  function validateMirroredHeaders(headers, request) {
    const headerMethod = cleanText(headers?.["mcp-method"]);
    if (headerMethod && headerMethod !== cleanText(request?.method)) {
      return "Mcp-Method header does not match the JSON-RPC method";
    }
    const headerName = cleanText(headers?.["mcp-name"]);
    if (headerName && request?.method === "tools/call" && headerName !== cleanText(request?.params?.name)) {
      return "Mcp-Name header does not match the requested tool";
    }
    return "";
  }

  async function handlePost({ body, headers = {}, userId }) {
    if (!body || Array.isArray(body) || typeof body !== "object") {
      return { status: 400, body: jsonRpcError(null, -32600, "Invalid Request") };
    }
    const requestId = Object.prototype.hasOwnProperty.call(body, "id") ? body.id : undefined;
    if (body.jsonrpc !== "2.0" || !cleanText(body.method)) {
      return { status: 400, body: jsonRpcError(requestId, -32600, "Invalid Request") };
    }
    const mirroredHeaderError = validateMirroredHeaders(headers, body);
    if (mirroredHeaderError) {
      return { status: 400, body: jsonRpcError(requestId, -32600, mirroredHeaderError) };
    }
    const protocolHeader = cleanText(headers["mcp-protocol-version"]);
    if (body.method !== "initialize" && protocolHeader && !SUPPORTED_PROTOCOL_VERSIONS.has(protocolHeader)) {
      return {
        status: 400,
        body: jsonRpcError(requestId, -32600, `Unsupported MCP protocol version: ${protocolHeader}`)
      };
    }

    if (body.method === "notifications/initialized") {
      return { status: 202, body: null };
    }
    if (requestId === undefined) {
      return { status: 202, body: null };
    }
    if (body.method === "initialize") {
      const requestedVersion = cleanText(body.params?.protocolVersion);
      const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.has(requestedVersion)
        ? requestedVersion
        : LATEST_PROTOCOL_VERSION;
      return {
        status: 200,
        body: jsonRpcResult(requestId, {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: {
            name: SERVER_NAME,
            title: "Mia Chat",
            version: serverVersion,
            description: "Authenticated Mia bot, conversation, and messaging tools."
          },
          instructions: "Use Mia bots and bot conversations only. This server does not expose tasks, schedules, files, shell, or desktop control."
        })
      };
    }
    if (body.method === "ping") {
      return { status: 200, body: jsonRpcResult(requestId, {}) };
    }
    if (body.method === "tools/list") {
      return {
        status: 200,
        body: jsonRpcResult(requestId, { tools: toolDefinitions() })
      };
    }
    if (body.method === "tools/call") {
      const name = cleanText(body.params?.name);
      if (!name) {
        return {
          status: 200,
          body: jsonRpcError(requestId, -32602, "tools/call requires params.name")
        };
      }
      if (!TOOL_NAMES.includes(name)) {
        return {
          status: 200,
          body: jsonRpcError(requestId, -32602, `Unknown tool: ${name}`)
        };
      }
      const args = body.params?.arguments;
      if (args !== undefined && (!args || Array.isArray(args) || typeof args !== "object")) {
        return {
          status: 200,
          body: jsonRpcError(requestId, -32602, "params.arguments must be an object")
        };
      }
      try {
        const value = await callTool(userId, name, args || {});
        return {
          status: 200,
          body: jsonRpcResult(requestId, toolCallResult(value))
        };
      } catch (error) {
        const payload = {
          error: cleanText(error?.message || "Mia tool call failed"),
          code: cleanText(error?.code || "tool_failed"),
          ...(error?.details ? { details: error.details } : {})
        };
        return {
          status: 200,
          body: jsonRpcResult(requestId, toolCallResult(payload, true))
        };
      }
    }
    return {
      status: 200,
      body: jsonRpcError(requestId, -32601, `Method not found: ${body.method}`)
    };
  }

  async function handleHttp({ method, body, headers, userId }) {
    if (method !== "POST") {
      return {
        status: 405,
        headers: { Allow: "POST, GET, DELETE" },
        body: jsonRpcError(null, -32600, "This stateless MCP endpoint accepts JSON-RPC requests via POST.")
      };
    }
    return handlePost({ body, headers, userId: cleanText(userId) });
  }

  return {
    callTool,
    handleHttp,
    toolDefinitions
  };
}

module.exports = {
  ChatMcpToolError,
  LATEST_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  TOOL_NAMES,
  createChatMcpApi,
  toolDefinitions
};
