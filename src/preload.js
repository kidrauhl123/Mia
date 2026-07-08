const { contextBridge, ipcRenderer, webUtils, clipboard } = require("electron");
const { IpcChannel } = require("./shared/ipc-channels");

const miaCoreStartupState = ipcRenderer.sendSync(IpcChannel.MiaCoreStartupState) || {};
const miaCoreRequest = (method, route, body) => ipcRenderer.invoke(IpcChannel.MiaCoreHttpRequest, { method, route, body });
const miaCoreGet = (route) => miaCoreRequest("GET", route);
const miaCorePost = (route, body) => miaCoreRequest("POST", route, body);
const miaCorePatch = (route, body) => miaCoreRequest("PATCH", route, body);
const miaCorePut = (route, body) => miaCoreRequest("PUT", route, body);
const miaCoreDelete = (route) => miaCoreRequest("DELETE", route);

async function coreOk(request) {
  const payload = await request;
  if (payload && payload.ok === false) return payload;
  const data = payload && typeof payload === "object" ? payload : {};
  return { ok: true, data, ...data };
}

function firstText(...values) {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) return text;
  }
  return "";
}

function coreConversationType(conversation = {}) {
  const kind = String(conversation.kind || conversation.conversationKind || "").trim();
  const id = String(conversation.id || "").trim();
  if (conversation.type) return conversation.type;
  if (kind === "bot_session" || conversation.botId || conversation.bot_id) return "bot";
  if (kind === "group") return "group";
  if (id.startsWith("dm:")) return "dm";
  if (id.startsWith("botc_")) return "bot";
  if (id.startsWith("g_") || id.startsWith("g-")) return "group";
  return kind === "direct" ? "dm" : "";
}

function normalizeCoreConversation(conversation = {}) {
  if (!conversation || typeof conversation !== "object") return conversation;
  const id = String(conversation.id || "").trim();
  const metadata = conversation.metadata && typeof conversation.metadata === "object" ? conversation.metadata : {};
  const decorations = conversation.decorations && typeof conversation.decorations === "object" ? conversation.decorations : {};
  const botId = firstText(conversation.botId, conversation.bot_id, decorations.botId, decorations.bot_id);
  const type = coreConversationType(conversation);
  return {
    ...conversation,
    id,
    type,
    name: firstText(conversation.name, conversation.title, conversation.displayName, conversation.display_name, botId, id),
    botId: botId || undefined,
    bot_id: botId || undefined,
    decorations: type === "bot"
      ? {
          ...decorations,
          botId,
          sessionId: firstText(decorations.sessionId, decorations.session_id, metadata.sessionId, metadata.session_id, id),
          runtimeKind: firstText(decorations.runtimeKind, decorations.runtime_kind, metadata.runtimeKind, metadata.runtime_kind, "desktop-local"),
          ...(metadata.starterEngineId || metadata.starter_engine_id
            ? { starterEngineId: metadata.starterEngineId || metadata.starter_engine_id }
            : {})
        }
      : decorations,
    metadata
  };
}

function normalizeCoreConversationPayload(payload = {}) {
  const data = payload && typeof payload === "object" ? { ...payload } : {};
  if (Array.isArray(data.conversations)) {
    data.conversations = data.conversations.map(normalizeCoreConversation);
  }
  if (data.conversation) {
    data.conversation = normalizeCoreConversation(data.conversation);
  }
  return data;
}

async function coreConversationOk(request) {
  const payload = normalizeCoreConversationPayload(await request);
  if (payload && payload.ok === false) return payload;
  return { ok: true, data: payload, ...payload };
}

function coreTimestampIso(value) {
  const raw = value == null ? "" : String(value).trim();
  if (!raw) return "";
  if (/^\d+(\.\d+)?$/.test(raw)) {
    const ms = Number(raw);
    if (Number.isFinite(ms) && ms > 0) return new Date(ms).toISOString();
    return "";
  }
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString();
}

function coreMessageCreatedAt(message = {}, fallback = {}) {
  return coreTimestampIso(message.created_at)
    || coreTimestampIso(message.createdAt)
    || coreTimestampIso(fallback.createdAt)
    || new Date().toISOString();
}

function normalizeCoreMessage(message = {}, fallback = {}) {
  const content = message.content && typeof message.content === "object" ? message.content : {};
  const role = firstText(message.role, fallback.role);
  const senderKind = role === "assistant" ? "bot" : (role === "system" ? "system" : "user");
  const normalizedSenderKind = firstText(message.sender_kind, message.senderKind, fallback.senderKind, senderKind);
  return {
    ...message,
    id: firstText(message.id, fallback.id),
    conversation_id: firstText(message.conversation_id, message.conversationId, fallback.conversationId),
    seq: Number(message.seq || fallback.seq || 0),
    sender_kind: normalizedSenderKind,
    sender_ref: firstText(message.sender_ref, message.senderRef, fallback.senderRef, normalizedSenderKind === "user" ? miaCoreStartupState.userId : ""),
    body_md: firstText(message.body_md, message.bodyMd, message.body, fallback.bodyMd),
    status: firstText(message.status, fallback.status, "complete"),
    turn_id: firstText(message.turn_id, message.turnId, content.turnId, fallback.turnId),
    created_at: coreMessageCreatedAt(message, fallback),
    content_json: message.content_json || JSON.stringify(content || {})
  };
}

function selectedSkillIdsFromCoreBody(input = {}) {
  if (Array.isArray(input.selectedSkillIds)) return input.selectedSkillIds.map((id) => String(id || "").trim()).filter(Boolean);
  if (Array.isArray(input.selected_skill_ids)) return input.selected_skill_ids.map((id) => String(id || "").trim()).filter(Boolean);
  if (Array.isArray(input.skills)) {
    return input.skills.map((skill) => String(skill?.id || skill || "").trim()).filter(Boolean);
  }
  return [];
}

function isCoreConversationId(conversationId) {
  const id = String(conversationId || "").trim();
  return id.startsWith("conv_") || id.startsWith("botc_starter_") || id.startsWith("cloud_bridge_");
}

function isBotConversationId(conversationId) {
  return String(conversationId || "").trim().startsWith("botc_");
}

function localCoreConversationIdForBotConversation(conversationId) {
  const id = String(conversationId || "").trim();
  if (!id) return "";
  return id.startsWith("cloud_bridge_") ? id : `cloud_bridge_${id}`;
}

function runtimeKindFromPostBody(body = {}) {
  const input = body && typeof body === "object" ? body : {};
  const raw = String(input.runtimeKind || input.runtime_kind || "").trim().toLowerCase().replace(/_/g, "-");
  if (raw === "cloud-claude-code" || raw === "mia-cloud" || raw === "miacloud") return "cloud-claude-code";
  if (raw === "desktop-local") return "desktop-local";
  return raw;
}

function isDesktopLocalBotPost(body = {}) {
  const input = body && typeof body === "object" ? body : {};
  const botId = String(input.botId || input.bot_id || input.botKey || input.bot_key || "").trim();
  return runtimeKindFromPostBody(input) === "desktop-local" && Boolean(botId);
}

