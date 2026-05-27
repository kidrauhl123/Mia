const { contextBridge, ipcRenderer, webUtils } = require("electron");
const { IpcChannel } = require("./shared/ipc-channels");

contextBridge.exposeInMainWorld("mia", {
  initializeRuntime: () => ipcRenderer.invoke(IpcChannel.RuntimeInitialize),
  notifyFirstPaint: () => ipcRenderer.send(IpcChannel.UiFirstPaint),
  runtimeStatus: () => ipcRenderer.invoke(IpcChannel.RuntimeStatus),
  daemonStatus: () => ipcRenderer.invoke(IpcChannel.DaemonStatus),
  daemonPairing: () => ipcRenderer.invoke(IpcChannel.DaemonPairing),
  startDaemon: () => ipcRenderer.invoke(IpcChannel.DaemonStart),
  stopDaemon: () => ipcRenderer.invoke(IpcChannel.DaemonStop),
  saveDaemonSettings: (settings) => ipcRenderer.invoke(IpcChannel.DaemonSettingsSave, settings),
  relayStatus: () => ipcRenderer.invoke(IpcChannel.RelayStatus),
  startRelay: () => ipcRenderer.invoke(IpcChannel.RelayStart),
  stopRelay: () => ipcRenderer.invoke(IpcChannel.RelayStop),
  saveRelaySettings: (settings) => ipcRenderer.invoke(IpcChannel.RelaySettingsSave, settings),
  cloudStatus: () => ipcRenderer.invoke(IpcChannel.CloudStatus),
  cloudLogin: (payload) => ipcRenderer.invoke(IpcChannel.CloudLogin, payload),
  cloudSync: () => ipcRenderer.invoke(IpcChannel.CloudSync),
  cloudLogout: () => ipcRenderer.invoke(IpcChannel.CloudLogout),
  onCloudEvent: (handler) => {
    const listener = (_event, envelope) => { try { handler(envelope); } catch { /* ignore */ } };
    ipcRenderer.on(IpcChannel.CloudEvent, listener);
    return () => ipcRenderer.removeListener(IpcChannel.CloudEvent, listener);
  },
  qrSvg: (text) => ipcRenderer.invoke(IpcChannel.UtilQrSvg, text),
  openExternal: (url) => ipcRenderer.invoke(IpcChannel.UtilOpenExternal, url),
  installEngine: () => ipcRenderer.invoke(IpcChannel.EngineInstall),
  startEngine: () => ipcRenderer.invoke(IpcChannel.EngineStart),
  stopEngine: () => ipcRenderer.invoke(IpcChannel.EngineStop),
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
  stopChat: () => ipcRenderer.invoke(IpcChannel.ChatStop),
  saveAttachment: (payload) => ipcRenderer.invoke(IpcChannel.ChatAttachmentSave, payload),
  fetchFileAttachment: (payload) => ipcRenderer.invoke(IpcChannel.ChatFileFetch, payload),
  filePathForFile: (file) => {
    try {
      return webUtils?.getPathForFile?.(file) || file?.path || "";
    } catch {
      return file?.path || "";
    }
  },
  onChatEvent: (callback) => {
    const listener = (_event, envelope) => {
      try { callback(envelope); } catch { /* renderer handler error swallowed */ }
    };
    ipcRenderer.on(IpcChannel.ChatEvent, listener);
    return () => ipcRenderer.removeListener(IpcChannel.ChatEvent, listener);
  },
  loadSlashCommands: () => ipcRenderer.invoke(IpcChannel.CommandsSlash),
  loadAgentCommands: (payload) => ipcRenderer.invoke(IpcChannel.CommandsAgentList, payload),
  executeAgentCommand: (payload) => ipcRenderer.invoke(IpcChannel.CommandsAgentExecute, payload),
  loadChatSessions: () => ipcRenderer.invoke(IpcChannel.ChatSessionsLoad),
  saveChatSession: (payload) => ipcRenderer.invoke(IpcChannel.ChatSessionSave, payload),
  saveChatReadState: (payload) => ipcRenderer.invoke(IpcChannel.ChatReadStateSave, payload),
  createChatSession: (payload) => ipcRenderer.invoke(IpcChannel.ChatSessionCreate, payload),
  renameChatSession: (payload) => ipcRenderer.invoke(IpcChannel.ChatSessionRename, payload),
  generateSessionTitle: (payload) => ipcRenderer.invoke(IpcChannel.ChatTitleGenerate, payload),
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
  installMarketSkill: (skillId) => ipcRenderer.invoke(IpcChannel.SkillsMarketInstall, skillId),
  publishSkill: (payload) => ipcRenderer.invoke(IpcChannel.SkillsPublish, payload),
  reportMarketSkill: (payload) => ipcRenderer.invoke(IpcChannel.SkillsReport, payload),
  saveModel: (settings) => ipcRenderer.invoke(IpcChannel.ModelSave, settings),
  savePermissions: (settings) => ipcRenderer.invoke(IpcChannel.PermissionsSave, settings),
  saveEffort: (settings) => ipcRenderer.invoke(IpcChannel.EffortSave, settings),
  saveAppearance: (settings) => ipcRenderer.invoke(IpcChannel.AppearanceSave, settings),
  saveProfile: (profile) => ipcRenderer.invoke(IpcChannel.ProfileSave, profile),
  loadFellowDetails: (key) => ipcRenderer.invoke(IpcChannel.FellowDetails, key),
  saveFellow: (fellow) => ipcRenderer.invoke(IpcChannel.FellowSave, fellow),
  saveFellowEngine: (payload) => ipcRenderer.invoke(IpcChannel.FellowEngineSave, payload),
  setFellowPinned: (payload) => ipcRenderer.invoke(IpcChannel.FellowPin, payload),
  setFellowMuted: (payload) => ipcRenderer.invoke(IpcChannel.FellowMute, payload),
  deleteFellow: (payload) => ipcRenderer.invoke(IpcChannel.FellowDelete, payload),
  savePersona: (persona) => ipcRenderer.invoke(IpcChannel.PersonaSave, persona),
  loadPetJobs: () => ipcRenderer.invoke(IpcChannel.PetJobs),
  generateFellowPet: (payload) => ipcRenderer.invoke(IpcChannel.PetGenerate, payload),
  placeFellowPet: (key) => ipcRenderer.invoke(IpcChannel.PetPlace, key),
  recallFellowPet: (key) => ipcRenderer.invoke(IpcChannel.PetRecall, key),
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
    sendFriendRequest: (toUsername) => ipcRenderer.invoke(IpcChannel.SocialSendFriendRequest, toUsername),
    respondFriendRequest: (requestId, action) => ipcRenderer.invoke(IpcChannel.SocialRespondFriendRequest, requestId, action),
    cancelFriendRequest: (requestId) => ipcRenderer.invoke(IpcChannel.SocialCancelFriendRequest, requestId),
    listFriendRequests: (direction) => ipcRenderer.invoke(IpcChannel.SocialListFriendRequests, direction),
    listFriends: () => ipcRenderer.invoke(IpcChannel.SocialListFriends),
    removeFriend: (userId) => ipcRenderer.invoke(IpcChannel.SocialRemoveFriend, userId),
    listRooms: () => ipcRenderer.invoke(IpcChannel.SocialListRooms),
    listFellows: () => ipcRenderer.invoke(IpcChannel.SocialListFellows),
    saveFellowIdentity: (fellowId, body) => ipcRenderer.invoke(IpcChannel.SocialSaveFellowIdentity, fellowId, body),
    deleteFellow: (fellowId) => ipcRenderer.invoke(IpcChannel.SocialDeleteFellow, fellowId),
    listPlatformModels: () => ipcRenderer.invoke(IpcChannel.SocialListPlatformModels),
    getRoom: (roomId) => ipcRenderer.invoke(IpcChannel.SocialGetRoom, roomId),
    listRoomMessages: (roomId, sinceSeq, limit) => ipcRenderer.invoke(IpcChannel.SocialListRoomMessages, roomId, sinceSeq, limit),
    postRoomMessage: (roomId, body) => ipcRenderer.invoke(IpcChannel.SocialPostRoomMessage, roomId, body),
    deleteRoomMessage: (roomId, messageId) => ipcRenderer.invoke(IpcChannel.SocialDeleteRoomMessage, roomId, messageId),
    myUsername: () => ipcRenderer.invoke(IpcChannel.SocialMyUsername),
    createRoom: (payload) => ipcRenderer.invoke(IpcChannel.SocialCreateRoom, payload),
    ensureFellowRoom: (fellowId, body) => ipcRenderer.invoke(IpcChannel.SocialEnsureFellowRoom, fellowId, body),
    ensureFellowSessionRoom: (sessionId, body) => ipcRenderer.invoke(IpcChannel.SocialEnsureFellowSessionRoom, sessionId, body),
    getFellowRuntime: (fellowId, runtimeKind) => ipcRenderer.invoke(IpcChannel.SocialGetFellowRuntime, fellowId, runtimeKind),
    saveFellowRuntime: (fellowId, body) => ipcRenderer.invoke(IpcChannel.SocialSaveFellowRuntime, fellowId, body),
    updateRoom: (roomId, patch) => ipcRenderer.invoke(IpcChannel.SocialUpdateRoom, roomId, patch),
    deleteRoom: (roomId) => ipcRenderer.invoke(IpcChannel.SocialDeleteRoom, roomId),
    addRoomMember: (roomId, member) => ipcRenderer.invoke(IpcChannel.SocialAddRoomMember, roomId, member),
    removeRoomMember: (roomId, member) => ipcRenderer.invoke(IpcChannel.SocialRemoveRoomMember, roomId, member),
    settingsGet: () => ipcRenderer.invoke(IpcChannel.CloudSettingsGet),
    settingsPut: (settings) => ipcRenderer.invoke(IpcChannel.CloudSettingsPut, settings)
  },
  platform: process.platform,
  window: {
    close: () => ipcRenderer.invoke(IpcChannel.WindowClose),
    minimize: () => ipcRenderer.invoke(IpcChannel.WindowMinimize),
    green: () => ipcRenderer.invoke(IpcChannel.WindowGreen),
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
    }
  }
});
