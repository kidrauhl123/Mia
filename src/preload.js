const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("aimashi", {
  initializeRuntime: () => ipcRenderer.invoke("runtime:initialize"),
  runtimeStatus: () => ipcRenderer.invoke("runtime:status"),
  daemonStatus: () => ipcRenderer.invoke("daemon:status"),
  daemonPairing: () => ipcRenderer.invoke("daemon:pairing"),
  startDaemon: () => ipcRenderer.invoke("daemon:start"),
  stopDaemon: () => ipcRenderer.invoke("daemon:stop"),
  saveDaemonSettings: (settings) => ipcRenderer.invoke("daemon:settings-save", settings),
  relayStatus: () => ipcRenderer.invoke("relay:status"),
  startRelay: () => ipcRenderer.invoke("relay:start"),
  stopRelay: () => ipcRenderer.invoke("relay:stop"),
  saveRelaySettings: (settings) => ipcRenderer.invoke("relay:settings-save", settings),
  installEngine: () => ipcRenderer.invoke("engine:install"),
  startEngine: () => ipcRenderer.invoke("engine:start"),
  stopEngine: () => ipcRenderer.invoke("engine:stop"),
  startCodexOAuth: () => ipcRenderer.invoke("auth:codex-start"),
  cancelCodexOAuth: () => ipcRenderer.invoke("auth:codex-cancel"),
  startProviderOAuth: (provider) => ipcRenderer.invoke("auth:provider-start", provider),
  cancelProviderOAuth: () => ipcRenderer.invoke("auth:provider-cancel"),
  sendChat: (payload) => ipcRenderer.invoke("chat:send", payload),
  stopChat: () => ipcRenderer.invoke("chat:stop"),
  saveAttachment: (payload) => ipcRenderer.invoke("chat:attachment-save", payload),
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
    ipcRenderer.on("chat:event", listener);
    return () => ipcRenderer.removeListener("chat:event", listener);
  },
  loadSlashCommands: () => ipcRenderer.invoke("commands:slash"),
  loadAgentCommands: (payload) => ipcRenderer.invoke("commands:agent-list", payload),
  executeAgentCommand: (payload) => ipcRenderer.invoke("commands:agent-execute", payload),
  loadChatSessions: () => ipcRenderer.invoke("chat:sessions-load"),
  saveChatSession: (payload) => ipcRenderer.invoke("chat:session-save", payload),
  saveChatReadState: (payload) => ipcRenderer.invoke("chat:read-state-save", payload),
  createChatSession: (payload) => ipcRenderer.invoke("chat:session-create", payload),
  renameChatSession: (payload) => ipcRenderer.invoke("chat:session-rename", payload),
  generateSessionTitle: (payload) => ipcRenderer.invoke("chat:title-generate", payload),
  loadModelCatalog: () => ipcRenderer.invoke("model:catalog"),
  loadSkills: () => ipcRenderer.invoke("skills:list"),
  readSkill: (skillId) => ipcRenderer.invoke("skills:read", skillId),
  deleteSkill: (skillId) => ipcRenderer.invoke("skills:delete", skillId),
  openSkillDirectory: (skillId) => ipcRenderer.invoke("skills:open-directory", skillId),
  saveModel: (settings) => ipcRenderer.invoke("model:save", settings),
  savePermissions: (settings) => ipcRenderer.invoke("permissions:save", settings),
  saveEffort: (settings) => ipcRenderer.invoke("effort:save", settings),
  saveAppearance: (settings) => ipcRenderer.invoke("appearance:save", settings),
  saveProfile: (profile) => ipcRenderer.invoke("profile:save", profile),
  loadFellowDetails: (key) => ipcRenderer.invoke("fellow:details", key),
  saveFellow: (fellow) => ipcRenderer.invoke("fellow:save", fellow),
  saveFellowEngine: (payload) => ipcRenderer.invoke("fellow:engine-save", payload),
  setFellowPinned: (payload) => ipcRenderer.invoke("fellow:pin", payload),
  deleteFellow: (payload) => ipcRenderer.invoke("fellow:delete", payload),
  savePersona: (persona) => ipcRenderer.invoke("persona:save", persona),
  loadPetJobs: () => ipcRenderer.invoke("pet:jobs"),
  generateFellowPet: (payload) => ipcRenderer.invoke("pet:generate", payload),
  placeFellowPet: (key) => ipcRenderer.invoke("pet:place", key),
  recallFellowPet: (key) => ipcRenderer.invoke("pet:recall", key)
});