function isCloudClaudeCodeBotPost(body = {}) {
  return runtimeKindFromPostBody(body) === "cloud-claude-code";
}

function isDesktopLocalBotConversationPost(conversationId, body = {}) {
  if (isCoreConversationId(conversationId)) return false;
  if (isDesktopLocalBotPost(body)) return true;
  if (!isBotConversationId(conversationId)) return false;
  return !isCloudClaudeCodeBotPost(body);
}

async function mcpCoreOk(request) {
  try {
    const payload = await request;
    const data = payload && typeof payload === "object" ? payload : {};
    return { success: true, data, error: "", ...data };
  } catch (error) {
    return { success: false, data: null, error: error?.message || String(error || "MCP request failed") };
  }
}

function mcpInputId(input) {
  if (typeof input === "string") return input;
  return String(input?.serverId || input?.id || "").trim();
}

async function testCoreMcpServer(input) {
  try {
    const id = mcpInputId(input);
    const body = input && typeof input === "object" ? input : {};
    const response = await miaCorePost(`/api/mcp/servers/${encodeURIComponent(id)}/test`, body);
    const diagnostic = response?.diagnostic && typeof response.diagnostic === "object" ? response.diagnostic : {};
    const status = String(diagnostic.status || response?.status || response?.lastTestStatus || "").trim();
    const data = {
      ...(response || {}),
      ...(diagnostic || {}),
      ...(status ? { status, lastTestStatus: status } : {})
    };
    return { success: true, data, error: "", ...data };
  } catch (error) {
    return { success: false, data: null, error: error?.message || String(error || "MCP test failed") };
  }
}

function buildCoreBotIdentityRequest(botId, body = {}) {
  const input = body && typeof body === "object" ? body : {};
  const displayName = String(
    input.displayName || input.display_name || input.name || input.label || botId || "Mia Bot"
  ).trim() || "Mia Bot";
  const identity = input.identity && typeof input.identity === "object"
    ? input.identity
    : { ...input, name: input.name || displayName };
  delete identity.capabilities;
  delete identity.capabilityJson;
  delete identity.displayName;
  delete identity.display_name;
  const capabilities = input.capabilities && typeof input.capabilities === "object"
    ? input.capabilities
    : {};
  return { displayName, identity, capabilities };
}

function buildCoreBotRuntimeRequest(body = {}) {
  const input = body && typeof body === "object" ? body : {};
  return {
    runtimeKind: String(input.runtimeKind || input.runtime_kind || "cloud-claude-code").trim() || "cloud-claude-code",
    providerConnectionId: input.providerConnectionId || input.provider_connection_id || null,
    modelProfileId: input.modelProfileId || input.model_profile_id || null,
    model: input.model || null,
    ...(input.targetIntent && typeof input.targetIntent === "object" ? { targetIntent: input.targetIntent } : {}),
    ...(input.syncIntent && typeof input.syncIntent === "object" ? { syncIntent: input.syncIntent } : {}),
    ...(input.controlIntent && typeof input.controlIntent === "object" ? { controlIntent: input.controlIntent } : {})
  };
}

function legacyRuntimeBinding(botId, response = {}) {
  const binding = response.binding && typeof response.binding === "object" ? response.binding : {};
  const config = binding.config && typeof binding.config === "object" ? binding.config : {};
  return {
    botId: response.botId || botId,
    runtimeKind: response.runtimeKind || "cloud-claude-code",
    enabled: true,
    config: {
      ...config,
      ...(binding.providerConnectionId ? { providerConnectionId: binding.providerConnectionId } : {}),
      ...(binding.modelProfileId ? { modelProfileId: binding.modelProfileId } : {}),
      ...(binding.model ? { model: binding.model } : {})
    }
  };
}

async function saveCoreBotIdentity(botId, body = {}) {
  const id = String(botId || body?.id || body?.key || "").trim();
  const request = buildCoreBotIdentityRequest(id, body);
  return coreOk(id
    ? miaCorePatch(`/api/bots/${encodeURIComponent(id)}`, request)
    : miaCorePost("/api/bots", request));
}

async function getCoreBotRuntime(botId, runtimeKind = "cloud-claude-code") {
  const id = String(botId || "").trim();
  const kind = String(runtimeKind || "cloud-claude-code").trim() || "cloud-claude-code";
  let response;
  try {
    response = await miaCoreGet(`/api/bots/${encodeURIComponent(id)}/runtime?kind=${encodeURIComponent(kind)}`);
  } catch (error) {
    if (!String(error?.message || "").includes("404")) throw error;
    response = { botId: id, runtimeKind: kind, binding: { config: {} } };
  }
  const binding = legacyRuntimeBinding(id, response || {});
  return { ok: true, data: { ...(response || {}), binding }, ...(response || {}), binding };
}

async function saveCoreBotRuntime(botId, body = {}) {
  const id = String(botId || "").trim();
  const request = buildCoreBotRuntimeRequest(body);
  const response = await miaCorePost(`/api/bots/${encodeURIComponent(id)}/runtime`, request);
  const binding = legacyRuntimeBinding(id, response || {});
  return { ok: true, data: { ...(response || {}), binding }, ...(response || {}), binding };
}

async function getCoreBotRuntimeTargetOptions(input = {}) {
  const request = input && typeof input === "object" ? input : {};
  return coreOk(miaCorePost("/api/bots/runtime-target-options", request));
}

async function getCoreBotRuntimeControlOptions(input = {}) {
  const request = input && typeof input === "object" ? input : {};
  return coreOk(miaCorePost("/api/bots/runtime-control-options", request));
}

async function getCoreSettingsRuntimeControlOptions(input = {}) {
  const request = input && typeof input === "object" ? input : {};
  return coreOk(miaCorePost("/api/settings/runtime-control-options", request));
}

function coreModelSelection(settings = {}) {
  return settings && typeof settings === "object" && !Array.isArray(settings)
    ? settings
    : {};
}

function compactModelSettings(response = {}) {
  return response?.settings && typeof response.settings === "object" && !Array.isArray(response.settings)
    ? response.settings
    : {};
}

async function saveCoreModelSelection(settings = {}) {
  const response = await miaCorePost("/api/settings/model-selection", { selection: coreModelSelection(settings) });
  const runtime = await ipcRenderer.invoke(IpcChannel.RuntimeStatus);
  const compact = compactModelSettings(response);
  return {
    ...(runtime || {}),
    model: {
      ...((runtime || {}).model || {}),
      ...compact,
      hasApiKey: Boolean(compact.provider || (runtime || {}).model?.hasApiKey)
    },
    coreModelSelection: response || {}
  };
}

async function getCoreBotCapabilityOptions(input = {}) {
  const request = input && typeof input === "object" ? input : {};
  return coreOk(miaCorePost("/api/bots/capability-options", request));
}

async function ensureCoreStarterEngineBots(input = {}) {
  const request = input && typeof input === "object" ? input : {};
  return coreOk(miaCorePost("/api/bots/starter-ensure", request));
}

