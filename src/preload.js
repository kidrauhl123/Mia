const { contextBridge, ipcRenderer, webUtils, clipboard } = require("electron");
const { IpcChannel } = require("./shared/ipc-channels");

contextBridge.exposeInMainWorld("mia", {
  initializeRuntime: () => ipcRenderer.invoke(IpcChannel.RuntimeInitialize),
  notifyFirstPaint: () => ipcRenderer.send(IpcChannel.UiFirstPaint),
  runtimeStatus: () => ipcRenderer.invoke(IpcChannel.RuntimeStatus),
  startupBackgroundServices: () => ipcRenderer.invoke(IpcChannel.StartupBackgroundServices),
  daemonStatus: () => ipcRenderer.invoke(IpcChannel.DaemonStatus),
  startDaemon: () => ipcRenderer.invoke(IpcChannel.DaemonStart),
  stopDaemon: () => ipcRenderer.invoke(IpcChannel.DaemonStop),
  saveDaemonSettings: (settings) => ipcRenderer.invoke(IpcChannel.DaemonSettingsSave, settings),
  cloudStatus: () => ipcRenderer.invoke(IpcChannel.CloudStatus),
  cloudLogin: (payload) => ipcRenderer.invoke(IpcChannel.CloudLogin, payload),
  cloudSync: () => ipcRenderer.invoke(IpcChannel.CloudSync),
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
  sendChatStateless: (payload) => ipcRenderer.invoke(IpcChannel.ChatSendStateless, payload),
  stopChat: (payload) => ipcRenderer.invoke(IpcChannel.ChatStop, payload),
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
    list: () => ipcRenderer.invoke(IpcChannel.McpList),
    save: (input) => ipcRenderer.invoke(IpcChannel.McpSave, input),
    delete: (id) => ipcRenderer.invoke(IpcChannel.McpDelete, id),
    setEnabled: (id, enabled) => ipcRenderer.invoke(IpcChannel.McpSetEnabled, id, enabled),
    test: (input) => ipcRenderer.invoke(IpcChannel.McpTest, input),
    importJson: (input, options) => ipcRenderer.invoke(IpcChannel.McpImportJson, input, options),
    fetchMarketplace: () => ipcRenderer.invoke(IpcChannel.McpFetchMarketplace),
    installTemplate: (templateId, values) => ipcRenderer.invoke(IpcChannel.McpInstallTemplate, templateId, values),
    runManagedAction: (id, action, values) => ipcRenderer.invoke(IpcChannel.McpRunManagedAction, id, action, values),
    sync: () => ipcRenderer.invoke(IpcChannel.McpSync),
    refreshBridge: () => ipcRenderer.invoke(IpcChannel.McpRefreshBridge),
    removeFromAgents: (recordsOrIds) => ipcRenderer.invoke(IpcChannel.McpRemoveFromAgents, recordsOrIds),
    listTools: () => ipcRenderer.invoke(IpcChannel.McpListTools),
    getAgentConfigs: () => ipcRenderer.invoke(IpcChannel.McpAgentConfigs),
    importAgentConfig: (input) => ipcRenderer.invoke(IpcChannel.McpImportAgentConfig, input),
    oauth: {
      checkStatus: (input) => ipcRenderer.invoke(IpcChannel.McpOauthCheckStatus, input),
      login: (input) => ipcRenderer.invoke(IpcChannel.McpOauthLogin, input),
      logout: (input) => ipcRenderer.invoke(IpcChannel.McpOauthLogout, input)
    }
  },
  saveModel: (settings) => ipcRenderer.invoke(IpcChannel.ModelSave, settings),
  savePermissions: (settings) => ipcRenderer.invoke(IpcChannel.PermissionsSave, settings),
  saveEffort: (settings) => ipcRenderer.invoke(IpcChannel.EffortSave, settings),
  saveAppearance: (settings) => ipcRenderer.invoke(IpcChannel.AppearanceSave, settings),
  saveProfile: (profile) => ipcRenderer.invoke(IpcChannel.ProfileSave, profile),
  loadPetJobs: () => ipcRenderer.invoke(IpcChannel.PetJobs),
  generateBotPet: (payload) => ipcRenderer.invoke(IpcChannel.PetGenerate, payload),
  placeBotPet: (key) => ipcRenderer.invoke(IpcChannel.PetPlace, key),
  recallBotPet: (key) => ipcRenderer.invoke(IpcChannel.PetRecall, key),
  tasks: {
    list: () => ipcRenderer.invoke(IpcChannel.TasksList),
    get: (id) => ipcRenderer.invoke(IpcChannel.TasksGet, id),
    create: (input) => ipcRenderer.invoke(IpcChannel.TasksCreate, input),
    update: (id, partial) => ipcRenderer.invoke(IpcChannel.TasksUpdate, id, partial),
    delete: (id) => ipcRenderer.invoke(IpcChannel.TasksDelete, id),
    pause: (id) => ipcRenderer.invoke(IpcChannel.TasksPause, id),
    resume: (id) => ipcRenderer.invoke(IpcChannel.TasksResume, id),
    runNow: (id) => ipcRenderer.invoke(IpcChannel.TasksRunNow, id),
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
    listConversations: () => ipcRenderer.invoke(IpcChannel.SocialListConversations),
    listBots: () => ipcRenderer.invoke(IpcChannel.SocialListBots),
    getBotIdentity: (botId) => ipcRenderer.invoke(IpcChannel.SocialGetBotIdentity, botId),
    saveBotIdentity: (botId, body) => ipcRenderer.invoke(IpcChannel.SocialSaveBotIdentity, botId, body),
    deleteBot: (botId) => ipcRenderer.invoke(IpcChannel.SocialDeleteBot, botId),
    listPlatformModels: () => ipcRenderer.invoke(IpcChannel.SocialListPlatformModels),
    getConversation: (conversationId) => ipcRenderer.invoke(IpcChannel.SocialGetConversation, conversationId),
    listConversationMessages: (conversationId, sinceSeq, limit) => ipcRenderer.invoke(IpcChannel.SocialListConversationMessages, conversationId, sinceSeq, limit),
    searchConversationMessages: (query, limit) => ipcRenderer.invoke(IpcChannel.SocialSearchConversationMessages, query, limit),
    getCachedConversationMessages: (conversationId, limit) => ipcRenderer.invoke(IpcChannel.SocialGetCachedMessages, conversationId, limit),
    getCachedSocialBootstrap: (userId) => ipcRenderer.invoke(IpcChannel.SocialGetCachedBootstrap, userId),
    postConversationMessage: (conversationId, body) => ipcRenderer.invoke(IpcChannel.SocialPostConversationMessage, conversationId, body),
    respondRunApproval: (conversationId, runId, decision) => ipcRenderer.invoke(IpcChannel.SocialRespondRunApproval, conversationId, runId, decision),
    deleteConversationMessage: (conversationId, messageId) => ipcRenderer.invoke(IpcChannel.SocialDeleteConversationMessage, conversationId, messageId),
    myIdentity: () => ipcRenderer.invoke(IpcChannel.SocialMyIdentity),
    createConversation: (payload) => ipcRenderer.invoke(IpcChannel.SocialCreateConversation, payload),
    ensureBotConversation: (botId, body) => ipcRenderer.invoke(IpcChannel.SocialEnsureBotConversation, botId, body),
    ensureBotSessionConversation: (sessionId, body) => ipcRenderer.invoke(IpcChannel.SocialEnsureBotSessionConversation, sessionId, body),
    getBotRuntime: (botId, runtimeKind) => ipcRenderer.invoke(IpcChannel.SocialGetBotRuntime, botId, runtimeKind),
    saveBotRuntime: (botId, body) => ipcRenderer.invoke(IpcChannel.SocialSaveBotRuntime, botId, body),
    listBridgeDevices: (options) => ipcRenderer.invoke(IpcChannel.SocialListBridgeDevices, options),
    updateConversation: (conversationId, patch) => ipcRenderer.invoke(IpcChannel.SocialUpdateConversation, conversationId, patch),
    deleteConversation: (conversationId) => ipcRenderer.invoke(IpcChannel.SocialDeleteConversation, conversationId),
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