async function ensureCoreBotSessionConversation(sessionId, body = {}) {
  const input = body && typeof body === "object" ? body : {};
  const botId = String(input.botId || input.botKey || "").trim();
  const id = String(sessionId || input.sessionId || botId || "").trim();
  const response = await miaCorePost(`/api/bots/${encodeURIComponent(botId)}/session-conversation`, {
    sessionId: id,
    title: input.title || input.name || botId || "Bot Session",
    runtimeKind: input.runtimeKind || input.runtime_kind || null,
    metadata: input.metadata && typeof input.metadata === "object" ? input.metadata : {}
  });
  const conversation = normalizeCoreConversation(response?.conversation || (response?.conversationId ? {
    id: response.conversationId,
    kind: "bot_session",
    botId,
    bot_id: botId,
    name: input.title || input.name || botId || "Bot Session",
    title: input.title || input.name || botId || "Bot Session",
    decorations: { botId },
    metadata: { sessionId: id }
  } : null));
  return { ok: true, data: { ...(response || {}), conversation }, ...(response || {}), conversation };
}

function buildCoreConversationRequest(payload = {}) {
  const input = payload && typeof payload === "object" ? payload : {};
  const memberBots = Array.isArray(input.memberBots) ? input.memberBots : [];
  const memberFriendUserIds = Array.isArray(input.memberFriendUserIds) ? input.memberFriendUserIds : [];
  const metadata = input.metadata && typeof input.metadata === "object" ? input.metadata : {};
  return {
    kind: input.kind || (memberBots.length || memberFriendUserIds.length ? "group" : "direct"),
    title: input.title || input.name || "Conversation",
    botId: input.botId || input.bot_id || memberBots[0] || null,
    metadata: {
      ...metadata,
      ...(memberBots.length ? { memberBots } : {}),
      ...(memberFriendUserIds.length ? { memberFriendUserIds } : {}),
      ...(input.clientGroupId ? { clientGroupId: input.clientGroupId } : {})
    }
  };
}

async function createCoreConversation(payload = {}) {
  return coreConversationOk(miaCorePost("/api/conversations", buildCoreConversationRequest(payload)));
}

async function createConversationCompat(payload = {}) {
  try {
    const result = await ipcRenderer.invoke(IpcChannel.SocialCreateConversation, payload);
    if (result?.ok !== false) return result;
  } catch {
    // Fall back to Core for local-only/dev sessions.
  }
  return createCoreConversation(payload);
}

async function getConversationCompat(conversationId) {
  if (!isCoreConversationId(conversationId)) {
    try {
      const result = await ipcRenderer.invoke(IpcChannel.SocialGetConversation, conversationId);
      if (result?.ok !== false) return result;
    } catch {
      // Fall back to Core for local-only/dev sessions.
    }
  }
  return coreConversationOk(miaCoreGet(`/api/conversations/${encodeURIComponent(conversationId)}`));
}

async function listConversationsCompat() {
  try {
    const result = await ipcRenderer.invoke(IpcChannel.SocialListConversations);
    const conversations = result?.data?.conversations || result?.conversations || [];
    if (result?.ok !== false && Array.isArray(conversations) && conversations.length) return result;
  } catch {
    // Fall back to Core when Cloud/social is unavailable.
  }
  return coreConversationOk(miaCoreGet("/api/conversations"));
}

async function listBotsCompat() {
  try {
    const result = await ipcRenderer.invoke(IpcChannel.SocialListBots);
    const bots = result?.data?.bots || result?.bots || [];
    if (result?.ok !== false && Array.isArray(bots) && bots.length) return result;
  } catch {
    // Fall back to Core starter/local bots.
  }
  return coreOk(miaCoreGet("/api/bots"));
}

async function getBotIdentityCompat(botId) {
  try {
    const result = await ipcRenderer.invoke(IpcChannel.SocialGetBotIdentity, botId);
    if (result?.ok !== false) return result;
  } catch {
    // Fall back to Core.
  }
  return coreOk(miaCoreGet(`/api/bots/${encodeURIComponent(botId)}`));
}

async function saveBotIdentityCompat(botId, body) {
  try {
    const result = await ipcRenderer.invoke(IpcChannel.SocialSaveBotIdentity, botId, body);
    if (result?.ok !== false) return result;
  } catch {
    // Fall back to Core.
  }
  return saveCoreBotIdentity(botId, body);
}

async function getBotRuntimeCompat(botId, runtimeKind) {
  try {
    const result = await ipcRenderer.invoke(IpcChannel.SocialGetBotRuntime, botId, runtimeKind);
    if (result?.ok !== false) return result;
  } catch {
    // Fall back to Core.
  }
  return getCoreBotRuntime(botId, runtimeKind);
}

async function saveBotRuntimeCompat(botId, body) {
  try {
    const result = await ipcRenderer.invoke(IpcChannel.SocialSaveBotRuntime, botId, body);
    if (result?.ok !== false) return result;
  } catch {
    // Fall back to Core.
  }
  return saveCoreBotRuntime(botId, body);
}

async function postCoreConversationMessage(conversationId, body = {}) {
  const input = body && typeof body === "object" ? body : {};
  const bodyMd = String(input.bodyMd || input.body_md || input.body || input.text || input.message || "");
  const response = await miaCorePost(`/api/conversations/${encodeURIComponent(conversationId)}/messages`, {
    body: bodyMd,
    attachments: Array.isArray(input.attachments) ? input.attachments : [],
    selectedSkillIds: selectedSkillIdsFromCoreBody(input)
  });
  const message = normalizeCoreMessage(response?.message || {}, {
    id: response?.messageId || response?.message_id || "",
    conversationId,
    role: "user",
    senderRef: miaCoreStartupState.userId || "",
    bodyMd,
    status: response?.accepted === false ? "error" : "accepted",
    turnId: response?.turnId || response?.turn_id || ""
  });
  const data = { ...(response || {}), message };
  return { ok: true, data, ...data };
}

function runtimeConfigOverrideFromPostBody(input = {}) {
  const config = {};
  for (const [target, sources] of [
    ["agentEngine", ["agentEngine", "agent_engine", "engine"]],
    ["providerConnectionId", ["providerConnectionId", "provider_connection_id"]],
    ["modelProfileId", ["modelProfileId", "model_profile_id"]],
    ["model", ["model"]],
    ["effortLevel", ["effortLevel", "effort_level"]],
    ["permissionMode", ["permissionMode", "permission_mode"]]
  ]) {
    const value = firstText(...sources.map((source) => input[source]));
    if (value) config[target] = value;
  }
  return config;
}

async function desktopLocalRuntimeConfig(input = {}) {
  const botId = firstText(input.botId, input.bot_id, input.botKey, input.bot_key);
  const overrides = runtimeConfigOverrideFromPostBody(input);
  let binding = null;
  if (botId) {
    try {
      const response = await getCoreBotRuntime(botId, "desktop-local");
      binding = response?.data?.binding || response?.binding || null;
    } catch {
      binding = null;
    }
  }
  const config = binding?.config && typeof binding.config === "object" ? binding.config : {};
  const bindingFields = runtimeConfigOverrideFromPostBody(binding || {});
  const runtimeConfig = {
    ...config,
    ...bindingFields,
    ...overrides
  };
  if (!runtimeConfig.agentEngine) {
    runtimeConfig.agentEngine = firstText(input.agentEngine, input.agent_engine, input.engine, botId, "codex");
  }
  return runtimeConfig;
}

async function postLocalDesktopBotMessage(conversationId, body = {}) {
  const input = body && typeof body === "object" ? body : {};
  const bodyMd = String(input.bodyMd || input.body_md || input.body || input.text || input.message || "");
  const runId = firstText(input.turnId, input.turn_id, input.clientTraceId, input.client_trace_id, `local_${Date.now()}`);
  const botId = firstText(input.botId, input.bot_id, input.botKey, input.bot_key);
  if (!botId) {
    const error = "Desktop-local bot send is missing botId; refusing legacy social owner.";
    const message = normalizeCoreMessage({}, {
      id: `msg_${runId}`,
      conversationId,
      role: "user",
      senderRef: miaCoreStartupState.userId || "",
      bodyMd,
      status: "error",
      turnId: runId
    });
    return { ok: false, error, data: { error, message }, message };
  }
  const runtimeConfig = await desktopLocalRuntimeConfig(input);
  const response = await miaCorePost("/api/cloud/bridge/run", {
    runId,
    conversationId,
    text: bodyMd,
    attachments: Array.isArray(input.attachments) ? input.attachments : [],
    botId,
    botName: firstText(input.botName, input.bot_name, input.title, input.name, botId),
    agentEngine: firstText(runtimeConfig.agentEngine, input.agentEngine, input.agent_engine, input.engine),
    runtimeConfig,
    model: firstText(runtimeConfig.model, input.model) || null,
    effortLevel: firstText(runtimeConfig.effortLevel, input.effortLevel, input.effort_level) || null,
    permissionMode: firstText(runtimeConfig.permissionMode, input.permissionMode, input.permission_mode) || null
  });
  const responseRunId = firstText(response?.runId, response?.run_id, runId);
  const localCoreConversationId = firstText(response?.conversationId, response?.conversation_id);
  const botReplyText = firstText(response?.text, response?.bodyMd, response?.body_md, response?.body);
  const contentBlocks = Array.isArray(response?.contentBlocks)
    ? response.contentBlocks
    : (Array.isArray(response?.content_blocks) ? response.content_blocks : null);
  const botMessage = response?.ok !== false && botReplyText
    ? {
        ...normalizeCoreMessage({}, {
          id: firstText(response?.assistantMessageId, response?.assistant_message_id, `local_reply_${responseRunId}`),
          conversationId,
          role: "assistant",
          senderRef: botId || "mia",
          bodyMd: botReplyText,
          status: "complete",
          turnId: response?.turnId || response?.turn_id || runId
        }),
        _cloudBridgeRunId: responseRunId,
        ...(localCoreConversationId ? {
          local_conversation_id: localCoreConversationId,
          _localCoreConversationId: localCoreConversationId
        } : {}),
        ...(response?.trace && typeof response.trace === "object" ? { trace: response.trace } : {}),
        ...(contentBlocks ? { contentBlocks, content_blocks_json: JSON.stringify(contentBlocks) } : {})
      }
    : null;
  const message = normalizeCoreMessage({}, {
    id: firstText(response?.messageId, response?.message_id, `msg_${runId}`),
    conversationId,
    role: "user",
    senderRef: miaCoreStartupState.userId || "",
    bodyMd,
    status: response?.ok === false ? "error" : "accepted",
    turnId: response?.turnId || response?.turn_id || runId
  });
  const data = {
    ...(response || {}),
    message,
    ...(botMessage ? { botMessage } : {}),
    localRuntime: true
  };
  return { ok: response?.ok !== false, data, ...data };
}

async function postConversationMessageCompat(conversationId, body = {}) {
  if (isDesktopLocalBotConversationPost(conversationId, body)) {
    return postLocalDesktopBotMessage(conversationId, body);
  }
  if (!isCoreConversationId(conversationId) && (!isBotConversationId(conversationId) || isCloudClaudeCodeBotPost(body))) {
    try {
      const result = await ipcRenderer.invoke(IpcChannel.SocialPostConversationMessage, conversationId, body);
      if (result?.ok !== false) return result;
    } catch {
      // Fall back to Core only if the old social route is unavailable.
    }
  }
  return postCoreConversationMessage(conversationId, body);
}

async function listCoreConversationMessages(conversationId, sinceSeq, limit) {
  const id = String(conversationId || "").trim();
  const query = new URLSearchParams();
  query.set("sinceSeq", String(Math.max(0, Number(sinceSeq) || 0)));
  query.set("limit", String(Math.max(1, Number(limit) || 200)));
  const response = await miaCoreGet(`/api/conversations/${encodeURIComponent(id)}/messages?${query.toString()}`);
  const messages = Array.isArray(response?.messages)
    ? response.messages.map((message) => normalizeCoreMessage(message, { conversationId: id }))
    : [];
  return { ok: true, data: { ...(response || {}), messages }, ...(response || {}), messages };
}

function rewriteLocalBotMessageConversation(message = {}, conversationId = "", localConversationId = "") {
  const normalized = normalizeCoreMessage(message, { conversationId });
  const content = (() => {
    try {
      return JSON.parse(normalized.content_json || "{}");
    } catch {
      return {};
    }
  })();
  content.localConversationId = localConversationId;
  content.local_conversation_id = localConversationId;
  return {
    ...normalized,
    conversation_id: conversationId,
    conversationId,
    local_conversation_id: localConversationId,
    _localCoreConversationId: localConversationId,
    content_json: JSON.stringify(content)
  };
}

function mergeConversationMessageLists(...lists) {
  const byId = new Map();
  const fingerprintToId = new Map();
  for (const list of lists) {
    for (const message of Array.isArray(list) ? list : []) {
      const id = firstText(message?.id);
      if (!id) continue;
      const fingerprint = [
        firstText(message?.turn_id, message?.turnId) || firstText(message?.created_at, message?.createdAt),
        firstText(message?.sender_kind, message?.senderKind),
        firstText(message?.body_md, message?.bodyMd, message?.body)
      ].join("\u0000");
      const existingId = fingerprintToId.get(fingerprint);
      const targetId = existingId || id;
      byId.set(targetId, { ...(byId.get(targetId) || {}), ...message, id: targetId });
      if (fingerprint && !existingId) fingerprintToId.set(fingerprint, targetId);
    }
  }
  return [...byId.values()].sort((a, b) => {
    const aSeq = Number(a?.seq || 0);
    const bSeq = Number(b?.seq || 0);
    if (aSeq !== bSeq) return aSeq - bSeq;
    return String(a?.created_at || a?.createdAt || "").localeCompare(String(b?.created_at || b?.createdAt || ""));
  });
}

async function listLocalDesktopBotMessages(conversationId, sinceSeq, limit) {
  let socialPayload = null;
  try {
    socialPayload = await ipcRenderer.invoke(IpcChannel.SocialListConversationMessages, conversationId, sinceSeq, limit);
  } catch {
    socialPayload = null;
  }
  const socialMessages = socialPayload?.data?.messages || socialPayload?.messages || [];
  const localConversationId = localCoreConversationIdForBotConversation(conversationId);
  let localPayload = null;
  try {
    localPayload = await listCoreConversationMessages(localConversationId, 0, Math.max(1000, Number(limit) || 200));
  } catch (error) {
    if (!String(error?.message || "").includes("404")) throw error;
  }
  const localMessages = (localPayload?.data?.messages || localPayload?.messages || [])
    .map((message) => rewriteLocalBotMessageConversation(message, conversationId, localConversationId));
  const messages = mergeConversationMessageLists(socialMessages, localMessages);
  return {
    ok: true,
    data: {
      ...(socialPayload?.data || socialPayload || {}),
      localConversationId,
      messages
    },
    localConversationId,
    messages
  };
}

async function listConversationMessagesCompat(conversationId, sinceSeq, limit) {
  if (isCoreConversationId(conversationId)) {
    try {
      return await listCoreConversationMessages(conversationId, sinceSeq, limit);
    } catch (error) {
      if (!String(error?.message || "").includes("404")) throw error;
    }
  }
  if (isBotConversationId(conversationId)) {
    return listLocalDesktopBotMessages(conversationId, sinceSeq, limit);
  }
  return ipcRenderer.invoke(IpcChannel.SocialListConversationMessages, conversationId, sinceSeq, limit);
}

async function deleteConversationCompat(conversationId) {
  if (isCoreConversationId(conversationId)) {
    try {
      const response = await miaCoreDelete(`/api/conversations/${encodeURIComponent(conversationId)}`);
      return { ok: true, data: response || {}, ...(response || {}) };
    } catch (error) {
      if (!String(error?.message || "").includes("404")) {
        return { ok: false, error: error?.message || String(error || "delete failed") };
      }
    }
  }
  return ipcRenderer.invoke(IpcChannel.SocialDeleteConversation, conversationId);
}

function buildCoreConversationUtilityTurnRequest(payload = {}) {
  const input = payload && typeof payload === "object" ? payload : {};
  const conversationId = String(input.conversationId || input.conversation_id || input.sessionId || "").trim();
  return {
    botId: String(input.botId || input.bot_id || input.botKey || "").trim() || null,
    conversationId: conversationId || null,
    purpose: String(input.purpose || input.intent || "utility").trim() || "utility",
    systemPrompt: String(input.systemPrompt || input.system_prompt || ""),
    userPrompt: String(input.userPrompt || input.user_prompt || input.prompt || input.body || input.text || ""),
    selectedSkillIds: Array.isArray(input.selectedSkillIds) ? input.selectedSkillIds : []
  };
}

function runCoreConversationUtilityTurn(payload = {}) {
  return coreOk(miaCorePost("/api/conversations/utility-turns", buildCoreConversationUtilityTurnRequest(payload)));
}

function cancelCoreConversationTurn(payload = {}) {
  const input = payload && typeof payload === "object" ? payload : {};
  const conversationId = String(input.conversationId || input.conversation_id || input.sessionId || "").trim();
  const turnId = String(input.turnId || input.turn_id || "").trim();
  if (conversationId && turnId) {
    return coreOk(miaCorePost(
      `/api/conversations/${encodeURIComponent(conversationId)}/turns/${encodeURIComponent(turnId)}/cancel`,
      {}
    ));
  }
  return Promise.resolve({
    ok: false,
    error: "Core turn id is required to cancel an active conversation."
  });
}

function legacyTriggerFromCoreSchedule(schedule = {}) {
  if (schedule?.type === "cron") return { type: "cron", cron: String(schedule.cron || "") };
  if (schedule?.type === "oneshot") {
    const atMs = Number(schedule.atMs || 0);
    return { type: "oneshot", at: atMs > 0 ? new Date(atMs).toISOString() : "" };
  }
  if (schedule?.type === "every") return { type: "every", everyMs: Number(schedule.everyMs || 0) };
  return {};
}

function legacyTaskFromCoreJob(job = {}) {
  const target = job.target && typeof job.target === "object" ? job.target : {};
  const schedule = job.schedule && typeof job.schedule === "object" ? job.schedule : {};
  return {
    id: job.id || "",
    title: target.title || job.title || job.kind || "未命名任务",
    botId: target.botId || target.bot_id || "",
    conversationId: target.conversationId || target.conversation_id || "",
    sessionId: target.sessionId || target.session_id || target.conversationId || target.conversation_id || "",
    originMessageId: target.originMessageId || "",
    trigger: legacyTriggerFromCoreSchedule(schedule),
    timezone: schedule.timezone || target.timezone || "UTC",
    prompt: job.instructions || target.prompt || "",
    fireMode: target.fireMode || job.kind || "agent",
    deliveryText: target.deliveryText || "",
    status: job.status || "active",
    runs: Array.isArray(target.runs) ? target.runs : [],
    nextFireAt: job.nextRunAt ?? null,
    createdAt: target.createdAt || null,
    updatedAt: target.updatedAt || null,
    coreJob: job
  };
}

function buildCoreTaskTarget(input = {}) {
  const payload = input && typeof input === "object" ? input : {};
  return {
    botId: payload.botId || payload.bot_id || "",
    conversationId: payload.conversationId || payload.conversation_id || payload.sessionId || "",
    sessionId: payload.sessionId || payload.conversationId || "",
    title: payload.title || payload.name || "未命名任务",
    timezone: payload.timezone || payload.scheduleIntent?.timezone || "UTC",
    fireMode: payload.fireMode || payload.kind || "agent",
    deliveryText: payload.deliveryText || "",
    originMessageId: payload.originMessageId || ""
  };
}

function buildCoreTaskJobRequest(input = {}) {
  const payload = input && typeof input === "object" ? input : {};
  const request = {
    kind: payload.fireMode || payload.kind || "agent",
    target: buildCoreTaskTarget(payload),
    instructions: payload.prompt || payload.instructions || payload.deliveryText || ""
  };
  if (payload.scheduleIntent && typeof payload.scheduleIntent === "object") {
    request.scheduleIntent = payload.scheduleIntent;
  } else if (typeof payload.timeExpression === "string" && payload.timeExpression.trim()) {
    request.scheduleIntent = {
      kind: "expression",
      timeExpression: payload.timeExpression,
      timezone: payload.timezone || "UTC"
    };
  } else if (Object.prototype.hasOwnProperty.call(payload, "schedule")) {
    request.schedule = payload.schedule;
  } else if (Object.prototype.hasOwnProperty.call(payload, "trigger")) {
    request.schedule = payload.trigger;
  }
  return {
    ...request
  };
}

function buildCoreTaskJobUpdate(partial = {}) {
  const input = partial && typeof partial === "object" ? partial : {};
  const patch = {};
  if (input.scheduleIntent && typeof input.scheduleIntent === "object") {
    patch.scheduleIntent = input.scheduleIntent;
  } else if (Object.prototype.hasOwnProperty.call(input, "schedule")) {
    patch.schedule = input.schedule;
  } else if (Object.prototype.hasOwnProperty.call(input, "trigger")) {
    patch.schedule = input.trigger;
  }
  if (Object.prototype.hasOwnProperty.call(input, "prompt") || Object.prototype.hasOwnProperty.call(input, "instructions")) {
    patch.instructions = input.prompt || input.instructions || "";
  }
  if (Object.prototype.hasOwnProperty.call(input, "status")) patch.status = input.status;
  if ((input.botId || input.bot_id) && (input.conversationId || input.conversation_id || input.sessionId)) {
    patch.target = buildCoreTaskTarget(input);
  }
  return patch;
}

async function listCoreTaskJobs() {
  const response = await miaCoreGet("/api/tasks/jobs");
  return (Array.isArray(response?.jobs) ? response.jobs : []).map(legacyTaskFromCoreJob);
}

async function getCoreTaskJob(id) {
  const response = await miaCoreGet(`/api/tasks/jobs/${encodeURIComponent(id)}`);
  return legacyTaskFromCoreJob(response?.job || {});
}

async function createCoreTaskJob(input) {
  const response = await miaCorePost("/api/tasks/jobs", buildCoreTaskJobRequest(input));
  return legacyTaskFromCoreJob(response?.job || {});
}

async function updateCoreTaskJob(id, partial) {
  const response = await miaCorePatch(`/api/tasks/jobs/${encodeURIComponent(id)}`, buildCoreTaskJobUpdate(partial));
  return legacyTaskFromCoreJob(response?.job || {});
}

contextBridge.exposeInMainWorld("__miaCorePort", Number(miaCoreStartupState.port || 0));
contextBridge.exposeInMainWorld("__miaCoreStartupFailed", Boolean(miaCoreStartupState.failed));
contextBridge.exposeInMainWorld("__miaCoreVersion", miaCoreStartupState.version || null);
contextBridge.exposeInMainWorld("__miaCoreUserId", miaCoreStartupState.userId || "");

contextBridge.exposeInMainWorld("mia", {
  miaCoreRequest: (method, route, body) => ipcRenderer.invoke(IpcChannel.MiaCoreHttpRequest, { method, route, body }),
  initializeRuntime: () => ipcRenderer.invoke(IpcChannel.RuntimeInitialize),
  notifyFirstPaint: () => ipcRenderer.send(IpcChannel.UiFirstPaint),
  runtimeStatus: () => ipcRenderer.invoke(IpcChannel.RuntimeStatus),
  startupBackgroundServices: () => ipcRenderer.invoke(IpcChannel.StartupBackgroundServices),
  daemonStatus: () => ipcRenderer.invoke(IpcChannel.DaemonStatus),
  startDaemon: () => ipcRenderer.invoke(IpcChannel.DaemonStart),
  stopDaemon: () => ipcRenderer.invoke(IpcChannel.DaemonStop),
  saveDaemonSettings: (settings) => ipcRenderer.invoke(IpcChannel.DaemonSettingsSave, settings),
  cloudStatus: () => miaCoreGet("/api/cloud/status"),
  cloudModelBalance: () => ipcRenderer.invoke(IpcChannel.CloudModelBalance),
  cloudLogin: (payload) => ipcRenderer.invoke(IpcChannel.CloudLogin, payload),
  cloudLogout: () => ipcRenderer.invoke(IpcChannel.CloudLogout),
  checkForUpdates: () => ipcRenderer.invoke(IpcChannel.UpdateCheck),
  onUpdateEvent: (callback) => {
    const handler = (_event, payload) => { try { callback(payload); } catch { /* ignore */ } };
    ipcRenderer.on(IpcChannel.UpdateEvent, handler);
    return () => ipcRenderer.removeListener(IpcChannel.UpdateEvent, handler);
  },
  onCloudEvent: (handler) => {
    const listener = (_event, envelope) => { try { handler(envelope); } catch { /* ignore */ } };
    ipcRenderer.on(IpcChannel.CloudEvent, listener);
    return () => ipcRenderer.removeListener(IpcChannel.CloudEvent, listener);
  },
  showDesktopNotification: (payload) => ipcRenderer.invoke(IpcChannel.DesktopNotificationShow, payload),
  onDesktopNotificationClick: (handler) => {
    const listener = (_event, payload) => { try { handler(payload); } catch { /* ignore */ } };
    ipcRenderer.on(IpcChannel.DesktopNotificationClick, listener);
    return () => ipcRenderer.removeListener(IpcChannel.DesktopNotificationClick, listener);
  },
  openExternal: (url) => ipcRenderer.invoke(IpcChannel.UtilOpenExternal, url),
  openLocalFile: (target) => ipcRenderer.invoke(IpcChannel.UtilOpenLocalFile, target),
  revealLocalFile: (target) => ipcRenderer.invoke(IpcChannel.UtilRevealLocalFile, target),
  readClipboardText: () => {
    try {
      return clipboard.readText();
    } catch {
      return "";
    }
  },
  onPathPasteText: (handler) => {
    const listener = (_event, payload) => { try { handler(payload); } catch { /* ignore */ } };
    ipcRenderer.on(IpcChannel.ComposerPathPaste, listener);
    return () => ipcRenderer.removeListener(IpcChannel.ComposerPathPaste, listener);
  },
  loadStatusBadgeAsset: (assetId) => ipcRenderer.invoke(IpcChannel.StatusBadgeAssetLoad, assetId),
  installEngine: (engineId) => ipcRenderer.invoke(IpcChannel.EngineInstall, engineId),
  onEngineInstallProgress: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on(IpcChannel.EngineInstallProgress, handler);
    return () => ipcRenderer.removeListener(IpcChannel.EngineInstallProgress, handler);
  },
  getAgentWorkspace: () => ipcRenderer.invoke(IpcChannel.EngineWorkspaceGet),
  pickAgentWorkspace: () => ipcRenderer.invoke(IpcChannel.EngineWorkspacePick),
  scanAgents: () => ipcRenderer.invoke(IpcChannel.EngineScan),
  onAgentScanProgress: (callback) => {
    const handler = (_event, payload) => { try { callback(payload); } catch { /* ignore */ } };
    ipcRenderer.on(IpcChannel.EngineScanProgress, handler);
    return () => ipcRenderer.removeListener(IpcChannel.EngineScanProgress, handler);
  },
  onboardingComplete: () => ipcRenderer.invoke(IpcChannel.OnboardingComplete),
  repairEngine: () => ipcRenderer.invoke(IpcChannel.EngineRepair),
  uninstallStandaloneEngine: () => ipcRenderer.invoke(IpcChannel.EngineUninstallStandalone),
  onEnginesChanged: (handler) => {
    const listener = () => { try { handler(); } catch { /* ignore */ } };
    ipcRenderer.on(IpcChannel.RuntimeEnginesChanged, listener);
    return () => ipcRenderer.removeListener(IpcChannel.RuntimeEnginesChanged, listener);
  },
  startCodexOAuth: () => ipcRenderer.invoke(IpcChannel.AuthCodexStart),
  cancelCodexOAuth: () => ipcRenderer.invoke(IpcChannel.AuthCodexCancel),
  startProviderOAuth: (provider) => ipcRenderer.invoke(IpcChannel.AuthProviderStart, provider),
  cancelProviderOAuth: () => ipcRenderer.invoke(IpcChannel.AuthProviderCancel),
  sendChat: (payload) => ipcRenderer.invoke(IpcChannel.ChatSend, payload),
  sendChatStateless: (payload) => runCoreConversationUtilityTurn(payload),
  stopChat: (payload) => cancelCoreConversationTurn(payload),
  respondChatPermission: (payload) => ipcRenderer.invoke(IpcChannel.ChatPermissionRespond, payload),
  listChatPermissions: (payload) => ipcRenderer.invoke(IpcChannel.ChatPermissionList, payload),
  saveAttachment: (payload) => ipcRenderer.invoke(IpcChannel.ChatAttachmentSave, payload),
  fetchFileAttachment: (payload) => ipcRenderer.invoke(IpcChannel.ChatFileFetch, payload),
  filePathForFile: (file) => {
    try {
      return webUtils?.getPathForFile?.(file) || file?.path || "";
    } catch {
      return file?.path || "";
    }
  },
  loadSlashCommands: () => ipcRenderer.invoke(IpcChannel.CommandsSlash),
  loadAgentCommands: (payload) => ipcRenderer.invoke(IpcChannel.CommandsAgentList, payload),
  executeAgentCommand: (payload) => ipcRenderer.invoke(IpcChannel.CommandsAgentExecute, payload),
  memory: {
    list: (payload) => ipcRenderer.invoke(IpcChannel.MemoryList, payload),
    listAll: (payload) => ipcRenderer.invoke(IpcChannel.MemoryListAll, payload),
    remember: (payload) => ipcRenderer.invoke(IpcChannel.MemoryRemember, payload),
    update: (payload) => ipcRenderer.invoke(IpcChannel.MemoryUpdate, payload),
    forget: (payload) => ipcRenderer.invoke(IpcChannel.MemoryForget, payload),
    delete: (payload) => ipcRenderer.invoke(IpcChannel.MemoryDelete, payload)
  },
  saveMemorySettings: (settings) => ipcRenderer.invoke(IpcChannel.MemorySettingsSave, settings),
  generateConversationTitle: (payload) => ipcRenderer.invoke(IpcChannel.ConversationTitleGenerate, payload),
  loadModelCatalog: () => ipcRenderer.invoke(IpcChannel.ModelCatalog),
  loadCodexModels: () => ipcRenderer.invoke(IpcChannel.CodexListModels),
  loadEngineCapabilities: () => ipcRenderer.invoke(IpcChannel.EngineCapabilities),
  loadSkills: () => ipcRenderer.invoke(IpcChannel.SkillsList),
  showEditContextMenu: (point) => ipcRenderer.invoke(IpcChannel.EditContextMenu, point),
  installPlugin: (extensionId) => ipcRenderer.invoke(IpcChannel.PluginsInstall, extensionId),
  readSkill: (skillId) => ipcRenderer.invoke(IpcChannel.SkillsRead, skillId),
  deleteSkill: (skillId) => ipcRenderer.invoke(IpcChannel.SkillsDelete, skillId),
  openSkillDirectory: (skillId) => ipcRenderer.invoke(IpcChannel.SkillsOpenDirectory, skillId),
  marketSkills: (params) => ipcRenderer.invoke(IpcChannel.SkillsMarketList, params),
  readMarketSkill: (skillId) => ipcRenderer.invoke(IpcChannel.SkillsMarketRead, skillId),
  installMarketSkill: (skillId) => ipcRenderer.invoke(IpcChannel.SkillsMarketInstall, skillId),
  publishSkill: (payload) => ipcRenderer.invoke(IpcChannel.SkillsPublish, payload),
  reportMarketSkill: (payload) => ipcRenderer.invoke(IpcChannel.SkillsReport, payload),
  mcp: {
    list: () => mcpCoreOk(miaCoreGet("/api/mcp/servers")),
    save: (input) => {
      const id = String(input?.id || "").trim();
      return mcpCoreOk(id
        ? miaCorePatch(`/api/mcp/servers/${encodeURIComponent(id)}`, input || {})
        : miaCorePost("/api/mcp/servers", input || {}));
    },
    delete: (id) => mcpCoreOk(miaCoreDelete(`/api/mcp/servers/${encodeURIComponent(id)}`)),
    setEnabled: (id, enabled) => mcpCoreOk(miaCorePatch(`/api/mcp/servers/${encodeURIComponent(id)}`, { enabled: Boolean(enabled) })),
    test: (input) => testCoreMcpServer(input),
    importJson: (input, options) => mcpCoreOk(miaCorePost("/api/mcp/servers/import", { input, options })),
    fetchMarketplace: () => mcpCoreOk(miaCoreGet("/api/mcp/marketplace")),
    installTemplate: (templateId, values) => mcpCoreOk(miaCorePost("/api/mcp/servers/install-template", { templateId, values })),
    runManagedAction: (id, action, values) => mcpCoreOk(miaCorePost(`/api/mcp/servers/${encodeURIComponent(id)}/managed-actions/${encodeURIComponent(action)}`, values || {})),
    sync: () => mcpCoreOk(miaCorePost("/api/mcp/sync", {})),
    refreshBridge: () => mcpCoreOk(miaCorePost("/api/mcp/bridge/refresh", {})),
    removeFromAgents: (recordsOrIds) => mcpCoreOk(miaCorePost("/api/mcp/agent-configs/remove", { recordsOrIds })),
    listTools: () => mcpCoreOk(miaCoreGet("/api/mcp/tools")),
    getAgentConfigs: () => mcpCoreOk(miaCoreGet("/api/mcp/agent-configs")),
    importAgentConfig: (input) => mcpCoreOk(miaCorePost("/api/mcp/agent-configs/import", input || {})),
    oauth: {
      checkStatus: (input) => mcpCoreOk(miaCoreGet(`/api/mcp/oauth/${encodeURIComponent(mcpInputId(input))}/status`)),
      login: (input) => mcpCoreOk(miaCorePost(`/api/mcp/oauth/${encodeURIComponent(mcpInputId(input))}/login`, input || {})),
      logout: (input) => mcpCoreOk(miaCorePost(`/api/mcp/oauth/${encodeURIComponent(mcpInputId(input))}/logout`, {}))
    }
  },
  saveModel: (settings) => saveCoreModelSelection(settings),
  getSettingsRuntimeControlOptions: (input) => getCoreSettingsRuntimeControlOptions(input),
  saveAppearance: (settings) => ipcRenderer.invoke(IpcChannel.AppearanceSave, settings),
  saveProfile: (profile) => ipcRenderer.invoke(IpcChannel.ProfileSave, profile),
  loadPetJobs: () => ipcRenderer.invoke(IpcChannel.PetJobs),
  generateBotPet: (payload) => ipcRenderer.invoke(IpcChannel.PetGenerate, payload),
  placeBotPet: (key) => ipcRenderer.invoke(IpcChannel.PetPlace, key),
  recallBotPet: (key) => ipcRenderer.invoke(IpcChannel.PetRecall, key),
  tasks: {
    list: () => listCoreTaskJobs(),
    get: (id) => getCoreTaskJob(id),
    create: (input) => createCoreTaskJob(input),
    update: (id, partial) => updateCoreTaskJob(id, partial),
    delete: (id) => coreOk(miaCoreDelete(`/api/tasks/jobs/${encodeURIComponent(id)}`)),
    pause: (id) => updateCoreTaskJob(id, { status: "paused" }),
    resume: (id) => updateCoreTaskJob(id, { status: "active" }),
    runNow: (id) => miaCorePost(`/api/tasks/jobs/${encodeURIComponent(id)}/run`, {}),
    subscribe: (cb) => {
      const wrapped = (_e, envelope) => cb(envelope);
      ipcRenderer.on(IpcChannel.TasksEvent, wrapped);
      return () => ipcRenderer.removeListener(IpcChannel.TasksEvent, wrapped);
    }
  },
  conductor: {
    loadPrompts: () => ipcRenderer.invoke(IpcChannel.ConductorLoadPrompts),
  },
  social: {
    sendFriendRequest: (toUserId) => ipcRenderer.invoke(IpcChannel.SocialSendFriendRequest, toUserId),
    respondFriendRequest: (requestId, action) => ipcRenderer.invoke(IpcChannel.SocialRespondFriendRequest, requestId, action),
    cancelFriendRequest: (requestId) => ipcRenderer.invoke(IpcChannel.SocialCancelFriendRequest, requestId),
    listFriendRequests: (direction) => ipcRenderer.invoke(IpcChannel.SocialListFriendRequests, direction),
    listFriends: () => ipcRenderer.invoke(IpcChannel.SocialListFriends),
    removeFriend: (userId) => ipcRenderer.invoke(IpcChannel.SocialRemoveFriend, userId),
    listConversations: () => listConversationsCompat(),
    listBots: () => listBotsCompat(),
    getBotIdentity: (botId) => getBotIdentityCompat(botId),
    saveBotIdentity: (botId, body) => saveBotIdentityCompat(botId, body),
    deleteBot: (botId) => coreOk(miaCoreDelete(`/api/bots/${encodeURIComponent(botId)}`)),
    listPlatformModels: () => ipcRenderer.invoke(IpcChannel.SocialListPlatformModels),
    getConversation: (conversationId) => getConversationCompat(conversationId),
    listConversationMessages: (conversationId, sinceSeq, limit) => listConversationMessagesCompat(conversationId, sinceSeq, limit),
    searchConversationMessages: (query, limit) => ipcRenderer.invoke(IpcChannel.SocialSearchConversationMessages, query, limit),
    getCachedConversationMessages: (conversationId, limit) => ipcRenderer.invoke(IpcChannel.SocialGetCachedMessages, conversationId, limit),
    getCachedSocialBootstrap: (userId) => ipcRenderer.invoke(IpcChannel.SocialGetCachedBootstrap, userId),
    postConversationMessage: (conversationId, body) => postConversationMessageCompat(conversationId, body),
    respondRunApproval: (conversationId, runId, decision) => ipcRenderer.invoke(IpcChannel.SocialRespondRunApproval, conversationId, runId, decision),
    deleteConversationMessage: (conversationId, messageId) => ipcRenderer.invoke(IpcChannel.SocialDeleteConversationMessage, conversationId, messageId),
    myIdentity: () => ipcRenderer.invoke(IpcChannel.SocialMyIdentity),
    createConversation: (payload) => createConversationCompat(payload),
    ensureBotConversation: (botId, body) => ipcRenderer.invoke(IpcChannel.SocialEnsureBotConversation, botId, body),
    ensureBotSessionConversation: (sessionId, body) => ensureCoreBotSessionConversation(sessionId, body),
    getBotRuntime: (botId, runtimeKind) => getBotRuntimeCompat(botId, runtimeKind),
    saveBotRuntime: (botId, body) => saveBotRuntimeCompat(botId, body),
    getBotRuntimeTargetOptions: (input) => getCoreBotRuntimeTargetOptions(input),
    getBotRuntimeControlOptions: (input) => getCoreBotRuntimeControlOptions(input),
    getBotCapabilityOptions: (input) => getCoreBotCapabilityOptions(input),
    ensureStarterEngineBots: (input) => ensureCoreStarterEngineBots(input),
    listBridgeDevices: (options) => ipcRenderer.invoke(IpcChannel.SocialListBridgeDevices, options),
    updateConversation: (conversationId, patch) => ipcRenderer.invoke(IpcChannel.SocialUpdateConversation, conversationId, patch),
    deleteConversation: (conversationId) => deleteConversationCompat(conversationId),
    addConversationMember: (conversationId, member) => ipcRenderer.invoke(IpcChannel.SocialAddConversationMember, conversationId, member),
    removeConversationMember: (conversationId, member) => ipcRenderer.invoke(IpcChannel.SocialRemoveConversationMember, conversationId, member),
    settingsGet: () => ipcRenderer.invoke(IpcChannel.CloudSettingsGet),
    settingsPut: (settings) => ipcRenderer.invoke(IpcChannel.CloudSettingsPut, settings)
  },
  platform: process.platform,
  window: {
    close: () => ipcRenderer.invoke(IpcChannel.WindowClose),
    minimize: () => ipcRenderer.invoke(IpcChannel.WindowMinimize),
    maximize: () => ipcRenderer.invoke(IpcChannel.WindowMaximize),
    green: () => ipcRenderer.invoke(IpcChannel.WindowGreen),
    showMain: () => ipcRenderer.invoke(IpcChannel.WindowShowMain),
    onboarding: () => ipcRenderer.invoke(IpcChannel.WindowOnboarding),
    signedOutOnboarding: () => ipcRenderer.invoke(IpcChannel.WindowSignedOutOnboarding),
    setNativeControlsVisible: (visible) => ipcRenderer.invoke(IpcChannel.WindowNativeControlsVisible, Boolean(visible)),
    setNativeControlsLayout: (layout) => ipcRenderer.invoke(IpcChannel.WindowNativeControlsLayout, layout === "default" ? "default" : "rail"),
    setTitleBarTheme: (appearance) => ipcRenderer.invoke(IpcChannel.WindowTitleBarTheme, appearance || {}),
    state: () => ipcRenderer.invoke(IpcChannel.WindowState),
    onFocusState: (handler) => {
      const listener = (_e, focused) => handler(focused);
      ipcRenderer.on(IpcChannel.WindowFocusState, listener);
      return () => ipcRenderer.removeListener(IpcChannel.WindowFocusState, listener);
    },
    onFullscreen: (handler) => {
      const listener = (_e, fullscreen) => handler(fullscreen);
      ipcRenderer.on(IpcChannel.WindowFullscreen, listener);
      return () => ipcRenderer.removeListener(IpcChannel.WindowFullscreen, listener);
    },
    onMaximized: (handler) => {
      const listener = (_e, maximized) => handler(maximized);
      ipcRenderer.on(IpcChannel.WindowMaximized, listener);
      return () => ipcRenderer.removeListener(IpcChannel.WindowMaximized, listener);
    }
  }
});
